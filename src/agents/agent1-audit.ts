/**
 * Agent 1 — Audit.
 *
 * Drives the live page in a real browser, exercises every interactive
 * element, captures console errors + a screenshot, then asks the audit model
 * for a structured functional/UX gap list.
 *
 * Output: ctx.pageDir/audit.json + ctx.pageDir/audit.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PageDriver } from '../browser';
import { matchAuthRole } from '../auth';
import { resolveRoutePath } from '../sample-params';
import type { AgentContext, AuditResult, Gap, Severity, PageHealth } from '../types';

/** Shape the model must return — kept narrow so parsing is robust. */
interface AuditModelResponse {
  gaps: Array<{
    id?: string;
    category?: string;
    severity?: string;
    description?: string;
    recommendation?: string;
    evidence?: string[];
  }>;
}

const VALID_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

function coerceSeverity(value: unknown): Severity {
  return VALID_SEVERITIES.includes(value as Severity)
    ? (value as Severity)
    : 'medium';
}

function coerceCategory(value: unknown): 'functional' | 'ux' {
  return value === 'functional' || value === 'ux'
    ? value
    : 'functional';
}

/** Normalise a raw model gap into a contract-valid Gap. */
function normaliseGap(raw: AuditModelResponse['gaps'][number], index: number): Gap {
  const gap: Gap = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `g${index + 1}`,
    category: coerceCategory(raw.category),
    severity: coerceSeverity(raw.severity),
    description:
      typeof raw.description === 'string' && raw.description.trim()
        ? raw.description.trim()
        : 'Unspecified gap.',
    recommendation:
      typeof raw.recommendation === 'string' && raw.recommendation.trim()
        ? raw.recommendation.trim()
        : 'No recommendation provided.',
  };
  if (Array.isArray(raw.evidence) && raw.evidence.length > 0) {
    gap.evidence = raw.evidence.filter((e): e is string => typeof e === 'string');
  }
  return gap;
}

