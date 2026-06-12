/**
 * Orchestrator — drives the full rebuild pipeline.
 *
 * Sequence:
 *   scratch + disk guard → clone/copy → run dir setup → Gemini client →
 *   state (new or resumed) → Stage 0 (map) → brand/constraints pin gate →
 *   Stage 0.5 (boot) → per-run branch (pr mode) → per-page fan-out with a
 *   concurrency pool (DAG: {audit, (ux→design), compliance} → code → verify) →
 *   commit + PR (pr mode) → test scaffold → manifest. Scratch is ALWAYS
 *   cleaned in a finally. Gemini alerts are drained into the manifest.
 *
 * Checkpoints `RunState` after every agent so a run is resumable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';

import { GeminiClient } from './gemini';
import { cloneRepo, createRunBranch, commitAll, openPr, getChangedFiles, postPrComment } from './git';
import { prepareScratch, cleanupScratch, checkDisk } from './scratch';
import { newRunState, loadState, saveState, loadApprovals } from './state';
import { writeManifest } from './manifest';
import { writeProposedChanges } from './proposed-changes';
import { loadBrand, loadConstraints } from './config';

import { runStage0 } from './stages/stage0-map';
import { runBootGate } from './stages/stage0_5-boot';
import { runTestScaffold } from './stages/final-scaffold';

import { runAudit } from './agents/agent1-audit';
import { runUx } from './agents/agent2-ux';
import { runDesign } from './agents/agent3-design';
import { runCode } from './agents/agent4-code';
import { runVerify } from './agents/agent5-verify';
import { runCompliance } from './agents/agent6-compliance';

import { decorateAllFindings } from './findings/decorate';
import { loadTelemetrySignals } from './findings/telemetry-signals';
import { filterPagesByRoutes } from './route-filter';

import type {
  PipelineConfig,
  RunManifest,
  RunState,
  PageState,
  PageScope,
  ScopeDoc,
  BootResult,
  BrandSpec,
  ConstraintsSpec,
  AgentContext,
  AgentName,
  StepStatus,
  PageManifestEntry,
  TestUser,
  VerifyResult,
  PageOutcome,
  AuditResult,
  ComplianceResult,
} from './types';

/* ───────────────────────────── helpers ───────────────────────────── */

/** Recursively copy a directory tree (used for local-path targets). */
function copyDirInto(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip VCS/build/dependency dirs — they are large and not needed.
    if (entry.isDirectory() && ['.git', 'node_modules', '.next', 'dist'].includes(entry.name)) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirInto(from, to);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy the link target's contents conservatively.
      try {
        fs.copyFileSync(from, to);
      } catch {
        /* ignore unreadable symlink */
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** mkdir -p convenience. */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** A run-stamp suitable for branch names: reframe/<stamp>. */
function runStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Minimal async concurrency pool — N workers pull from a shared queue.
 * No external dependency. A worker throwing does NOT abort the pool;
 * `worker` is expected to be pre-wrapped so it never rejects.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => next()));
}

/**
 * Reload a completed agent's result JSON from a page dir. Used on resume: a
 * `done` agent is not re-run, but its result must still be loaded so the
 * downstream agents (code, verify) and the proposed-changes report see it.
 */
