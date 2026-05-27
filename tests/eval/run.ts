/**
 * Reframe fixture eval — runs each fixture's `assertions` block against
 * either:
 *
 *  - DEFAULT MODE (no flag): the fixture's own `expected` block. This is
 *    a self-consistency check that catches contradictions where an
 *    assertion claims a property the expected output doesn't satisfy.
 *    Free, deterministic, and runs in CI on every PR.
 *
 *  - LIVE MODE (`--live`): the actual production agent prompt against a
 *    real LLM, with the response normalized through the agent's real
 *    normalize function. Costs API tokens; non-deterministic; reveals
 *    cross-provider drift. Use to validate that a prompt change still
 *    produces output the fixture's assertions accept.
 *
 *   npm run eval                                # self-consistency
 *   npm run eval -- --live                      # live, default provider (gemini)
 *   npm run eval -- --live --provider anthropic # live, claude
 *
 * Live mode skips fixtures gracefully when the required API key isn't
 * set so default `npm run eval` invocations don't have to know which
 * provider to set up.
 *
 * Exits 0 if every assertion across every fixture passes, 1 otherwise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AUDIT_SYSTEM_INSTRUCTION,
  buildAuditPrompt,
  normaliseGap,
} from '../../src/agents/agent1-audit';
import {
  COMPLIANCE_SYSTEM_INSTRUCTION,
  buildCompliancePrompt,
  normaliseComplianceFinding,
} from '../../src/agents/agent6-compliance';
import { GeminiClient } from '../../src/gemini';
import {
  AuditOutputSchema,
  ComplianceOutputSchema,
} from '../../src/schemas/agent-outputs';
import type {
  AgentContext,
  BrandSpec,
  ComplianceFinding,
  ConstraintRule,
  Gap,
  PipelineConfig,
} from '../../src/types';

/* ─────────────────────────── shape contracts ─────────────────────────── */

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

type AgentName = 'audit' | 'compliance';

interface Assertion {
  kind: string;
  id?: string;
  path?: string;
  value?: unknown;
  values?: unknown[];
}

interface Fixture {
  name: string;
  agent: AgentName;
  description: string;
  input: unknown;
  expected: Record<string, unknown>;
  assertions?: Assertion[];
}

/* ─────────────────────────── finding lookup ─────────────────────────── */

/**
 * Resolve a finding by id within the agent-shaped output. For audit
 * fixtures the id is `gap.id`; for compliance it's `finding.ruleId`.
 * The special id "any" returns the first finding (used when the
 * assertion only cares that *some* finding exhibits the property).
 */
function findFinding(
  output: Record<string, unknown>,
  agent: AgentName,
  id: string | undefined,
): Record<string, unknown> | null {
  const all = getAllFindings(output, agent);
  if (id === undefined || id === 'any') return all[0] ?? null;
  if (agent === 'audit') {
    return all.find((g) => g.id === id) ?? null;
  }
  // compliance
  return all.find((f) => f.ruleId === id) ?? null;
}

function getAllFindings(
  output: Record<string, unknown>,
  agent: AgentName,
): Array<Record<string, unknown>> {
  if (agent === 'audit') {
    return Array.isArray(output.gaps)
      ? (output.gaps as Array<Record<string, unknown>>)
      : [];
  }
  return Array.isArray(output.findings)
    ? (output.findings as Array<Record<string, unknown>>)
    : [];
}

