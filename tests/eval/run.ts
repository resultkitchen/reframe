/**
 * Reframe fixture eval — runs each fixture's `assertions` block against its
 * `expected` agent output. Catches contradictions (e.g. an assertion that
 * claims a finding has plain text when `expected` has no `plain` field) and
 * regressions when the assertion vocabulary is extended or its semantics
 * change.
 *
 *   npm run eval
 *
 * What it IS (v1):
 *  - A self-consistency check across the fixture suite.
 *  - The assertion engine the v2 live-LLM eval will reuse verbatim — same
 *    rules, same outputs, just fed real agent calls instead of `expected`.
 *
 * What it ISN'T (yet):
 *  - A live-LLM eval. Adding `--live` later will: build a minimal
 *    AgentContext, swap in the real GeminiClient, call the agent, then
 *    feed the real output through the same evaluateAssertion path below.
 *    Until then, this harness exercises the assertion machinery and
 *    catches the case where someone wrote assertions that don't actually
 *    pass against their own expected output.
 *
 * Exits 0 if every assertion across every fixture passes, 1 otherwise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

function main(): number {
  // Fixtures live in tests/fixtures/ — one level up from tests/eval/.
  const fixturesRoot = path.resolve(__dirname, '..', 'fixtures');
  const fixtures = loadFixtures(fixturesRoot);

  if (fixtures.length === 0) {
    console.error(`[eval] no fixtures found under ${fixturesRoot}/<agent>/*.json`);
    return 1;
  }

  const results = fixtures.map(evalFixture);

  const totalAssertions = results.reduce((n, r) => n + r.total, 0);
  const totalPassed = results.reduce((n, r) => n + r.passed, 0);
  const failedFixtures = results.filter((r) => r.failures.length > 0);

  if (failedFixtures.length === 0) {
    const perAgent: Record<string, number> = {};
    for (const r of results) perAgent[r.agent] = (perAgent[r.agent] ?? 0) + 1;
    const totals = Object.entries(perAgent)
      .map(([a, n]) => `${a}: ${n}`)
      .join(', ');
    console.log(
      `[eval] OK — ${totalPassed}/${totalAssertions} assertion(s) passed across ` +
        `${fixtures.length} fixture(s) (${totals}).`,
    );
    return 0;
  }

  console.error(
    `[eval] FAIL — ${totalAssertions - totalPassed} assertion(s) failed across ` +
      `${failedFixtures.length} of ${fixtures.length} fixture(s):\n`,
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

process.exit(main());