function loadAgentResult<T>(pageDir: string, agent: AgentName): T | undefined {
  try {
    const file = path.join(pageDir, `${agent}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Empty per-agent status map for a fresh page. */
function freshAgentMap(): Record<AgentName, StepStatus> {
  return {
    audit: 'pending',
    ux: 'pending',
    design: 'pending',
    code: 'pending',
    verify: 'pending',
    compliance: 'pending',
  };
}

/**
 * Spot the things that mean "this page is on fire" regardless of which
 * gaps the LLM-driven agents happened to surface. Used by the review-mode
 * pass/fail gate so a screen that crashed in the browser or got 5xx from
 * its own API can never report PASS.
 *
 * Looks at the AuditResult.consoleErrors stream populated by the browser
 * driver — entries are prefixed `[pageerror]` (uncaught JS) or
 * `[console.error]` (logged error). We treat the JS crash + any 5xx
 * response as load-bearing; everything else is left to the audit gaps.
 *
 * Also returns true if any gap was severity:'critical' — those should
 * never coexist with a pass.
 */
function detectSmokingGuns(audit: AuditResult): string[] {
  const guns: string[] = [];
  for (const line of audit.consoleErrors ?? []) {
    if (line.startsWith('[pageerror]')) {
      guns.push(line);
      continue;
    }
    // 5xx response — Playwright surfaces these as console.error
    // ("Failed to load resource: the server responded with a status
    // of 500 ..."). Match 5XX explicitly so transient 4xx noise from
    // analytics pixels doesn't fail every audit.
    if (/status of 5\d\d/i.test(line)) {
      guns.push(line);
    }
  }
  for (const gap of audit.gaps ?? []) {
    if (gap.severity === 'critical') {
      guns.push(`critical gap: ${gap.id} ${gap.description}`);
    }
  }
  return guns;
}

function deriveOutcome(boot: BootResult, audit: AuditResult | undefined): PageOutcome {
  if (boot.status !== 'running') return 'boot-failed';
  if (!audit || !audit.health) return 'drive-failed';
  switch (audit.health.status) {
    case 'ok':
      return 'audited';
    case 'auth-redirect':
      return 'redirected';
    case 'http-error':
    case 'error-overlay':
    case 'degraded-empty':
    case 'soft-lockout':
      return 'errored';
    case 'navigation-failed':
      return 'drive-failed';
    case 'route-drift':
      return 'route-drift';
    default:
      return 'drive-failed';
  }
}

/* ───────────────────────────── main ───────────────────────────── */

export async function runPipeline(config: PipelineConfig): Promise<RunManifest> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  if (config.llmProvider !== 'gemini') {
    config.concurrency = Math.min(config.concurrency, 2);
    console.log(`[reframe] low-RPM provider '${config.llmProvider}' selected. Concurrency capped at ${config.concurrency} with backoff delays.`);
  }

  // Manifest is built incrementally; even an aborted run gets one written
  // by the caller via the value returned / thrown — but we own scratch
  // cleanup unconditionally in `finally`.
  let scratchCleaned = false;
  const extraAlerts: string[] = [];

  // gemini is created after scratch so a disk failure surfaces first.
  let gemini: GeminiClient | undefined;

  // PID of the dev server started by the boot gate — killed before scratch
  // cleanup so it does not hold the directory open (tracked in outer scope
  // so the `finally` can reach it).
  let devServerPid: number | undefined;

  try {
    /* (1) Scratch + disk guard. */
    console.log(`\n[reframe] starting run for ${config.target}`);
    console.log(`[reframe] run dir: ${config.runDir}`);
    await prepareScratch(config);
    const disk = await checkDisk(config.scratchDir);
    console.log(`[reframe] scratch disk: ${disk.freeMb} MB free (ok=${disk.ok})`);
    if (!disk.ok) {
      extraAlerts.push(
        `Low scratch disk: only ${disk.freeMb} MB free at ${config.scratchDir}. Run may fail.`,
      );
      console.error(`[reframe] WARNING: low scratch disk (${disk.freeMb} MB).`);
    }

    /* Materialize the working copy: copy local path, else clone. */
    if (config.isLocalPath) {
      console.log(`[reframe] local target — copying into work dir...`);
      copyDirInto(config.target, config.workDir);
    } else {
      console.log(`[reframe] cloning ${config.target}...`);
      await cloneRepo(config.target, config.workDir);
    }

    /* (2) Run dir + subdirs. */
    ensureDir(config.runDir);
    ensureDir(path.join(config.runDir, 'pages'));
    ensureDir(path.join(config.runDir, 'test-scaffold'));
    ensureDir(path.join(config.runDir, 'logs'));

    /* (3) Gemini client. */
    gemini = new GeminiClient(config);

    /* (4) State — resume or fresh. We seed page slugs after Stage 0. */
    let state: RunState | null = null;
    let resuming = false;
    if (config.resumeRunDir) {
      state = loadState(config.resumeRunDir);
      if (state) {
        resuming = true;
        console.log(`[reframe] resuming run from ${config.resumeRunDir}`);
      } else {
        console.log(
          `[reframe] --resume given but no state.json found — starting fresh.`,
        );
      }
    }

    /* (5) Stage 0 — map. */
    let scope: ScopeDoc;
    if (config.scopePath) {
      // --scope: pin the route map (deterministic). Skips the LLM mapper so
      // every run + every parallel shard audits the identical route set with
      // correct source paths. Still persists it into the run dir.
      console.log(`[reframe] Stage 0 — using PINNED scope from ${config.scopePath} (LLM mapping skipped).`);
      scope = JSON.parse(fs.readFileSync(config.scopePath, 'utf8')) as ScopeDoc;
      try {
        fs.mkdirSync(config.runDir, { recursive: true });
        fs.writeFileSync(path.join(config.runDir, 'scope.json'), JSON.stringify(scope, null, 2), 'utf8');
      } catch { /* best-effort */ }
      console.log(`[reframe] Stage 0 (pinned) — ${scope.pages.length} page(s).`);
    } else if (resuming && state && state.stage0 === 'done') {
      console.log(`[reframe] Stage 0 already done — loading scope.json`);
      scope = JSON.parse(
        fs.readFileSync(path.join(config.runDir, 'scope.json'), 'utf8'),
      ) as ScopeDoc;
    } else {
      console.log(`[reframe] Stage 0 — mapping repo...`);
      scope = await runStage0(config, gemini);
      console.log(
        `[reframe] Stage 0 done — ${scope.pages.length} page(s), ` +
          `${scope.brokenContracts.length} broken contract(s).`,
      );
    }

    if (config.scenario) {
      const scenariosPath = path.join(config.workDir, '.reframe', 'scenarios.json');
      if (fs.existsSync(scenariosPath)) {
        try {
          const scenariosContent = fs.readFileSync(scenariosPath, 'utf8');
          const scenariosDoc = JSON.parse(scenariosContent);
          const scenario = scenariosDoc.scenarios?.[config.scenario] || scenariosDoc[config.scenario];
          if (scenario) {
            console.log(`[reframe] Applying workflow scenario "${config.scenario}"`);
            if (scenario.routes && Array.isArray(scenario.routes)) {
              config.routePatterns = scenario.routes;
              console.log(`[reframe] Scenario routes: ${scenario.routes.join(', ')}`);
            }
            if (scenario.brief && typeof scenario.brief === 'string') {
              config.brief = scenario.brief;
              console.log(`[reframe] Scenario brief: "${config.brief}"`);
            }
            if (scenario.seedCmd && typeof scenario.seedCmd === 'string') {
              config.seedCmd = scenario.seedCmd;
              console.log(`[reframe] Scenario seed command: "${config.seedCmd}"`);
            }
            if (scenario.requiredSeedFiles && Array.isArray(scenario.requiredSeedFiles)) {
              for (const fileRel of scenario.requiredSeedFiles) {
                const absFile = path.join(config.workDir, fileRel);
                if (!fs.existsSync(absFile)) {
                  const msg = `Preflight error: Required seed file "${fileRel}" not found for scenario "${config.scenario}".`;
                  console.error(`[reframe] ${msg}`);
                  extraAlerts.push(msg);
                } else {
                  console.log(`[reframe] Preflight check passed: Seed file "${fileRel}" exists.`);
                }
              }
            }
          } else {
            console.warn(`[reframe] Scenario "${config.scenario}" not found in ${scenariosPath}`);
          }
        } catch (err) {
          console.error(`[reframe] Failed to parse scenarios.json: ${errMsg(err)}`);
        }
      } else {
        console.warn(`[reframe] scenarios.json not found at ${scenariosPath}`);
      }
    }

    if (config.onlyRoles && config.onlyRoles.length > 0) {
      const rolesSet = new Set(config.onlyRoles);
      const originalLength = scope.pages.length;
      scope.pages = scope.pages.filter((p) => p.role && rolesSet.has(p.role));
      console.log(
        `[reframe] Role filter: processing ${scope.pages.length} of ${originalLength} mapped pages matching roles: ${config.onlyRoles.join(', ')}`,
      );
    }

    if (config.routePatterns && config.routePatterns.length > 0) {
      const originalLength = scope.pages.length;
      scope.pages = filterPagesByRoutes(scope.pages, config.routePatterns);
      const msg = `Route filter: processing ${scope.pages.length} of ${originalLength} mapped pages matching: ${config.routePatterns.join(', ')}`;
      console.log(`[reframe] ${msg}`);
      if (scope.pages.length === 0) {
        extraAlerts.push(`${msg}. No mapped page matched the requested route filter.`);
      }
    }

    if (config.shard) {
      const { index, total } = config.shard;
      const originalLength = scope.pages.length;
      // Stable round-robin split so N parallel tasks cover disjoint pages and
      // their union is the whole app. Index is 0-based.
      scope.pages = scope.pages.filter((_, i) => i % total === index);
      console.log(
        `[reframe] Shard ${index}/${total}: processing ${scope.pages.length} of ${originalLength} mapped pages.`,
      );
    }

    if (config.maxPages !== undefined && scope.pages.length > config.maxPages) {
      const originalLength = scope.pages.length;
      scope.pages = scope.pages.slice(0, config.maxPages);
      const msg = `Page cap: processing ${config.maxPages} of ${originalLength} mapped pages (--max-pages ${config.maxPages}). Re-run without --max-pages for full coverage.`;
      extraAlerts.push(msg);
      console.log(`[reframe] ${msg}`);
    }

    /* (5.5) --diff-only: filter to pages whose source file is changed on
       this branch relative to the configured base (origin/main by default).
       Runs AFTER role + page-cap filters so all selectors compose. Pages
       are matched by absolute and workspace-relative file path so it works
       whether stage 0 emitted absolute or repo-relative paths. */
    if (config.diffOnly) {
      try {
        const diffWorkDir = config.isLocalPath
          ? path.resolve(config.target)
          : config.workDir;
        const { base, files: changedFiles } = await getChangedFiles(
          diffWorkDir,
          config.diffBase,
        );
        const changedSet = new Set<string>();
        for (const f of changedFiles) {
          changedSet.add(f);
          // Normalize POSIX separators on Windows for cross-platform match.
          changedSet.add(f.replace(/\\/g, '/'));
        }
        const originalLength = scope.pages.length;
        scope.pages = scope.pages.filter((p) => {
          if (!p.filePath) return false;
          const rel = path.isAbsolute(p.filePath)
            ? path.relative(config.workDir, p.filePath).replace(/\\/g, '/')
            : p.filePath.replace(/\\/g, '/');
          return changedSet.has(rel);
        });
        const msg = changedFiles.length === 0
          ? `Diff-only against ${base}: no files changed on this branch — nothing to audit.`
          : `Diff-only against ${base}: ${scope.pages.length} of ${originalLength} pages match the ${changedFiles.length} changed file(s).`;
        extraAlerts.push(msg);
        console.log(`[reframe] ${msg}`);
      } catch (err) {
        extraAlerts.push(`--diff-only failed: ${errMsg(err)}`);
        console.error(`[reframe] --diff-only failed: ${errMsg(err)}`);
        // Continue with the full scope rather than aborting — the operator
        // gets a clear alert in the manifest and a usable run.
      }
    }

    /* If we had no state yet (fresh run, or resume without file), build it
       now that we know the page slugs. */
    if (!state) {
      state = newRunState(config, scope.pages.map((p) => p.slug));
    } else {
      // Resumed: make sure every mapped page has a slot in the ledger.
      for (const p of scope.pages) {
        if (!state.pages[p.slug]) {
          state.pages[p.slug] = { slug: p.slug, agents: freshAgentMap() };
        }
      }
    }
    state.stage0 = 'done';
    saveState(config.runDir, state);

    /* (6) BRAND PIN GATE. */
    const brand = resolveBrand(config, scope, extraAlerts);
    const constraints = resolveConstraints(config, scope.productGoal);

    /* (6.5) --bootstrap-only: produce the candidate brand spec and exit
       without booting the dev server or running any agents. Used by the
       `reframe bootstrap` subcommand so an operator can review and pin
       the brand before committing to a full audit run. */
    if (config.bootstrapOnly) {
      const brandCandidatePath = path.join(config.runDir, 'brand.candidate.json');
      // resolveBrand already wrote brand.resolved.json; also write a copy
      // at the more discoverable name `brand.candidate.json` so the operator
      // doesn't have to interpret "resolved" vs "candidate" wording.
      try {
        fs.writeFileSync(brandCandidatePath, JSON.stringify(brand, null, 2), 'utf8');
      } catch (err) {
        extraAlerts.push(`Could not write brand.candidate.json: ${errMsg(err)}`);
      }

      // Pretty-print the brand candidate inline so the operator sees what
      // they're about to pin without having to run a follow-up command.
      // The `reframe show-brand` subcommand renders the same block out of
      // a completed run dir, so the experience is consistent.
      console.log('');
      console.log(`[reframe] BOOTSTRAP COMPLETE — ${scope.pages.length} pages mapped.`);
      try {
        const { renderBrand } = await import('./show-brand');
        console.log(renderBrand(brand, 'brand.candidate.json', config.runDir));
      } catch (err) {
        console.error(`[reframe] could not render brand summary: ${errMsg(err)}`);
      }

      // Interactive pin: if stdin is a TTY (a human is at the keyboard, not
      // CI), offer to write config/brand.json directly so the operator can
      // pin and re-run in one step. Silent in non-TTY contexts (CI / pipes).
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const targetDir = config.isLocalPath
          ? path.resolve(config.target)
          : process.cwd();
        const pinPath = path.join(targetDir, 'config', 'brand.json');
        const answer = await promptYesNo(
          `Pin this brand to ${pinPath} now? (y/N) `,
        );
        if (answer) {
          try {
            const pinnedBrand = { ...brand, pinned: true };
            fs.mkdirSync(path.dirname(pinPath), { recursive: true });
            fs.writeFileSync(pinPath, JSON.stringify(pinnedBrand, null, 2), 'utf8');
            console.log('');
            console.log(`[reframe] ✓ pinned to ${pinPath}`);
            console.log(`[reframe]   re-run with:  reframe rebuild ${config.target} --brand ${pinPath}`);
            console.log('');
          } catch (err) {
            extraAlerts.push(`Interactive pin to ${pinPath} failed: ${errMsg(err)}`);
            console.error(`[reframe] could not write ${pinPath}: ${errMsg(err)}`);
          }
        }
      }

      // Clean scratch and write a minimal manifest so downstream tooling
      // (the review UI, CI) can detect a bootstrap run via its empty
      // pagesProcessed list and the dedicated alert below.
      const cleaned = await safeCleanup(config);
      const geminiAlerts = gemini ? gemini.alerts : [];
      const manifest: RunManifest = {
        project: config.projectSlug,
        target: config.target,
        startedAt,
        finishedAt: new Date().toISOString(),
        wallClockMs: Date.now() - startedAtMs,
        bootStatus: 'no-server',
        pagesProcessed: [],
        testUsers: [],
        applyMode: config.applyMode,
        scratchCleaned: cleaned,
        alerts: [
          ...geminiAlerts,
          ...extraAlerts,
          `Bootstrap-only run — brand candidate at ${brandCandidatePath}. Pin and re-run for a full audit.`,
        ],
      };
      writeManifest(config.runDir, manifest);
      scratchCleaned = true;
      return manifest;
    }

    /* (7) Stage 0.5 — boot gate. Always re-run, even on resume: scratch (with
       node_modules AND the running dev server) is deleted at the end of every
       run, so a cached boot.json baseUrl from a prior run points at a server
       that no longer exists. */
    let boot: BootResult;
    if (config.baseUrl) {
      // --base-url: skip boot entirely and audit an already-live deployment.
      // Source was still copied/cloned above for route mapping + findings
      // context; we just point the browser at the live URL instead of a
      // freshly-booted dev server.
      console.log(
        `[reframe] Stage 0.5 — SKIPPED (--base-url ${config.baseUrl}); auditing the live deployment.`,
      );
      boot = {
        status: 'running',
        baseUrl: config.baseUrl,
        installLog: '',
        bootLog: `[--base-url] auditing live deployment at ${config.baseUrl} (no local boot/install)`,
        stubbedIntegrations: [
          `NONE — --base-url: auditing live deployment ${config.baseUrl} (real data, real rendering)`,
        ],
      };
      try {
        fs.mkdirSync(config.runDir, { recursive: true });
        fs.writeFileSync(
          path.join(config.runDir, 'boot.json'),
          JSON.stringify(boot, null, 2),
          'utf8',
        );
      } catch { /* best-effort */ }
    } else {
      console.log(`[reframe] Stage 0.5 — boot gate...`);
      boot = await runBootGate(config);
    }
    console.log(
      `[reframe] boot status: ${boot.status}` +
        (boot.baseUrl ? ` @ ${boot.baseUrl}` : ''),
    );
    if (boot.status !== 'running') {
      extraAlerts.push(
        `Boot gate: app did not start (${boot.status}) — ` +
          `${boot.reason ?? 'no reason given'}. Audit/verify run degraded.`,
      );
    }
    if (config.auth) {
      console.log(
        `[reframe] auth-aware auditing enabled — ${config.auth.roles.length} ` +
          `role(s); gated routes audited logged in.`,
      );
    }
    devServerPid = boot.pid;
    state.stage0_5 = 'done';
    saveState(config.runDir, state);

    /* (8) Per-run branch in 'pr' mode. */
    const branch = `reframe/${runStamp()}`;
    if (config.applyMode === 'pr') {
      console.log(`[reframe] creating run branch ${branch}`);
      try {
        await createRunBranch(config.workDir, branch);
      } catch (err) {
        extraAlerts.push(
          `Could not create run branch ${branch}: ${errMsg(err)}. ` +
            `Changes applied on the current branch instead.`,
        );
        console.error(`[reframe] branch creation failed: ${errMsg(err)}`);
      }
    }

    /* (9) PER-PAGE FAN-OUT. */
    if (config.quickScan) {
      console.log(`[reframe] quick-scan tier: per-page review agents on the cheap model.`);
    }
    console.log(
      `[reframe] fan-out: ${scope.pages.length} page(s), ` +
        `concurrency ${config.concurrency}.`,
    );

    // ADR-0001 slice 4 — compute the cross-run telemetry signals ONCE
    // before the per-page fan-out and pass the result into every
    // decorateAllFindings call. Runs in milliseconds (~50 small JSON
    // reads); a per-page recompute would be O(pages × priors) for the
    // same answer.
    const runsParent = path.dirname(config.runDir);
    const telemetrySignals = loadTelemetrySignals(runsParent, config.runDir);
    if (telemetrySignals.occurrenceCount.size > 0 || telemetrySignals.hadFeedback.size > 0) {
      console.log(
        `[reframe] telemetry: ${telemetrySignals.occurrenceCount.size} recurring ` +
          `finding fingerprint(s), ${telemetrySignals.hadFeedback.size} with prior feedback.`,
      );
    }

    const pageEntries: PageManifestEntry[] = [];

    const processPage = async (page: PageScope): Promise<void> => {
      const pageState: PageState =
        state!.pages[page.slug] ??
        (state!.pages[page.slug] = { slug: page.slug, agents: freshAgentMap() });

      const approvals = loadApprovals(config.runDir);
      const approval = approvals?.pages[page.slug];
      if (approval && approval.decision === 'skip') {
        console.log(`[${page.slug}] skipped: marked 'skip' in approvals.json.`);
        const reviewAgents: AgentName[] = ['audit', 'ux', 'design', 'compliance', 'code', 'verify'];
        for (const a of reviewAgents) {
          pageState.agents[a] = 'skipped';
        }
        pageState.pass = true;
        saveState(config.runDir, state!);
        pageEntries.push({
          slug: page.slug,
          route: page.route,
          status: 'drive-failed',
          health: undefined,
          agentsRun: [],
          pass: true,
          gapsFound: 0,
          gapsClosed: 0,
          complianceFindings: 0,
        });
        return;
      }

      const pageDir = path.join(config.runDir, 'pages', page.slug);
      ensureDir(pageDir);

      const ctx: AgentContext = {
        config,
        page,
        scope,
        brand,
        constraints,
        boot,
        gemini: gemini!,
        pageDir,
        approval,
      };

      // Checkpoint helper — marks an agent's status and persists state.
      // A failed checkpoint write must NEVER abort the page: resume just
      // becomes slightly stale. Swallow + log; do not throw.
      const mark = (agent: AgentName, status: StepStatus): void => {
        pageState.agents[agent] = status;
        try {
          saveState(config.runDir, state!);
        } catch (err) {
          console.error(
            `[${page.slug}] checkpoint save failed (${agent}=${status}) — ` +
              `continuing: ${errMsg(err)}`,
          );
        }
      };
      // Run one agent unless already 'done' on a resumed run.
      const runAgent = async <T>(
        agent: AgentName,
        fn: () => Promise<T>,
      ): Promise<T | undefined> => {
        if (pageState.agents[agent] === 'done') {
          console.log(
            `[${page.slug}] ${agent}: skipped (already done) — reloading result.`,
          );
          return loadAgentResult<T>(pageDir, agent);
        }
        if (pageState.agents[agent] === 'skipped') {
          console.log(
            `[${page.slug}] ${agent}: skipped.`,
          );
          return undefined;
        }
        mark(agent, 'running');
        try {
          if (config.llmProvider !== 'gemini') {
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
          const out = await fn();
          mark(agent, 'done');
          console.log(`[${page.slug}] ${agent}: done.`);
          return out;
        } catch (err) {
          mark(agent, 'failed');
          extraAlerts.push(
            `Page "${page.slug}" agent "${agent}" failed: ${errMsg(err)}`,
          );
          console.error(`[${page.slug}] ${agent}: FAILED — ${errMsg(err)}`);
          throw err;
        }
      };

      console.log(`[${page.slug}] starting (${page.route}).`);

      // --verify-only: skip the upstream DAG entirely and re-hydrate audit
      // (and optionally compliance) from the resumed run's on-disk artifacts.
      // Agent 5 needs ctx.audit.gaps to know what to verify against — without
      // it, verify falls back to "trivially pass if the page drives clean",
      // which isn't what `reframe verify` asks for.
      if (config.verifyOnly) {
        const pageDir = path.join(config.runDir, 'pages', page.slug);
        const auditJsonPath = path.join(pageDir, 'audit.json');
        if (fs.existsSync(auditJsonPath)) {
          try {
            ctx.audit = JSON.parse(fs.readFileSync(auditJsonPath, 'utf8')) as AuditResult;
          } catch (err) {
            extraAlerts.push(
              `[${page.slug}] could not load audit.json for --verify-only: ${errMsg(err)}`,
            );
          }
        }
        const complianceJsonPath = path.join(pageDir, 'compliance.json');
        if (fs.existsSync(complianceJsonPath)) {
          try {
            ctx.compliance = JSON.parse(fs.readFileSync(complianceJsonPath, 'utf8')) as ComplianceResult;
          } catch {
            /* compliance is optional for verify; ignore parse errors */
          }
        }
        // Skip-mark every upstream agent so the page state reflects what
        // we actually did (only verify ran).
        mark('audit', ctx.audit ? 'done' : 'skipped');
        mark('ux', 'skipped');
        mark('design', 'skipped');
        mark('code', 'skipped');
        mark('compliance', ctx.compliance ? 'done' : 'skipped');
      } else {
        // DAG: audit → (ux → design); compliance ∥ that chain; then code; then verify.
        ctx.audit = (await runAgent('audit', () => runAudit(ctx))) ?? ctx.audit;

        if (ctx.audit?.health && (ctx.audit.health.status === 'route-drift' || ctx.audit.health.status === 'auth-redirect')) {
          console.log(`[${page.slug}] route-drift or auth-redirect detected (${ctx.audit.health.status}). Skipping downstream agents.`);
          const skipAgents: AgentName[] = ['ux', 'design', 'compliance', 'code', 'verify'];
          for (const a of skipAgents) {
            mark(a, 'skipped');
          }
        } else {
          // Coaching & Auto-Remediation Check
          while (ctx.audit && (ctx.audit.health?.status === 'soft-lockout' || ctx.audit.health?.status === 'degraded-empty')) {
            console.log(`\n================================================================================`);
            console.log(`⚠️  DEGRADED AUDIT DETECTED on page: ${page.slug} (${page.route})`);
            console.log(`   Health status: ${ctx.audit.health.status}`);
            console.log(`   Detail: ${ctx.audit.health.detail}`);
            console.log(`================================================================================\n`);

            if (process.stdin.isTTY && process.stdout.isTTY) {
              console.log(`Reframe paused. Please select an option to resolve the missing state:`);
              console.log(` [L] Launch headed browser to log in manually and reconnect/cache session`);
              console.log(` [S] Execute database seed command`);
              console.log(` [E] Overwrite SQLite file with .reframe/mock.db template`);
              console.log(` [C] Continue anyway (LLM will audit the empty state)`);
              console.log(` [K] Skip this page audit for now`);
              console.log(``);

              const choice = await promptCoachingChoice(`Select action [L/S/E/C/K]: `);
              if (choice === 'l') {
                console.log(`[reframe] Spawning headed browser for manual login...`);
                try {
                  const { chromium } = await import('playwright');
                  const browser = await chromium.launch({ headless: false });
                  const context = await browser.newContext();
                  const loginPage = await context.newPage();
                  const authConfig = ctx.config.auth;
                  const loginUrl = authConfig ? `${ctx.boot.baseUrl}${authConfig.loginUrl.startsWith('/') ? authConfig.loginUrl : `/${authConfig.loginUrl}`}` : `${ctx.boot.baseUrl}/login`;
                  console.log(`[reframe] Opening ${loginUrl} in headed browser...`);
                  await loginPage.goto(loginUrl, { waitUntil: 'domcontentloaded' });
                  console.log(`[reframe] Please log in manually. Close the browser window when finished.`);
                  await new Promise<void>((res) => {
                    browser.on('disconnected', () => res());
                  });
                  console.log(`[reframe] Headed browser closed. Re-running page health audit...`);
                  pageState.agents.audit = 'pending';
                  ctx.audit = await runAudit(ctx);
                } catch (err) {
                  console.error(`[reframe] Headed login failed: ${String(err)}`);
                }
              } else if (choice === 's') {
                if (config.seedCmd) {
                  console.log(`[reframe] Executing custom database seed command: ${config.seedCmd}`);
                  try {
                    const parts = config.seedCmd.split(/\s+/);
                    const result = spawnSync(parts[0], parts.slice(1), {
                      cwd: config.workDir,
                      encoding: 'utf8',
                      shell: IS_WINDOWS,
                    });
                    console.log(result.stdout || result.stderr || 'Seed finished.');
                  } catch (err) {
                    console.error(`[reframe] Seed failed: ${String(err)}`);
                  }
                } else {
                  try {
                    const pkgRaw = fs.readFileSync(path.join(config.workDir, 'package.json'), 'utf8');
                    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
                    const scripts = pkg.scripts ?? {};
                    const seedScript = ['db:seed', 'seed'].find(s => typeof scripts[s] === 'string' && scripts[s].trim());
                    if (seedScript) {
                      const pm = fs.existsSync(path.join(config.workDir, 'pnpm-lock.yaml')) ? 'pnpm'
                               : fs.existsSync(path.join(config.workDir, 'yarn.lock')) ? 'yarn'
                               : fs.existsSync(path.join(config.workDir, 'bun.lockb')) ? 'bun'
                               : 'npm';
                      console.log(`[reframe] Executing seed via package manager: ${pm} run ${seedScript}`);
                      const result = spawnSync(pm, ['run', seedScript], {
                        cwd: config.workDir,
                        encoding: 'utf8',
                        shell: IS_WINDOWS,
                      });
                      console.log(result.stdout || result.stderr || 'Seed finished.');
                    } else {
                      console.warn(`[reframe] No custom seedCmd provided and no db:seed/seed scripts found in package.json.`);
                    }
                  } catch (err) {
                    console.error(`[reframe] Seeder auto-detection failed: ${String(err)}`);
                  }
                }
                pageState.agents.audit = 'pending';
                ctx.audit = await runAudit(ctx);
              } else if (choice === 'e') {
                console.log(`[reframe] Swapping in SQLite mock database template...`);
                try {
                  const mockDb = path.join(config.workDir, '.reframe', 'mock.db');
                  if (fs.existsSync(mockDb)) {
                    const scanAndOverwrite = (dir: string) => {
                      const entries = fs.readdirSync(dir, { withFileTypes: true });
                      for (const entry of entries) {
                        const abs = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                          if (['node_modules', '.git', '.next', 'dist', 'build', 'runs'].includes(entry.name)) continue;
                          scanAndOverwrite(abs);
                        } else if (entry.isFile() && ['.db', '.sqlite', '.sqlite3'].includes(path.extname(entry.name).toLowerCase()) && !abs.includes('.reframe')) {
                           console.log(`[reframe] Replacing database file: ${abs}`);
                           fs.copyFileSync(mockDb, abs);
                        }
                      }
                    };
                    scanAndOverwrite(config.workDir);
                  } else {
                    console.warn(`[reframe] SQLite template not found at ${mockDb}.`);
                  }
                } catch (err) {
                  console.error(`[reframe] SQLite swap failed: ${String(err)}`);
                }
                pageState.agents.audit = 'pending';
                ctx.audit = await runAudit(ctx);
              } else if (choice === 'k') {
                console.log(`[reframe] Skipping this page audit.`);
                const skipAgents: AgentName[] = ['ux', 'design', 'compliance', 'code', 'verify'];
                for (const a of skipAgents) {
                  pageState.agents[a] = 'skipped';
                }
                pageState.pass = false;
                return;
              } else if (choice === 'c') {
                console.log(`[reframe] Continuing with empty/degraded state.`);
                break;
              }
            } else {
              extraAlerts.push(`Page "${page.slug}" loaded in a degraded/lockout state (${ctx.audit.health.status}). Non-TTY environment: continuing scan without coaching.`);
              break;
            }
          }

          if (ctx.audit?.health && (ctx.audit.health.status === 'route-drift' || ctx.audit.health.status === 'auth-redirect')) {
            console.log(`[${page.slug}] route-drift or auth-redirect detected after coaching (${ctx.audit.health.status}). Skipping downstream agents.`);
            const skipAgents: AgentName[] = ['ux', 'design', 'compliance', 'code', 'verify'];
            for (const a of skipAgents) {
              mark(a, 'skipped');
            }
          } else {
            const reviewChain = (async () => {
              ctx.ux = (await runAgent('ux', () => runUx(ctx))) ?? ctx.ux;
              ctx.design = (await runAgent('design', () => runDesign(ctx))) ?? ctx.design;
            })();
            const complianceChain = (async () => {
              ctx.compliance =
                (await runAgent('compliance', () => runCompliance(ctx))) ?? ctx.compliance;
            })();
            await Promise.all([reviewChain, complianceChain]);
          }
        }
      }

      // ADR-0001: decorate every finding with mechanical signals before
      // anything downstream reads them. Runs once per page, after both
      // Agent 1 and Agent 6 have produced their outputs (or after the
      // --verify-only rehydration above). Mutates ctx.audit.gaps and
      // ctx.compliance.findings in place so review-app, PR body, Founder
      // Digest, and Agent 4's prompt all see the enriched data without
      // additional wiring.
      decorateAllFindings(
        page,
        ctx.audit,
        ctx.compliance,
        scope.brokenContracts,
        telemetrySignals,
      );

      // 'review' mode stops at the four review agents: no code, no verify —
      // the operator approves proposed-changes.md before any apply pass.
      // --verify-only skips the gap-filter + code agent and goes straight
      // to verify against the rehydrated audit results.
      let verify: VerifyResult | undefined;
      if (config.verifyOnly) {
        verify = await runAgent('verify', () => runVerify(ctx));
      } else if (config.applyMode !== 'review') {
        if (ctx.audit && approval?.gaps) {
          const originalGapCount = ctx.audit.gaps.length;
          ctx.audit.gaps = ctx.audit.gaps.filter(g => {
            const decision = approval.gaps?.[g.id];
            if (decision === 'skip') {
              console.log(`[${page.slug}] skipping gap ${g.id} per approvals.json`);
              return false;
            }
            return true;
          });
          const skippedCount = originalGapCount - ctx.audit.gaps.length;
          if (skippedCount > 0) {
            console.log(`[${page.slug}] filtered gaps: ${originalGapCount} -> ${ctx.audit.gaps.length} (${skippedCount} skipped)`);
          }
        }

        // Mirror the gap-skip flow for compliance findings the reviewer
        // marked as skip from the Run Overview. Keyed `${ruleId}::${location}`
        // so multiple findings of the same rule at different lines can be
        // decided independently. Findings that were dismissed don't flow
        // into agent 4's prompt (which reads ctx.compliance.findings) and
        // therefore don't pull code changes for them.
        if (ctx.compliance && approval?.complianceFindings) {
          const originalCount = ctx.compliance.findings.length;
          ctx.compliance.findings = ctx.compliance.findings.filter((f) => {
            const key = `${f.ruleId}::${f.location}`;
            if (approval.complianceFindings?.[key] === 'skip') {
              console.log(`[${page.slug}] skipping compliance finding ${key} per approvals.json`);
              return false;
            }
            return true;
          });
          const skipped = originalCount - ctx.compliance.findings.length;
          if (skipped > 0) {
            console.log(
              `[${page.slug}] filtered compliance findings: ${originalCount} -> ` +
                `${ctx.compliance.findings.length} (${skipped} skipped)`,
            );
            // Recompute the clean flag — a previously-dirty page becomes
            // clean if every remaining finding is below the critical/high
            // bar (matches agent6-compliance's own clean computation).
            ctx.compliance.clean = !ctx.compliance.findings.some(
              (f) => f.severity === 'critical' || f.severity === 'high',
            );
          }
        }

        ctx.code = (await runAgent('code', () => runCode(ctx))) ?? ctx.code;
        verify = await runAgent('verify', () => runVerify(ctx));
      } else {
        mark('code', 'skipped');
        mark('verify', 'skipped');
      }

      // Pass: in review mode = all four review agents completed AND no
      // "smoking guns" were observed (browser JS crash, 5xx fetch, or any
      // critical-severity gap). Without this gate a screen that literally
      // threw `pageerror: Rendered more hooks than during the previous
      // render` would still be reported as PASS — exactly what bit us
      // auditing our own review-app.
      const reviewAgents: AgentName[] = ['audit', 'ux', 'design', 'compliance'];
      const smokingGuns = ctx.audit ? detectSmokingGuns(ctx.audit) : [];
      const pass =
        config.applyMode === 'review'
          ? reviewAgents.every((a) => pageState.agents[a] === 'done')
            && deriveOutcome(boot, ctx.audit) === 'audited'
            && smokingGuns.length === 0
          : verify
            ? verify.pass
            : pageState.pass ?? false;
      pageState.pass = pass;
      saveState(config.runDir, state!);

      const agentsRun = (Object.keys(pageState.agents) as AgentName[]).filter(
        (a) => pageState.agents[a] === 'done',
      );
      pageEntries.push({
        slug: page.slug,
        route: page.route,
        status: deriveOutcome(boot, ctx.audit),
        health: ctx.audit?.health,
        agentsRun,
        pass,
        gapsFound: ctx.audit ? ctx.audit.gaps.length : 0,
        gapsClosed: verify ? verify.gapsClosed.length : 0,
        complianceFindings: ctx.compliance ? ctx.compliance.findings.length : 0,
      });
      console.log(`[${page.slug}] complete — pass=${pass}.`);
    };

    // Wrap each worker so one page failing does not kill the pool.
    await runPool(scope.pages, config.concurrency, async (page) => {
      try {
        await processPage(page);
      } catch (err) {
        // Already alerted inside runAgent; record a terminal page entry.
        const ps = state!.pages[page.slug];
        if (ps) {
          ps.pass = false;
          saveState(config.runDir, state!);
        }
        if (!pageEntries.some((e) => e.slug === page.slug)) {
          const audited = ps?.agents.audit === 'done';
          pageEntries.push({
            slug: page.slug,
            route: page.route,
            status: boot.status !== 'running' ? 'boot-failed' : 'drive-failed',
            agentsRun: ps
              ? (Object.keys(ps.agents) as AgentName[]).filter(
                  (a) => ps.agents[a] === 'done',
                )
              : [],
            pass: false,
            gapsFound: 0,
            gapsClosed: 0,
            complianceFindings: 0,
          });
          void audited;
        }
        console.error(`[reframe] page "${page.slug}" aborted — pool continues.`);
      }
    });

    // Keep manifest page order stable (mapped order, not completion order).
    const orderedEntries: PageManifestEntry[] = scope.pages
      .map((p) => pageEntries.find((e) => e.slug === p.slug))
      .filter((e): e is PageManifestEntry => Boolean(e));

    /* (10) Commit + PR in 'pr' mode. Skipped on --verify-only: verify
       writes no code changes, so there is nothing to commit and a PR
       would be empty noise. */
    let prUrl: string | undefined;
    if (config.applyMode === 'pr' && !config.verifyOnly) {
      const passCount = orderedEntries.filter((e) => e.pass).length;
      const commitMsg =
        `reframe: ${passCount}/${orderedEntries.length} pages passing`;
      try {
        console.log(`[reframe] committing changes...`);
        await commitAll(config.workDir, commitMsg);
        console.log(`[reframe] opening PR...`);
        const url = await openPr(
          config.workDir,
          branch,
          `reframe run — ${config.projectSlug}`,
          buildPrBody(config, orderedEntries),
        );
        prUrl = url || undefined;
        console.log(
          prUrl ? `[reframe] PR: ${prUrl}` : `[reframe] no GitHub remote — PR skipped.`,
        );

        // --post-findings: also post the top-N plain-English digest as a
        // top-level PR conversation comment. GitHub sends conversation
        // comments as notifications to subscribed reviewers; the PR body
        // does not. This is the wake-up signal for Priya's reviewer queue.
        // Opt-in by default so an automated run never surprises a repo.
        if (prUrl && config.postFindings) {
          const commentBody = buildPrComment(config.runDir, orderedEntries);
          if (commentBody) {
            console.log(`[reframe] posting findings digest to PR...`);
            const posted = await postPrComment(config.workDir, prUrl, commentBody);
            if (!posted) {
              extraAlerts.push(
                `--post-findings: gh pr comment failed for ${prUrl} (see logs).`,
              );
            }
          } else {
            console.log(`[reframe] --post-findings: nothing to post (clean run).`);
          }
        }
      } catch (err) {
        extraAlerts.push(`Commit/PR step failed: ${errMsg(err)}`);
        console.error(`[reframe] commit/PR failed: ${errMsg(err)}`);
      }
    } else if (config.applyMode === 'review') {
      console.log(
        `[reframe] review mode — no code generated; proposed-changes.md only.`,
      );
    } else {
      console.log(`[reframe] propose mode — diffs only, no commit/PR.`);
    }

    /* (11) Test scaffold. Skipped in review mode — a review pass applies no
       code and (under --real-env) must not seed accounts into a real backend. */
    let testUsers: TestUser[] = [];
    if (config.applyMode === 'review' || config.verifyOnly) {
      state.testScaffold = 'skipped';
      saveState(config.runDir, state);
      console.log(
        `[reframe] ${config.verifyOnly ? '--verify-only' : 'review mode'} — test scaffold skipped.`,
      );
    } else if (
      resuming &&
      state.testScaffold === 'done' &&
      usersJsonExists(config.runDir)
    ) {
      console.log(`[reframe] test scaffold already done — loading users.json`);
      testUsers = JSON.parse(
        fs.readFileSync(
          path.join(config.runDir, 'test-scaffold', 'users.json'),
          'utf8',
        ),
      ) as TestUser[];
    } else {
      console.log(`[reframe] building test scaffold...`);
      state.testScaffold = 'running';
      saveState(config.runDir, state);
      try {
        testUsers = await runTestScaffold(config, scope, boot, gemini);
        state.testScaffold = 'done';
        console.log(`[reframe] test scaffold: ${testUsers.length} test user(s).`);
      } catch (err) {
        state.testScaffold = 'failed';
        extraAlerts.push(`Test scaffold failed: ${errMsg(err)}`);
        console.error(`[reframe] test scaffold failed: ${errMsg(err)}`);
      }
      saveState(config.runDir, state);
    }

    /* (11.5) Review mode — write the consolidated proposed-changes.md gate. */
    if (config.applyMode === 'review') {
      try {
        const pcPath = writeProposedChanges(config, scope);
        console.log(`[reframe] proposed changes written: ${pcPath}`);
        extraAlerts.push(
          `Review pass complete — read & approve ${pcPath}, then apply with: ` +
            `rebuild ${config.target} --resume ${config.runDir} --apply-mode pr`,
        );
      } catch (err) {
        extraAlerts.push(`Failed to write proposed-changes.md: ${errMsg(err)}`);
        console.error(`[reframe] proposed-changes.md failed: ${errMsg(err)}`);
      }
    }

    /* (12) Build + write the manifest. */
    const finishedAtMs = Date.now();
    state.finishedAt = new Date(finishedAtMs).toISOString();
    saveState(config.runDir, state);

    const alerts = [...gemini.alerts, ...extraAlerts];

    const manifest: RunManifest = {
      project: config.projectSlug,
      target: config.target,
      startedAt,
      finishedAt: state.finishedAt,
      wallClockMs: finishedAtMs - startedAtMs,
      bootStatus: boot.status,
      pagesProcessed: orderedEntries,
      testUsers,
      applyMode: config.applyMode,
      prUrl,
      scratchCleaned: false, // set true after cleanup below
      alerts,
    };

    /* (13) Stop the dev server, then always clean scratch. */
    stopDevServer(devServerPid);
    scratchCleaned = await safeCleanup(config);
    manifest.scratchCleaned = scratchCleaned;

    writeManifest(config.runDir, manifest);

    const allPass =
      orderedEntries.length > 0 && orderedEntries.every((e) => e.pass);
    console.log(
      `\n[reframe] run complete — ${orderedEntries.filter((e) => e.pass).length}/` +
        `${orderedEntries.length} pages passing, ${alerts.length} alert(s). ` +
        `all-pass=${allPass}.`,
    );

    return manifest;
  } finally {
    // Defensive: if we threw before the explicit cleanup, clean now.
    if (!scratchCleaned) {
      stopDevServer(devServerPid);
      const cleaned = await safeCleanup(config);
      // Best-effort manifest note — the run dir may already exist.
      if (cleaned) {
        console.log(`[reframe] scratch cleaned (finally).`);
      }
    }
  }
}

