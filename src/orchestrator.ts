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
import { spawnSync } from 'node:child_process';

import { GeminiClient } from './gemini';
import { cloneRepo, createRunBranch, commitAll, openPr } from './git';
import { prepareScratch, cleanupScratch, checkDisk } from './scratch';
import { newRunState, loadState, saveState } from './state';
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

/** A run-stamp suitable for branch names: rebuild-pipeline/<stamp>. */
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

/* ───────────────────────────── main ───────────────────────────── */

export async function runPipeline(config: PipelineConfig): Promise<RunManifest> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

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
    console.log(`\n[pipeline] starting run for ${config.target}`);
    console.log(`[pipeline] run dir: ${config.runDir}`);
    await prepareScratch(config);
    const disk = await checkDisk(config.scratchDir);
    console.log(`[pipeline] scratch disk: ${disk.freeMb} MB free (ok=${disk.ok})`);
    if (!disk.ok) {
      extraAlerts.push(
        `Low scratch disk: only ${disk.freeMb} MB free at ${config.scratchDir}. Run may fail.`,
      );
      console.error(`[pipeline] WARNING: low scratch disk (${disk.freeMb} MB).`);
    }

    /* Materialize the working copy: copy local path, else clone. */
    if (config.isLocalPath) {
      console.log(`[pipeline] local target — copying into work dir...`);
      copyDirInto(config.target, config.workDir);
    } else {
      console.log(`[pipeline] cloning ${config.target}...`);
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
        console.log(`[pipeline] resuming run from ${config.resumeRunDir}`);
      } else {
        console.log(
          `[pipeline] --resume given but no state.json found — starting fresh.`,
        );
      }
    }

    /* (5) Stage 0 — map. */
    let scope: ScopeDoc;
    if (resuming && state && state.stage0 === 'done') {
      console.log(`[pipeline] Stage 0 already done — loading scope.json`);
      scope = JSON.parse(
        fs.readFileSync(path.join(config.runDir, 'scope.json'), 'utf8'),
      ) as ScopeDoc;
    } else {
      console.log(`[pipeline] Stage 0 — mapping repo...`);
      scope = await runStage0(config, gemini);
      console.log(
        `[pipeline] Stage 0 done — ${scope.pages.length} page(s), ` +
          `${scope.brokenContracts.length} broken contract(s).`,
      );
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

    /* (7) Stage 0.5 — boot gate. Always re-run, even on resume: scratch (with
       node_modules AND the running dev server) is deleted at the end of every
       run, so a cached boot.json baseUrl from a prior run points at a server
       that no longer exists. */
    console.log(`[pipeline] Stage 0.5 — boot gate...`);
    const boot = await runBootGate(config);
    console.log(
      `[pipeline] boot status: ${boot.status}` +
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
        `[pipeline] auth-aware auditing enabled — ${config.auth.roles.length} ` +
          `role(s); gated routes audited logged in.`,
      );
    }
    devServerPid = boot.pid;
    state.stage0_5 = 'done';
    saveState(config.runDir, state);

    /* (8) Per-run branch in 'pr' mode. */
    const branch = `rebuild-pipeline/${runStamp()}`;
    if (config.applyMode === 'pr') {
      console.log(`[pipeline] creating run branch ${branch}`);
      try {
        await createRunBranch(config.workDir, branch);
      } catch (err) {
        extraAlerts.push(
          `Could not create run branch ${branch}: ${errMsg(err)}. ` +
            `Changes applied on the current branch instead.`,
        );
        console.error(`[pipeline] branch creation failed: ${errMsg(err)}`);
      }
    }

    /* (9) PER-PAGE FAN-OUT. */
    console.log(
      `[pipeline] fan-out: ${scope.pages.length} page(s), ` +
        `concurrency ${config.concurrency}.`,
    );
    const pageEntries: PageManifestEntry[] = [];

    const processPage = async (page: PageScope): Promise<void> => {
      const pageState: PageState =
        state!.pages[page.slug] ??
        (state!.pages[page.slug] = { slug: page.slug, agents: freshAgentMap() });

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
      };

      // Checkpoint helper — marks an agent's status and persists state.
      const mark = (agent: AgentName, status: StepStatus): void => {
        pageState.agents[agent] = status;
        saveState(config.runDir, state!);
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
        mark(agent, 'running');
        try {
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

      // DAG: audit → (ux → design); compliance ∥ that chain; then code; then verify.
      const auditChain = (async () => {
        ctx.audit = (await runAgent('audit', () => runAudit(ctx))) ?? ctx.audit;
        ctx.ux = (await runAgent('ux', () => runUx(ctx))) ?? ctx.ux;
        ctx.design = (await runAgent('design', () => runDesign(ctx))) ?? ctx.design;
      })();
      const complianceChain = (async () => {
        ctx.compliance =
          (await runAgent('compliance', () => runCompliance(ctx))) ?? ctx.compliance;
      })();
      await Promise.all([auditChain, complianceChain]);

      // 'review' mode stops at the four review agents: no code, no verify —
      // the operator approves proposed-changes.md before any apply pass.
      let verify: VerifyResult | undefined;
      if (config.applyMode !== 'review') {
        ctx.code = (await runAgent('code', () => runCode(ctx))) ?? ctx.code;
        verify = await runAgent('verify', () => runVerify(ctx));
      } else {
        mark('code', 'skipped');
        mark('verify', 'skipped');
      }

      // Pass: in review mode = all four review agents completed; otherwise =
      // Agent 5's verdict (or the resumed checkpoint).
      const reviewAgents: AgentName[] = ['audit', 'ux', 'design', 'compliance'];
      const pass =
        config.applyMode === 'review'
          ? reviewAgents.every((a) => pageState.agents[a] === 'done')
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
        console.error(`[pipeline] page "${page.slug}" aborted — pool continues.`);
      }
    });

    // Keep manifest page order stable (mapped order, not completion order).
    const orderedEntries: PageManifestEntry[] = scope.pages
      .map((p) => pageEntries.find((e) => e.slug === p.slug))
      .filter((e): e is PageManifestEntry => Boolean(e));

    /* (10) Commit + PR in 'pr' mode. */
    let prUrl: string | undefined;
    if (config.applyMode === 'pr') {
      const passCount = orderedEntries.filter((e) => e.pass).length;
      const commitMsg =
        `rebuild-pipeline: ${passCount}/${orderedEntries.length} pages passing`;
      try {
        console.log(`[pipeline] committing changes...`);
        await commitAll(config.workDir, commitMsg);
        console.log(`[pipeline] opening PR...`);
        const url = await openPr(
          config.workDir,
          branch,
          `rebuild-pipeline run — ${config.projectSlug}`,
          buildPrBody(config, orderedEntries),
        );
        prUrl = url || undefined;
        console.log(
          prUrl ? `[pipeline] PR: ${prUrl}` : `[pipeline] no GitHub remote — PR skipped.`,
        );
      } catch (err) {
        extraAlerts.push(`Commit/PR step failed: ${errMsg(err)}`);
        console.error(`[pipeline] commit/PR failed: ${errMsg(err)}`);
      }
    } else if (config.applyMode === 'review') {
      console.log(
        `[pipeline] review mode — no code generated; proposed-changes.md only.`,
      );
    } else {
      console.log(`[pipeline] propose mode — diffs only, no commit/PR.`);
    }

    /* (11) Test scaffold. Skipped in review mode — a review pass applies no
       code and (under --real-env) must not seed accounts into a real backend. */
    let testUsers: TestUser[] = [];
    if (config.applyMode === 'review') {
      state.testScaffold = 'skipped';
      saveState(config.runDir, state);
      console.log(`[pipeline] review mode — test scaffold skipped.`);
    } else if (
      resuming &&
      state.testScaffold === 'done' &&
      usersJsonExists(config.runDir)
    ) {
      console.log(`[pipeline] test scaffold already done — loading users.json`);
      testUsers = JSON.parse(
        fs.readFileSync(
          path.join(config.runDir, 'test-scaffold', 'users.json'),
          'utf8',
        ),
      ) as TestUser[];
    } else {
      console.log(`[pipeline] building test scaffold...`);
      state.testScaffold = 'running';
      saveState(config.runDir, state);
      try {
        testUsers = await runTestScaffold(config, scope, boot, gemini);
        state.testScaffold = 'done';
        console.log(`[pipeline] test scaffold: ${testUsers.length} test user(s).`);
      } catch (err) {
        state.testScaffold = 'failed';
        extraAlerts.push(`Test scaffold failed: ${errMsg(err)}`);
        console.error(`[pipeline] test scaffold failed: ${errMsg(err)}`);
      }
      saveState(config.runDir, state);
    }

    /* (11.5) Review mode — write the consolidated proposed-changes.md gate. */
    if (config.applyMode === 'review') {
      try {
        const pcPath = writeProposedChanges(config, scope);
        console.log(`[pipeline] proposed changes written: ${pcPath}`);
        extraAlerts.push(
          `Review pass complete — read & approve ${pcPath}, then apply with: ` +
            `rebuild ${config.target} --resume ${config.runDir} --apply-mode pr`,
        );
      } catch (err) {
        extraAlerts.push(`Failed to write proposed-changes.md: ${errMsg(err)}`);
        console.error(`[pipeline] proposed-changes.md failed: ${errMsg(err)}`);
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
      `\n[pipeline] run complete — ${orderedEntries.filter((e) => e.pass).length}/` +
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
        console.log(`[pipeline] scratch cleaned (finally).`);
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
      `[pipeline] brand: PINNED "${pinned.name}" — Agent 3 is deterministic.`,
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
  console.warn(`\n[pipeline] ⚠ ${notice}\n`);
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
      `[pipeline] ⚠ no constraints file found — Agent 6 runs with 0 rules.`,
    );
  }

  fs.writeFileSync(resolvedPath, JSON.stringify(constraints, null, 2), 'utf8');
  console.log(
    `[pipeline] constraints: "${constraints.project}" — ` +
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
  } catch {
    /* best-effort — a dead pid is fine */
  }
}

