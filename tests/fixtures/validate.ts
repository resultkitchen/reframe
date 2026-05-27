/**
 * Structural validator for tests/fixtures/<agent>/*.json.
 *
 * This is the v1 fixture sanity check: it confirms every fixture has the
 * required shape, points to a known agent, and that its `assertions` block
 * uses recognized assertion kinds with the right field set. It does NOT
 * call any LLM, run any agent, or score outputs against a model.
 *
 * Run with: `npm run check-fixtures`
 *
 * When v2 builds a real eval harness, that harness will reuse this same
 * fixture format — and the harness's correctness checks become assertions
 * the operator can add to fixtures without changing the runner.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/* ─────────────────────────── shape contracts ─────────────────────────── */

const KNOWN_AGENTS = ['audit', 'compliance'] as const;
type KnownAgent = (typeof KNOWN_AGENTS)[number];

const KNOWN_ASSERTION_KINDS = [
  'minFindings',
  'maxFindings',
  'noFindings',
  'severityAtLeast',
  'severityEquals',
  'categoryEquals',
  'dimensionIn',
  'fieldPresent',
  'confidenceAtLeast',
  'mentionsAny',
] as const;
type AssertionKind = (typeof KNOWN_ASSERTION_KINDS)[number];

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const VALID_CATEGORIES = ['functional', 'ux'] as const;

interface Assertion {
  kind: AssertionKind;
  id?: string;
  path?: string;
  value?: unknown;
  values?: unknown[];
}

interface Fixture {
  name: string;
  agent: KnownAgent;
  description: string;
  input: unknown;
  expected: unknown;
  assertions?: Assertion[];
}

/* ─────────────────────────── error reporting ─────────────────────────── */

interface FixtureError {
  file: string;
  problem: string;
}

const errors: FixtureError[] = [];

function fail(file: string, problem: string): void {
  errors.push({ file, problem });
}

/* ─────────────────────────── per-assertion validation ─────────────────────────── */

function validateAssertion(file: string, agent: KnownAgent, idx: number, a: unknown): void {
  const where = `assertions[${idx}]`;
  if (!a || typeof a !== 'object') {
    return fail(file, `${where}: must be an object`);
  }
  const obj = a as Partial<Assertion>;
  if (typeof obj.kind !== 'string') {
    return fail(file, `${where}: missing "kind"`);
  }
  if (!(KNOWN_ASSERTION_KINDS as readonly string[]).includes(obj.kind)) {
    return fail(
      file,
      `${where}: unknown assertion kind "${obj.kind}". Allowed: ${KNOWN_ASSERTION_KINDS.join(', ')}`,
    );
  }

  switch (obj.kind as AssertionKind) {
    case 'minFindings':
    case 'maxFindings':
      if (typeof obj.value !== 'number' || obj.value < 0) {
        fail(file, `${where} (${obj.kind}): "value" must be a non-negative number`);
      }
      break;

    case 'noFindings':
      // No additional fields required.
      break;

    case 'severityAtLeast':
    case 'severityEquals':
      if (typeof obj.id !== 'string' || obj.id === '') {
        fail(file, `${where} (${obj.kind}): "id" is required`);
      }
      if (typeof obj.value !== 'string' || !(VALID_SEVERITIES as readonly string[]).includes(obj.value)) {
        fail(
          file,
          `${where} (${obj.kind}): "value" must be one of ${VALID_SEVERITIES.join(', ')}`,
        );
      }
      break;

    case 'categoryEquals':
      if (agent !== 'audit') {
        fail(file, `${where} (categoryEquals): only valid for agent "audit"`);
      }
      if (typeof obj.value !== 'string' || !(VALID_CATEGORIES as readonly string[]).includes(obj.value)) {
        fail(
          file,
          `${where} (categoryEquals): "value" must be one of ${VALID_CATEGORIES.join(', ')}`,
        );
      }
      break;

    case 'dimensionIn':
      if (!Array.isArray(obj.values) || obj.values.length === 0) {
        fail(file, `${where} (dimensionIn): "values" must be a non-empty array of strings`);
      } else if (!obj.values.every((v) => typeof v === 'string')) {
        fail(file, `${where} (dimensionIn): every entry of "values" must be a string`);
      }
      break;

    case 'fieldPresent':
      if (typeof obj.path !== 'string' || obj.path === '') {
        fail(file, `${where} (fieldPresent): "path" is required`);
      }
      break;

    case 'confidenceAtLeast':
      if (typeof obj.value !== 'number' || obj.value < 0 || obj.value > 1) {
        fail(file, `${where} (confidenceAtLeast): "value" must be a number in [0, 1]`);
      }
      break;

    case 'mentionsAny':
      if (!Array.isArray(obj.values) || obj.values.length === 0) {
        fail(file, `${where} (mentionsAny): "values" must be a non-empty array of strings`);
      } else if (!obj.values.every((v) => typeof v === 'string')) {
        fail(file, `${where} (mentionsAny): every entry of "values" must be a string`);
      }
      break;
  }
}

/* ─────────────────────────── per-agent expected validation ─────────────────────────── */