/* ───────────────────────────── sub-steps ───────────────────────────── */

/**
 * Brand pin gate (adjustment #7). If a pinned brand.json exists, use it.
 * Otherwise persist Stage 0's bootstrapped candidate, use it for THIS run,
 * and loudly tell the operator to pin it for deterministic re-runs.
 */
function resolveBrand(
  config: PipelineConfig,
  scope: ScopeDoc,
  alerts: string[],
): BrandSpec {
  const resolvedPath = path.join(config.runDir, 'brand.resolved.json');

  let pinned: BrandSpec | null = null;
  if (config.brandPath && fs.existsSync(config.brandPath)) {
    try {
      const candidate = loadBrand(config.brandPath);
      if (candidate.pinned) {
        pinned = candidate;
      }
    } catch (err) {
      alerts.push(`Could not read brand at ${config.brandPath}: ${errMsg(err)}`);
    }
  }

  if (pinned) {
    fs.writeFileSync(resolvedPath, JSON.stringify(pinned, null, 2), 'utf8');
    console.log(
      `[reframe] brand: PINNED "${pinned.name}" — Agent 3 is deterministic.`,
    );
    return pinned;
  }

  // Unpinned bootstrap path.
  const bootstrap: BrandSpec = { ...scope.bootstrappedBrand, pinned: false };
  fs.writeFileSync(resolvedPath, JSON.stringify(bootstrap, null, 2), 'utf8');
  const notice =
    `Brand is an UNPINNED bootstrap derived by Stage 0 ("${bootstrap.name}"). ` +
    `The run continues using it, but Agent 3 output is NOT deterministic. ` +
    `Review ${resolvedPath}, set "pinned": true, save it as config/brand.json, ` +
    `and re-run with --brand config/brand.json. See docs/BRAND_SPEC.md.`;
  alerts.push(notice);
  console.warn(`\n[reframe] ⚠ ${notice}\n`);
  return bootstrap;
}