/** Concatenated lower-cased text fields used by the `mentionsAny` assertion. */
function combinedText(finding: Record<string, unknown>): string {
  const fields = ['description', 'plain', 'whyItMatters', 'recommendation', 'problem', 'requiredFix'];
  return fields
    .map((f) => (typeof finding[f] === 'string' ? (finding[f] as string) : ''))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/* ─────────────────────────── per-assertion evaluation ─────────────────────────── */

interface AssertionResult {
  pass: boolean;
  reason?: string;
}

function evalAssertion(
  a: Assertion,
  output: Record<string, unknown>,
  agent: AgentName,
): AssertionResult {
  const all = getAllFindings(output, agent);

  switch (a.kind) {
    case 'minFindings': {
      const ok = all.length >= (a.value as number);
      return ok
        ? { pass: true }
        : { pass: false, reason: `expected >= ${a.value} finding(s), got ${all.length}` };
    }

    case 'maxFindings': {
      const ok = all.length <= (a.value as number);
      return ok
        ? { pass: true }
        : { pass: false, reason: `expected <= ${a.value} finding(s), got ${all.length}` };
    }

    case 'noFindings': {
      const ok = all.length === 0;
      return ok
        ? { pass: true }
        : { pass: false, reason: `expected zero findings, got ${all.length}` };
    }

    case 'severityAtLeast': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found in expected output` };
      const actual = SEVERITY_RANK[finding.severity as string] ?? 0;
      const required = SEVERITY_RANK[a.value as string] ?? 0;
      const ok = actual >= required;
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id} severity is "${finding.severity}" (rank ${actual}) — required >= "${a.value}" (rank ${required})` };
    }

    case 'severityEquals': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found` };
      const ok = finding.severity === a.value;
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id} severity is "${finding.severity}" — expected exactly "${a.value}"` };
    }

    case 'categoryEquals': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found` };
      const ok = finding.category === a.value;
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id} category is "${finding.category}" — expected "${a.value}"` };
    }

    case 'dimensionIn': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found` };
      const allowed = a.values as string[];
      const actual = finding.dimension as string | undefined;
      const ok = actual !== undefined && allowed.includes(actual);
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id} dimension is ${actual ? `"${actual}"` : '(missing)'} — expected one of [${allowed.join(', ')}]` };
    }

    case 'fieldPresent': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found` };
      const value = finding[a.path as string];
      const ok =
        value !== undefined &&
        value !== null &&
        !(typeof value === 'string' && value.trim() === '');
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id}.${a.path} is missing, null, or empty` };
    }

    case 'confidenceAtLeast': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found` };
      const conf = typeof finding.confidence === 'number' ? finding.confidence : 0;
      const required = a.value as number;
      const ok = conf >= required;
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id} confidence is ${conf} — required >= ${required}` };
    }

    case 'mentionsAny': {
      const finding = findFinding(output, agent, a.id);
      if (!finding) return { pass: false, reason: `finding "${a.id}" not found` };
      const text = combinedText(finding);
      const needles = (a.values as string[]).map((v) => v.toLowerCase());
      const ok = needles.some((n) => text.includes(n));
      return ok
        ? { pass: true }
        : { pass: false, reason: `${a.id} text mentions none of [${(a.values as string[]).join(', ')}]` };
    }
  }

  return { pass: false, reason: `unknown assertion kind: "${a.kind}"` };
}

/* ─────────────────────────── per-fixture evaluation ─────────────────────────── */

interface FixtureResult {
  name: string;
  agent: AgentName;
  total: number;
  passed: number;
  failures: Array<{ assertion: Assertion; reason: string }>;
}

function evalFixture(fixture: Fixture): FixtureResult {
  const assertions = fixture.assertions ?? [];
  const failures: FixtureResult['failures'] = [];
  let passed = 0;
  for (const a of assertions) {
    const result = evalAssertion(a, fixture.expected, fixture.agent);
    if (result.pass) {
      passed++;
    } else {
      failures.push({ assertion: a, reason: result.reason ?? 'unknown failure' });
    }
  }
  return {
    name: fixture.name,
    agent: fixture.agent,
    total: assertions.length,
    passed,
    failures,
  };
}

/* ─────────────────────────── runner ─────────────────────────── */