function validateAuditExpected(file: string, expected: unknown): void {
  if (!expected || typeof expected !== 'object') {
    return fail(file, `"expected" must be an object`);
  }
  const exp = expected as { gaps?: unknown };
  if (!Array.isArray(exp.gaps)) {
    return fail(file, `"expected.gaps" must be an array (use [] for clean fixtures)`);
  }
  exp.gaps.forEach((g, i) => {
    if (!g || typeof g !== 'object') {
      return fail(file, `expected.gaps[${i}] must be an object`);
    }
    const gap = g as Record<string, unknown>;
    for (const required of ['id', 'category', 'severity', 'description', 'recommendation']) {
      if (typeof gap[required] !== 'string' || (gap[required] as string) === '') {
        fail(file, `expected.gaps[${i}] missing required string field "${required}"`);
      }
    }
    if (typeof gap.severity === 'string' && !(VALID_SEVERITIES as readonly string[]).includes(gap.severity)) {
      fail(file, `expected.gaps[${i}].severity must be one of ${VALID_SEVERITIES.join(', ')}`);
    }
    if (typeof gap.category === 'string' && !(VALID_CATEGORIES as readonly string[]).includes(gap.category)) {
      fail(file, `expected.gaps[${i}].category must be one of ${VALID_CATEGORIES.join(', ')}`);
    }
    if (gap.confidence !== undefined) {
      if (typeof gap.confidence !== 'number' || gap.confidence < 0 || gap.confidence > 1) {
        fail(file, `expected.gaps[${i}].confidence must be a number in [0, 1]`);
      }
    }
  });
}

function validateComplianceExpected(file: string, expected: unknown): void {
  if (!expected || typeof expected !== 'object') {
    return fail(file, `"expected" must be an object`);
  }
  const exp = expected as { findings?: unknown };
  if (!Array.isArray(exp.findings)) {
    return fail(file, `"expected.findings" must be an array (use [] for clean fixtures)`);
  }
  exp.findings.forEach((f, i) => {
    if (!f || typeof f !== 'object') {
      return fail(file, `expected.findings[${i}] must be an object`);
    }
    const finding = f as Record<string, unknown>;
    for (const required of ['ruleId', 'domain', 'severity', 'location', 'problem', 'requiredFix']) {
      if (typeof finding[required] !== 'string' || (finding[required] as string) === '') {
        fail(file, `expected.findings[${i}] missing required string field "${required}"`);
      }
    }
    if (typeof finding.severity === 'string' && !(VALID_SEVERITIES as readonly string[]).includes(finding.severity)) {
      fail(file, `expected.findings[${i}].severity must be one of ${VALID_SEVERITIES.join(', ')}`);
    }
    if (finding.confidence !== undefined) {
      if (typeof finding.confidence !== 'number' || finding.confidence < 0 || finding.confidence > 1) {
        fail(file, `expected.findings[${i}].confidence must be a number in [0, 1]`);
      }
    }
  });
}

/* ─────────────────────────── top-level fixture validation ─────────────────────────── */

function validateFixture(file: string, raw: unknown): KnownAgent | null {
  if (!raw || typeof raw !== 'object') {
    fail(file, 'fixture must be a JSON object');
    return null;
  }
  const f = raw as Partial<Fixture>;

  for (const required of ['name', 'agent', 'description'] as const) {
    if (typeof f[required] !== 'string' || (f[required] as string) === '') {
      fail(file, `missing required string field "${required}"`);
    }
  }
  if (f.input === undefined) fail(file, 'missing "input"');
  if (f.expected === undefined) fail(file, 'missing "expected"');

  const agent = f.agent;
  if (typeof agent !== 'string' || !(KNOWN_AGENTS as readonly string[]).includes(agent)) {
    fail(file, `"agent" must be one of ${KNOWN_AGENTS.join(', ')}`);
    return null;
  }

  // The fixture's directory should match its declared agent so files don't
  // get filed under the wrong agent by accident.
  const parent = path.basename(path.dirname(file));
  if (parent !== agent) {
    fail(file, `fixture declares agent "${agent}" but lives under tests/fixtures/${parent}/`);
  }

  if (agent === 'audit') validateAuditExpected(file, f.expected);
  if (agent === 'compliance') validateComplianceExpected(file, f.expected);

  if (f.assertions !== undefined) {
    if (!Array.isArray(f.assertions)) {
      fail(file, '"assertions" must be an array');
    } else {
      f.assertions.forEach((a, i) => validateAssertion(file, agent as KnownAgent, i, a));
    }
  }

  return agent as KnownAgent;
}

/* ─────────────────────────── runner ─────────────────────────── */

function findFixtureFiles(rootDir: string): string[] {
  const out: string[] = [];
  for (const agent of KNOWN_AGENTS) {
    const agentDir = path.join(rootDir, agent);
    if (!fs.existsSync(agentDir)) continue;
    for (const entry of fs.readdirSync(agentDir)) {
      if (entry.endsWith('.json')) out.push(path.join(agentDir, entry));
    }
  }
  return out.sort();
}

function main(): number {
  const root = path.resolve(__dirname);
  const files = findFixtureFiles(root);

  if (files.length === 0) {
    console.error(`[check-fixtures] no fixtures found under ${root}/<agent>/*.json`);
    return 1;
  }

  const perAgent: Record<string, number> = {};
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail(file, `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const agent = validateFixture(file, raw);
    if (agent) {
      perAgent[agent] = (perAgent[agent] ?? 0) + 1;
    }
  }

  const ok = errors.length === 0;
  if (ok) {
    const totals = Object.entries(perAgent)
      .map(([a, n]) => `${a}: ${n}`)
      .join(', ');
    console.log(`[check-fixtures] OK — ${files.length} fixture(s) validated (${totals}).`);
    return 0;
  }

  console.error(`[check-fixtures] FAIL — ${errors.length} issue(s) across ${files.length} fixture file(s):\n`);
  for (const e of errors) {
    const rel = path.relative(process.cwd(), e.file);
    console.error(`  ${rel}\n    ${e.problem}\n`);
  }
  return 1;
}

process.exit(main());