/**
 * Constraints resolution. Uses the pinned constraints file when given,
 * else falls back to config/constraints.template.json. Always persists
 * the resolved copy actually used.
 */
function resolveConstraints(
  config: PipelineConfig,
  projectGoal: string,
): ConstraintsSpec {
  const resolvedPath = path.join(config.runDir, 'constraints.resolved.json');

  const candidates: string[] = [];
  if (config.constraintsPath) candidates.push(config.constraintsPath);
  candidates.push(
    path.join(process.cwd(), 'config', 'constraints.template.json'),
    path.join(__dirname, '..', 'config', 'constraints.template.json'),
  );

  let constraints: ConstraintsSpec | null = null;
  for (const file of candidates) {
    if (file && fs.existsSync(file)) {
      try {
        constraints = loadConstraints(file);
        break;
      } catch {
        /* try next candidate */
      }
    }
  }

  if (!constraints) {
    // Last-resort empty spec — Agent 6 simply finds nothing.
    constraints = { project: projectGoal || 'unknown', rules: [] };
    console.warn(
      `[reframe] ⚠ no constraints file found — Agent 6 runs with 0 rules.`,
    );
  }

  fs.writeFileSync(resolvedPath, JSON.stringify(constraints, null, 2), 'utf8');
  console.log(
    `[reframe] constraints: "${constraints.project}" — ` +
      `${constraints.rules.length} rule(s) for Agent 6.`,
  );
  return constraints;
}