function renderMd(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`# Audit — ${result.page}`);
  lines.push('');
  if (result.health) {
    lines.push(`Page health: ${result.health.status} — ${result.health.detail}`);
  }
  if (result.authRole) {
    lines.push(`Audited logged in as: **${result.authRole}**`);
  }
  lines.push(`Interactions exercised: ${result.interactionsExercised.length}`);
  lines.push(`Console errors: ${result.consoleErrors.length}`);
  lines.push(`Gaps found: ${result.gaps.length}`);
  lines.push('');

  if (result.interactionsExercised.length > 0) {
    lines.push('## Interactions Exercised');
    for (const i of result.interactionsExercised) lines.push(`- ${i}`);
    lines.push('');
  }

  if (result.consoleErrors.length > 0) {
    lines.push('## Console Errors');
    for (const e of result.consoleErrors) lines.push(`- \`${e}\``);
    lines.push('');
  }

  lines.push('## Gaps');
  if (result.gaps.length === 0) {
    lines.push('_No gaps identified._');
  } else {
    for (const gap of result.gaps) {
      lines.push(`### ${gap.id} — ${gap.category} / ${gap.severity}`);
      lines.push('');
      lines.push(`**Description:** ${gap.description}`);
      lines.push('');
      lines.push(`**Recommendation:** ${gap.recommendation}`);
      if (gap.evidence && gap.evidence.length > 0) {
        lines.push('');
        lines.push('**Evidence:**');
        for (const ev of gap.evidence) lines.push(`- \`${ev}\``);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function writeOutputs(ctx: AgentContext, result: AuditResult): void {
  fs.mkdirSync(ctx.pageDir, { recursive: true });
  fs.writeFileSync(
    path.join(ctx.pageDir, 'audit.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(ctx.pageDir, 'audit.md'), renderMd(result), 'utf8');
}

const SYSTEM_INSTRUCTION = `You are a senior product QA auditor. You inspect ONE web page that has been driven in a real browser. You receive a screenshot, an accessibility/DOM snapshot, the page source context, the list of interactions that were exercised, and any console errors.

Find concrete FUNCTIONAL gaps (broken buttons, dead links, failed requests, console errors, missing data, non-working forms) and UX gaps (confusing layout, missing affordances, poor feedback, accessibility issues).

Be specific and evidence-based. Do not invent problems. Tie functional gaps to console errors or exercised interactions where possible. Rank by real user impact.

Return STRICT JSON only — no prose, no markdown fences.`;

function buildPrompt(
  ctx: AgentContext,
  snapshot: string,
  interactions: string[],
  consoleErrors: string[],
  health?: PageHealth,
): string {
  return `Audit this page and return a JSON gap list.

PAGE
  slug: ${ctx.page.slug}
  route: ${ctx.page.route}
  purpose: ${ctx.page.purpose}
  userFunction: ${ctx.page.userFunction}
  sourceFile: ${ctx.page.filePath}

PAGE HEALTH
${health ? `  status: ${health.status}\n  healthy: ${health.healthy}\n  detail: ${health.detail}` : '  (unknown)'}

DATA DEPENDENCIES
${JSON.stringify(ctx.page.dataDependencies, null, 2)}

INTERACTIONS EXERCISED (${interactions.length})
${interactions.length ? interactions.map((i) => `  - ${i}`).join('\n') : '  (none)'}

CONSOLE / PAGE ERRORS (${consoleErrors.length})
${consoleErrors.length ? consoleErrors.map((e) => `  - ${e}`).join('\n') : '  (none)'}

ACCESSIBILITY / DOM SNAPSHOT
${snapshot || '(snapshot unavailable)'}

A screenshot of the page is attached as an image.

Return JSON of EXACTLY this shape:
{
  "gaps": [
    {
      "id": "g1",                       // stable id: g1, g2, g3, ...
      "category": "functional" | "ux",
      "severity": "critical" | "high" | "medium" | "low",
      "description": "what is wrong, observed concretely",
      "recommendation": "what to change to fix it",
      "evidence": ["console error text or exercised interaction that proves it"]
    }
  ]
}
Use sequential ids starting at g1. "evidence" is optional but include it whenever a console error or interaction supports the gap. If the page is fully sound, return {"gaps": []}.`;
}

export async function runAudit(ctx: AgentContext): Promise<AuditResult> {
  const pageId = ctx.page.route || ctx.page.slug;

  // Boot gate failed — cannot drive the page. Return a single explanatory gap.
  if (ctx.boot.status !== 'running') {
    const result: AuditResult = {
      page: pageId,
      consoleErrors: [],
      interactionsExercised: [],
      gaps: [
        {
          id: 'g1',
          category: 'functional',
          severity: 'critical',
          description: `Page could not be driven: dev server boot status is "${ctx.boot.status}".${
            ctx.boot.reason ? ` Reason: ${ctx.boot.reason}` : ''
          }`,
          recommendation:
            'Resolve the boot-gate failure (Stage 0.5) so the page can be served and audited in a browser.',
          evidence: ctx.boot.reason ? [ctx.boot.reason] : undefined,
        },
      ],
    };
    writeOutputs(ctx, result);
    return result;
  }

  const routePath = resolveRoutePath(ctx.page.route, ctx.config.sampleParams);
  const url = `${ctx.boot.baseUrl}${routePath}`;

  let driver: PageDriver | undefined;
  let interactions: string[] = [];
  let consoleErrors: string[] = [];
  let snapshot = '';
  let screenshot = '';
  let driveError: string | undefined;
  let authRole: string | undefined;
  let loginNote: string | undefined;
  let health: PageHealth | undefined;

  try {
    driver = await PageDriver.launch({ readOnly: ctx.config.readOnlyExercise });

    // Auth-aware: if this route belongs to a role, log in FIRST so the page
    // is audited as a real authenticated user. Login happens in the same
    // browser context, so the session cookie carries to the target page.
    if (ctx.config.auth) {
      const role = matchAuthRole(ctx.page.route, ctx.config.auth);
      if (role) {
        const login = await driver.loginAs(
          ctx.boot.baseUrl ?? '',
          ctx.config.auth,
          role,
        );
        loginNote = login.detail;
        if (login.ok) authRole = role.role;
      }
    }

    await driver.open(url);

    const exercised = await driver.exercise();
    interactions = loginNote
      ? [`login: ${loginNote}`, ...exercised.interactions]
      : exercised.interactions;
    consoleErrors = exercised.consoleErrors;

    try {
      snapshot = await driver.snapshot();
    } catch (err) {
      snapshot = '';
      driveError = `snapshot failed: ${String(err)}`;
    }

    try {
      screenshot = await driver.screenshot();
    } catch (err) {
      screenshot = '';
      driveError = `screenshot failed: ${String(err)}`;
    }

    health = await driver.health(routePath, ctx.config.auth?.loginUrl);
  } catch (err) {
    driveError = `Failed to drive page: ${String(err)}`;
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch {
        /* teardown failures are non-fatal */
      }
    }
  }

  // Could not drive the page at all — surface as a critical gap.
  if (driveError && !snapshot && !screenshot && interactions.length === 0) {
    const result: AuditResult = {
      page: pageId,
      health: {
        status: 'navigation-failed',
        healthy: false,
        finalUrl: url,
        detail: driveError ?? 'page could not be driven',
      },
      consoleErrors,
      interactionsExercised: interactions,
      gaps: [
        {
          id: 'g1',
          category: 'functional',
          severity: 'critical',
          description: `The page could not be driven in a browser. ${driveError}`,
          recommendation:
            'Verify the route serves correctly and the browser driver can reach it before re-running the audit.',
          evidence: loginNote ? [driveError, `login: ${loginNote}`] : [driveError],
        },
      ],
    };
    writeOutputs(ctx, result);
    return result;
  }

  let gaps: Gap[] = [];

  try {
    const response = await ctx.gemini.callJson<AuditModelResponse>({
      role: 'agent1_audit',
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(ctx, snapshot, interactions, consoleErrors, health),
      json: true,
      images: screenshot ? [screenshot] : undefined,
    });

    const rawGaps = Array.isArray(response?.gaps) ? response.gaps : [];
    gaps = rawGaps.map((raw, i) => normaliseGap(raw, i));
  } catch (err) {
    // Gemini failure — write a minimal valid result rather than crashing.
    gaps = [
      {
        id: 'g1',
        category: 'functional',
        severity: 'medium',
        description: `Audit model call failed; gap analysis could not be completed. ${String(
          err,
        )}`,
        recommendation:
          'Re-run the audit agent for this page once the Gemini call succeeds.',
        evidence: consoleErrors.length > 0 ? consoleErrors : undefined,
      },
    ];
  }

  const result: AuditResult = {
    page: pageId,
    health,
    consoleErrors,
    interactionsExercised: interactions,
    gaps,
    ...(authRole ? { authRole } : {}),
  };

  writeOutputs(ctx, result);
  return result;
}