/** Cleanup wrapper that never throws — safe for finally + failure paths. */
async function safeCleanup(config: PipelineConfig): Promise<boolean> {
  try {
    return await cleanupScratch(config);
  } catch (err) {
    console.error(`[pipeline] scratch cleanup failed: ${errMsg(err)}`);
    return false;
  }
}

function usersJsonExists(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, 'test-scaffold', 'users.json'));
}

function buildPrBody(
  config: PipelineConfig,
  entries: PageManifestEntry[],
): string {
  const passCount = entries.filter((e) => e.pass).length;
  const lines = [
    `Automated rebuild by **rebuild-pipeline** for \`${config.target}\`.`,
    '',
    `**${passCount}/${entries.length} pages passing.**`,
    '',
    '| Page | Route | Pass | Gaps found | Gaps closed | Compliance findings |',
    '| ---- | ----- | ---- | ---------- | ----------- | ------------------- |',
  ];
  for (const e of entries) {
    lines.push(
      `| ${e.slug} | ${e.route} | ${e.pass ? '✅' : '❌'} | ` +
        `${e.gapsFound} | ${e.gapsClosed} | ${e.complianceFindings} |`,
    );
  }
  lines.push('', '_Generated by rebuild-pipeline. Review every diff before merge._');
  return lines.join('\n');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