/**
 * Kill the dev server started by the boot gate (and its child process tree)
 * so it stops holding the scratch dir open. Best-effort, never throws.
 */
function stopDevServer(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  }
  catch {
    /* best-effort — a dead pid is fine */
  }
}

/** Cleanup wrapper that never throws — safe for finally + failure paths. */
async function safeCleanup(config: PipelineConfig): Promise<boolean> {
  try {
    return await cleanupScratch(config);
  } catch (err) {
    console.error(`[reframe] scratch cleanup failed: ${errMsg(err)}`);
    return false;
  }
}

function usersJsonExists(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, 'test-scaffold', 'users.json'));
}

/**
 * Read this page's audit + compliance JSON from the run dir, if present.
 * Returns nulls on missing/malformed files — buildPrBody falls back to
 * the manifest counts in that case rather than throwing.
 */
function loadPageAgentArtifacts(
  runDir: string,
  slug: string,
): { audit: AuditResult | null; compliance: ComplianceResult | null } {
  const pageDir = path.join(runDir, 'pages', slug);
  let audit: AuditResult | null = null;
  let compliance: ComplianceResult | null = null;
  try {
    const auditPath = path.join(pageDir, 'audit.json');
    if (fs.existsSync(auditPath)) {
      audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')) as AuditResult;
    }
  } catch {
    /* malformed audit.json — fall through with null */
  }
  try {
    const compliancePath = path.join(pageDir, 'compliance.json');
    if (fs.existsSync(compliancePath)) {
      compliance = JSON.parse(fs.readFileSync(compliancePath, 'utf8')) as ComplianceResult;
    }
  } catch {
    /* malformed compliance.json — fall through with null */
  }
  return { audit, compliance };
}