function loadFixtures(rootDir: string): Fixture[] {
  const out: Fixture[] = [];
  for (const agent of ['audit', 'compliance'] as AgentName[]) {
    const agentDir = path.join(rootDir, agent);
    if (!fs.existsSync(agentDir)) continue;
    for (const entry of fs.readdirSync(agentDir).sort()) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(agentDir, entry);
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
        out.push(raw);
      } catch (err) {
        console.error(`[eval] could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return out;
}

/* ─────────────────────────── live-LLM mode ─────────────────────────── */

/**
 * Build a minimal PipelineConfig sufficient for the GeminiClient + the
 * exported prompt-builders. The browser, scratch, workDir, runDir paths
 * are unused on this code path (we never drive a browser or write to a
 * runDir in eval mode) so they're left as empty strings.
 */
function buildEvalConfig(provider: string): PipelineConfig {
  const modelsPath = path.resolve(__dirname, '..', '..', 'config', 'models.json');
  const modelsRaw = fs.readFileSync(modelsPath, 'utf8');
  const models = JSON.parse(modelsRaw);

  const keyForProvider: Record<string, string | undefined> = {
    gemini: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    'openai-compatible': process.env.OPENAI_API_KEY,
  };
  const apiKey = keyForProvider[provider] ?? '';

  return {
    target: '<eval>',
    isLocalPath: true,
    projectSlug: 'eval',
    scratchDir: '',
    workDir: '',
    runDir: '',
    concurrency: 1,
    applyMode: 'propose',
    realEnv: false,
    readOnlyExercise: true,
    models,
    brandPath: '',
    constraintsPath: '',
    geminiApiKey: apiKey,
    callTimeoutMs: 120000,
    maxRetries: 1,
    sampleParams: {},
    quickScan: false,
    llmProvider: provider,
    diffOnly: false,
    bootstrapOnly: false,
    postFindings: false,
  };
}

/**
 * Build a minimal AgentContext for the audit prompt — buildAuditPrompt
 * only reads ctx.page and ctx.brand, so the rest are inert stubs.
 */
function buildAuditCtxFromFixture(
  fixture: Fixture,
  gemini: GeminiClient,
  config: PipelineConfig,
): AgentContext {
  const input = fixture.input as Record<string, unknown>;
  const fallbackBrand: BrandSpec = {
    name: 'eval',
    colors: {},
    typeScale: {},
    spacing: {},
    voice: 'Direct.',
    componentStyle: '',
    pinned: true,
  };
  return {
    config,
    page: input.page as AgentContext['page'],
    scope: {
      productGoal: '',
      pages: [],
      dbTables: [],
      dataCalls: [],
      componentInventory: [],
      libraryInventory: [],
      brokenContracts: [],
      bootstrappedBrand: fallbackBrand,
    },
    brand: (input.brand as BrandSpec | undefined) ?? fallbackBrand,
    constraints: { project: '', rules: [] },
    boot: { status: 'running', baseUrl: 'http://eval', installLog: '', bootLog: '', stubbedIntegrations: [] },
    gemini,
    pageDir: '<eval>',
  };
}

interface LiveResult {
  output: Record<string, unknown>;
  durationMs: number;
}

async function runLiveAudit(fixture: Fixture, gemini: GeminiClient, config: PipelineConfig): Promise<LiveResult> {
  const ctx = buildAuditCtxFromFixture(fixture, gemini, config);
  const input = fixture.input as Record<string, unknown>;
  const snapshot = (input.snapshot as string) ?? '';
  const interactions = (input.interactions as string[]) ?? [];
  const consoleErrors = (input.consoleErrors as string[]) ?? [];
  const health = input.health as AgentContext['audit'] extends infer T ? T : undefined;

  const t0 = Date.now();
  const response = await gemini.callJsonSchema(AuditOutputSchema, {
    role: 'agent1_audit',
    systemInstruction: AUDIT_SYSTEM_INSTRUCTION,
    prompt: buildAuditPrompt(ctx, snapshot, interactions, consoleErrors, health as any),
    json: true,
  });
  const gaps: Gap[] = (response.gaps ?? []).map((g: any, i: number) => normaliseGap(g, i));
  return { output: { gaps }, durationMs: Date.now() - t0 };
}

async function runLiveCompliance(fixture: Fixture, gemini: GeminiClient): Promise<LiveResult> {
  const input = fixture.input as Record<string, unknown>;
  const page = input.page as { slug: string; route?: string; purpose?: string; userFunction?: string; filePath?: string };
  const matchedRules = (input.matchedRules as ConstraintRule[]) ?? [];
  const source = (input.source as string) ?? '';
  const filePath = page.filePath ?? '(unknown)';

  const t0 = Date.now();
  const response = await gemini.callJsonSchema(ComplianceOutputSchema, {
    role: 'agent6_compliance',
    systemInstruction: COMPLIANCE_SYSTEM_INSTRUCTION,
    prompt: buildCompliancePrompt(
      page.route || page.slug,
      page.purpose ?? '',
      page.userFunction ?? '',
      filePath,
      matchedRules,
      source,
    ),
    json: true,
  });
  const validIds = new Set(matchedRules.map((r) => r.id));
  const rawFindings = response.findings ?? [];
  const findings: ComplianceFinding[] = rawFindings
    .map((f: NonNullable<typeof rawFindings>[number]) =>
      normaliseComplianceFinding(f, matchedRules, filePath),
    )
    .filter((f: ComplianceFinding) => f.ruleId === 'unknown' || validIds.has(f.ruleId))
    .filter((f: ComplianceFinding) => f.problem !== '');
  return { output: { findings }, durationMs: Date.now() - t0 };
}

/* ─────────────────────────── runner ─────────────────────────── */

interface CliOptions {
  live: boolean;
  provider: string;
}

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { live: false, provider: 'gemini' };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--live') out.live = true;
    else if (tok === '--provider') {
      const v = argv[i + 1];
      if (!v) throw new Error('--provider requires a value');
      out.provider = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  // Fixtures live in tests/fixtures/ — one level up from tests/eval/.
  const fixturesRoot = path.resolve(__dirname, '..', 'fixtures');
  const fixtures = loadFixtures(fixturesRoot);

  if (fixtures.length === 0) {
    console.error(`[eval] no fixtures found under ${fixturesRoot}/<agent>/*.json`);
    return 1;
  }

  let results: FixtureResult[];
  let modeLabel: string;
  let totalLiveMs = 0;
  let skipped = 0;

  if (opts.live) {
    const config = buildEvalConfig(opts.provider);
    if (!config.geminiApiKey) {
      console.error(
        `[eval] --live --provider ${opts.provider}: no API key set in the env. ` +
          `Set GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY per provider.`,
      );
      return 1;
    }
    const gemini = new GeminiClient(config);
    modeLabel = `live · provider=${opts.provider}`;
    results = [];
    for (const fixture of fixtures) {
      try {
        let live: LiveResult;
        if (fixture.agent === 'audit') {
          live = await runLiveAudit(fixture, gemini, config);
        } else {
          live = await runLiveCompliance(fixture, gemini);
        }
        totalLiveMs += live.durationMs;
        results.push(evalFixtureAgainstOutput(fixture, live.output));
      } catch (err) {
        skipped++;
        console.error(
          `[eval] live call failed for ${fixture.agent}/${fixture.name}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        results.push({
          name: fixture.name,
          agent: fixture.agent,
          total: fixture.assertions?.length ?? 0,
          passed: 0,
          failures: [
            {
              assertion: { kind: 'liveCall' },
              reason: `live call threw: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        });
      }
    }
  } else {
    modeLabel = 'self-consistency · expected vs assertions';
    results = fixtures.map(evalFixture);
  }

  const totalAssertions = results.reduce((n, r) => n + r.total, 0);
  const totalPassed = results.reduce((n, r) => n + r.passed, 0);
  const failedFixtures = results.filter((r) => r.failures.length > 0);

  const perAgent: Record<string, number> = {};
  for (const r of results) perAgent[r.agent] = (perAgent[r.agent] ?? 0) + 1;
  const totals = Object.entries(perAgent)
    .map(([a, n]) => `${a}: ${n}`)
    .join(', ');
  const tail = opts.live
    ? ` · ${(totalLiveMs / 1000).toFixed(1)}s of LLM time` + (skipped > 0 ? ` · ${skipped} live call(s) threw` : '')
    : '';

  if (failedFixtures.length === 0) {
    console.log(
      `[eval · ${modeLabel}] OK — ${totalPassed}/${totalAssertions} assertion(s) passed across ` +
        `${fixtures.length} fixture(s) (${totals})${tail}.`,
    );
    return 0;
  }

  console.error(
    `[eval · ${modeLabel}] FAIL — ${totalAssertions - totalPassed} assertion(s) failed across ` +
      `${failedFixtures.length} of ${fixtures.length} fixture(s)${tail}:\n`,
  );
  for (const r of failedFixtures) {
    console.error(`  ${r.agent}/${r.name}  (${r.passed}/${r.total} passed)`);
    for (const f of r.failures) {
      const tag = f.assertion.id ? `[${f.assertion.kind} on ${f.assertion.id}]` : `[${f.assertion.kind}]`;
      console.error(`    ✗ ${tag} ${f.reason}`);
    }
  }
  return 1;
}

/** Evaluate assertions against a supplied output (instead of fixture.expected). */
function evalFixtureAgainstOutput(fixture: Fixture, output: Record<string, unknown>): FixtureResult {
  const assertions = fixture.assertions ?? [];
  const failures: FixtureResult['failures'] = [];
  let passed = 0;
  for (const a of assertions) {
    const result = evalAssertion(a, output, fixture.agent);
    if (result.pass) {
      passed++;
    } else {
      failures.push({ assertion: a, reason: result.reason ?? 'unknown failure' });
    }
  }
  return {
    name: fixture.name,
    agent: fixture.agent,
    total: assertions.length,
    passed,
    failures,
  };
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`[eval] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
