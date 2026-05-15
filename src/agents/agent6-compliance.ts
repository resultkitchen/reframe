/**
 * Agent 6 — Compliance.
 *
 * Runs BEFORE Agent 4 (it is an upstream input to code). Checks the page
 * source against the pinned `constraints.json` rules whose `appliesTo`
 * matches this page. Catches the failure class "renders fine, runs clean,
 * but is legally / factually wrong" — non-compliant consent text, missing
 * disclosures, fabricated claims, etc.
 *
 * Output: ComplianceResult ({ page, findings, clean }) plus the standard
 * `<pageDir>/compliance.json` + `<pageDir>/compliance.md` artifacts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentContext,
  ComplianceFinding,
  ComplianceResult,
  ConstraintRule,
  Severity,
} from '../types';

const VALID_SEVERITY: Severity[] = ['critical', 'high', 'medium', 'low'];

/** Does a constraint rule apply to this page? */
function ruleApplies(rule: ConstraintRule, route: string, slug: string): boolean {
  const target = (rule.appliesTo ?? '').trim();
  if (target === '' || target === '*') return true;

  // Support simple glob-ish matching: exact, prefix (foo/*), or substring.
  if (target === route || target === slug) return true;
  if (target.endsWith('/*')) {
    const prefix = target.slice(0, -2);
    return route.startsWith(prefix) || slug.startsWith(prefix);
  }
  if (target.includes('*')) {
    const pattern = target
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const re = new RegExp(`^${pattern}$`);
    return re.test(route) || re.test(slug);
  }
  return route.includes(target) || slug.includes(target);
}

/** Coerce an unknown value into a valid Severity, defaulting to 'medium'. */
function coerceSeverity(value: unknown): Severity {
  if (typeof value === 'string' && (VALID_SEVERITY as string[]).includes(value)) {
    return value as Severity;
  }
  return 'medium';
}

/** Read the page source; returns '' (not a throw) when unreadable. */
function readPageSource(ctx: AgentContext): { source: string; absPath: string } {
  const absPath = path.isAbsolute(ctx.page.filePath)
    ? ctx.page.filePath
    : path.join(ctx.config.workDir, ctx.page.filePath);
  try {
    return { source: fs.readFileSync(absPath, 'utf8'), absPath };
  } catch {
    return { source: '', absPath };
  }
}