/**
 * Build the plain-English summary block at the top of the PR body — the
 * reviewer-facing version of the run, in the language a non-technical
 * reader can act on. Reads agent artifacts directly off disk and ranks
 * findings by severity x confidence across audit + compliance.
 *
 * Returns an empty string when no findings of consequence were emitted,
 * so the PR body stays tight on clean runs.
 */
function buildPlainEnglishSummary(
  runDir: string,
  entries: PageManifestEntry[],
  maxItems = 5,
): string {
  const SEVERITY_WEIGHT: Record<string, number> = {
    critical: 4, high: 3, medium: 2, low: 1,
  };
  type DigestItem = {
    pageSlug: string;
    pageRoute: string;
    severity: string;
    headline: string;
    whyItMatters?: string;
    impact: number;
  };
  const items: DigestItem[] = [];

  for (const entry of entries) {
    const { audit, compliance } = loadPageAgentArtifacts(runDir, entry.slug);
    for (const gap of audit?.gaps ?? []) {
      const sev = SEVERITY_WEIGHT[gap.severity] ?? 1;
      const conf = gap.confidence ?? 0.8;
      items.push({
        pageSlug: entry.slug,
        pageRoute: entry.route,
        severity: gap.severity,
        headline: gap.plain || gap.description,
        whyItMatters: gap.whyItMatters,
        impact: sev * conf,
      });
    }
    for (const f of compliance?.findings ?? []) {
      const sev = SEVERITY_WEIGHT[f.severity] ?? 1;
      const conf = f.confidence ?? 0.8;
      items.push({
        pageSlug: entry.slug,
        pageRoute: entry.route,
        severity: f.severity,
        headline: f.plain || f.problem,
        whyItMatters: f.whyItMatters,
        impact: sev * conf,
      });
    }
  }

  if (items.length === 0) return '';

  items.sort((a, b) => b.impact - a.impact);
  const top = items.slice(0, maxItems);

  const lines: string[] = [
    '### ✨ What changed, in plain English',
    '',
    `The ${top.length === 1 ? 'one thing' : `${top.length} things`} most likely to land hardest with a real user — ranked by impact across every reviewed page:`,
    '',
  ];
  for (const item of top) {
    lines.push(`1. **[${item.severity}]** \`${item.pageSlug}\` — ${item.headline}`);
    if (item.whyItMatters) {
      lines.push(`   _Why it matters_: ${item.whyItMatters}`);
    }
  }
  if (items.length > top.length) {
    lines.push('', `_${items.length - top.length} additional findings below — see the manifest._`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the standalone PR conversation comment posted when --post-findings
 * is set. Distinct in shape from the PR body: shorter, action-oriented,
 * framed as a notification. Skips the manifest table (already in the body)
 * and goes straight to the top 3 findings with severity pills + plain text.
 *
 * Returns '' on a clean run so the caller skips the comment entirely
 * instead of posting an empty "nothing to see here" notification.
 */
function buildPrComment(
  runDir: string,
  entries: PageManifestEntry[],
): string {
  const SEVERITY_WEIGHT: Record<string, number> = {
    critical: 4, high: 3, medium: 2, low: 1,
  };
  type DigestItem = {
    pageSlug: string;
    severity: string;
    headline: string;
    whyItMatters?: string;
    impact: number;
  };
  const items: DigestItem[] = [];

  for (const entry of entries) {
    const { audit, compliance } = loadPageAgentArtifacts(runDir, entry.slug);
    for (const gap of audit?.gaps ?? []) {
      const sev = SEVERITY_WEIGHT[gap.severity] ?? 1;
      const conf = gap.confidence ?? 0.8;
      items.push({
        pageSlug: entry.slug,
        severity: gap.severity,
        headline: gap.plain || gap.description,
        whyItMatters: gap.whyItMatters,
        impact: sev * conf,
      });
    }
    for (const f of compliance?.findings ?? []) {
      const sev = SEVERITY_WEIGHT[f.severity] ?? 1;
      const conf = f.confidence ?? 0.8;
      items.push({
        pageSlug: entry.slug,
        severity: f.severity,
        headline: f.plain || f.problem,
        whyItMatters: f.whyItMatters,
        impact: sev * conf,
      });
    }
  }

  if (items.length === 0) return '';

  items.sort((a, b) => b.impact - a.impact);
  const top = items.slice(0, 3);
  const passCount = entries.filter((e) => e.pass).length;

  const lines: string[] = [
    `🤖 **Reframe review summary**`,
    '',
    `${passCount}/${entries.length} pages passing on this branch. The ${top.length === 1 ? 'item' : `${top.length} items`} most likely to land hardest with a real user:`,
    '',
  ];
  for (const item of top) {
    lines.push(`**\`[${item.severity}]\` \`${item.pageSlug}\`** — ${item.headline}`);
    if (item.whyItMatters) {
      lines.push(`_Why it matters_: ${item.whyItMatters}`);
    }
    lines.push('');
  }
  if (items.length > top.length) {
    lines.push(
      `📖 Plus ${items.length - top.length} more finding${items.length - top.length === 1 ? '' : 's'} in the PR description above.`,
    );
  } else {
    lines.push(`📖 Full manifest and per-page detail in the PR description above.`);
  }
  return lines.join('\n');
}

function buildPrBody(
  config: PipelineConfig,
  entries: PageManifestEntry[],
): string {
  const passCount = entries.filter((e) => e.pass).length;
  const lines = [
    `Automated rebuild by **Reframe** for \`${config.target}\`.`,
    '',
    `**${passCount}/${entries.length} pages passing.**`,
    '',
  ];

  const plainSummary = buildPlainEnglishSummary(config.runDir, entries);
  if (plainSummary) {
    lines.push(plainSummary);
  }

  lines.push(
    '### Page Manifest Summary',
    '',
    '| Page | Route | Pass | Gaps found | Gaps closed | Compliance findings |',
    '| ---- | ----- | ---- | ---------- | ----------- | ------------------- |',
  );
  for (const e of entries) {
    lines.push(
      `| ${e.slug} | ${e.route} | ${e.pass ? '✅' : '❌'} | ` +
        `${e.gapsFound} | ${e.gapsClosed} | ${e.complianceFindings} |`,
    );
  }

  const approvals = loadApprovals(config.runDir);
  if (approvals && Object.keys(approvals.pages).length > 0) {
    lines.push('', '### Human Approvals & Reviewer Comments Ledger');
    for (const [slug, approval] of Object.entries(approvals.pages)) {
      const decisionEmoji = approval.decision === 'apply' ? '🟢 APPROVED/APPLY' : '🟡 SKIPPED';
      lines.push(`- **Page \`${slug}\`**: ${decisionEmoji}`);
      if (approval.note) {
        lines.push(`  - **Reviewer Note**: _"${approval.note}"_`);
      }
      if (approval.comments && approval.comments.length > 0) {
        lines.push(`  - **Threaded Collaborator Comments**:`);
        for (const comment of approval.comments) {
          lines.push(`    - _"${comment}"_`);
        }
      }
      if (approval.gaps && Object.keys(approval.gaps).length > 0) {
        const gapDecisions = Object.entries(approval.gaps)
          .map(([gapId, dec]) => `\`${gapId}\`: ${dec === 'apply' ? 'apply' : 'skip'}`)
          .join(', ');
        lines.push(`  - **Gap Decisions**: ${gapDecisions}`);
      }
      if (approval.complianceFindings && Object.keys(approval.complianceFindings).length > 0) {
        const complianceDecisions = Object.entries(approval.complianceFindings)
          .map(([key, dec]) => `\`${key}\`: ${dec === 'apply' ? 'apply' : 'skip'}`)
          .join(', ');
        lines.push(`  - **Compliance Finding Decisions**: ${complianceDecisions}`);
      }
    }
  }

  lines.push('', '_Generated by Reframe. Review every diff before merge._');
  return lines.join('\n');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask a yes/no question on stdin. Resolves true on y/Y/yes (any case),
 * false on anything else — including empty input. Treats the answer as
 * "no" by default so accidental Enter never auto-pins.
 *
 * Caller is responsible for first checking process.stdin.isTTY — calling
 * this in CI / piped contexts would hang waiting for input.
 */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

const IS_WINDOWS = process.platform === 'win32';

function promptCoachingChoice(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}