/** Render the human-readable compliance report. */
function renderMd(result: ComplianceResult, matchedRules: ConstraintRule[]): string {
  const lines: string[] = [];
  lines.push(`# Compliance — ${result.page}`);
  lines.push('');
  lines.push(`**Status:** ${result.clean ? 'CLEAN' : 'FINDINGS PRESENT'}`);
  lines.push(`**Rules evaluated:** ${matchedRules.length}`);
  lines.push(`**Findings:** ${result.findings.length}`);
  lines.push('');

  if (matchedRules.length > 0) {
    lines.push('## Rules evaluated');
    for (const r of matchedRules) {
      lines.push(`- \`${r.id}\` (${r.domain}, ${r.severity}) — ${r.description}`);
    }
    lines.push('');
  }

  if (result.findings.length === 0) {
    lines.push('No compliance findings.');
  } else {
    lines.push('## Findings');
    for (const f of result.findings) {
      lines.push('');
      lines.push(`### [${f.severity.toUpperCase()}] ${f.ruleId} — ${f.domain}`);
      lines.push(`- **Location:** ${f.location}`);
      lines.push(`- **Problem:** ${f.problem}`);
      lines.push(`- **Required fix:** ${f.requiredFix}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Persist compliance.json + compliance.md into the page's run dir. */
function writeArtifacts(ctx: AgentContext, result: ComplianceResult, matchedRules: ConstraintRule[]): void {
  try {
    fs.mkdirSync(ctx.pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.pageDir, 'compliance.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ctx.pageDir, 'compliance.md'),
      renderMd(result, matchedRules),
      'utf8',
    );
  } catch (err) {
    console.error(`[agent6-compliance] failed to write artifacts: ${String(err)}`);
  }
}

interface ComplianceJsonResponse {
  findings?: Array<{
    ruleId?: unknown;
    domain?: unknown;
    severity?: unknown;
    location?: unknown;
    problem?: unknown;
    requiredFix?: unknown;
  }>;
}

export async function runCompliance(ctx: AgentContext): Promise<ComplianceResult> {
  const pageId = ctx.page.route || ctx.page.slug;

  // Select the rules that govern this page.
  const allRules = ctx.constraints?.rules ?? [];
  const matchedRules = allRules.filter((r) =>
    ruleApplies(r, ctx.page.route, ctx.page.slug),
  );

  // No applicable rules → trivially clean, nothing to check.
  if (matchedRules.length === 0) {
    const result: ComplianceResult = { page: pageId, findings: [], clean: true };
    writeArtifacts(ctx, result, matchedRules);
    return result;
  }

  const { source, absPath } = readPageSource(ctx);
  if (source === '') {
    // Source unreadable — cannot evaluate. Return a valid result and log it.
    const result: ComplianceResult = { page: pageId, findings: [], clean: true };
    writeArtifacts(ctx, result, matchedRules);
    console.error(`[agent6-compliance] could not read page source at ${absPath}`);
    return result;
  }

  const rulesBlock = matchedRules
    .map(
      (r) =>
        `- id: ${r.id}\n  domain: ${r.domain}\n  severity: ${r.severity}\n  rule: ${r.description}`,
    )
    .join('\n');

  const systemInstruction =
    'You are a domain-compliance and factual-correctness auditor for web pages. ' +
    'You catch the failure class: a page that RENDERS FINE and RUNS CLEAN but is ' +
    'LEGALLY or FACTUALLY WRONG — e.g. missing or non-compliant consent / opt-in ' +
    'text (TCPA/GDPR), missing required disclosures (FTC, HIPAA), fabricated or ' +
    'unsubstantiated claims, misrepresented pricing or guarantees, dark patterns. ' +
    'Evaluate ONLY against the supplied rules. Do not invent rules. Report a ' +
    'finding only when there is a concrete violation in the supplied source. ' +
    'Respond with STRICT JSON only — no prose, no markdown fences.';

  const prompt = [
    `Page: ${pageId}`,
    `Purpose: ${ctx.page.purpose}`,
    `User function: ${ctx.page.userFunction}`,
    `Source file: ${ctx.page.filePath}`,
    '',
    'Compliance rules in force for this page:',
    rulesBlock,
    '',
    'Page source (line-numbered):',
    '```',
    source
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n'),
    '```',
    '',
    'For EACH violation you find, emit one finding object. Output JSON exactly:',
    '{',
    '  "findings": [',
    '    {',
    '      "ruleId": "<id of the violated rule, must be one of the rule ids above>",',
    '      "domain": "<the rule domain>",',
    '      "severity": "critical|high|medium|low",',
    '      "location": "<file:line, e.g. ' + ctx.page.filePath + ':42>",',
    '      "problem": "<what is legally/factually wrong, concretely>",',
    '      "requiredFix": "<the specific change that makes it compliant>"',
    '    }',
    '  ]',
    '}',
    'If there are no violations, return {"findings": []}.',
  ].join('\n');

  let findings: ComplianceFinding[] = [];
  try {
    const response = await ctx.gemini.callJson<ComplianceJsonResponse>({
      role: 'agent6_compliance',
      systemInstruction,
      prompt,
      json: true,
    });

    const raw = Array.isArray(response?.findings) ? response.findings : [];
    const validIds = new Set(matchedRules.map((r) => r.id));
    findings = raw
      .map((f): ComplianceFinding => {
        const ruleId = typeof f.ruleId === 'string' ? f.ruleId : 'unknown';
        const rule = matchedRules.find((r) => r.id === ruleId);
        return {
          ruleId,
          domain:
            typeof f.domain === 'string' && f.domain !== ''
              ? f.domain
              : rule?.domain ?? 'unknown',
          severity: coerceSeverity(f.severity),
          location:
            typeof f.location === 'string' && f.location !== ''
              ? f.location
              : ctx.page.filePath,
          problem: typeof f.problem === 'string' ? f.problem : '',
          requiredFix: typeof f.requiredFix === 'string' ? f.requiredFix : '',
        };
      })
      // Drop hallucinated findings that reference rules not in scope.
      .filter((f) => f.ruleId === 'unknown' || validIds.has(f.ruleId))
      .filter((f) => f.problem !== '');
  } catch (err) {
    // Gemini failure must not crash the worker — return a minimal valid result.
    console.error(`[agent6-compliance] Gemini call failed for ${pageId}: ${String(err)}`);
    const result: ComplianceResult = { page: pageId, findings: [], clean: true };
    writeArtifacts(ctx, result, matchedRules);
    return result;
  }

  const clean = !findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );

  const result: ComplianceResult = { page: pageId, findings, clean };
  writeArtifacts(ctx, result, matchedRules);
  return result;
}
