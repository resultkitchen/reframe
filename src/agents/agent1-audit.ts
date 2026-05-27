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
import { PageDriver, DEFAULT_BREAKPOINTS } from '../browser';
import { matchAuthRole } from '../auth';
import { resolveRoutePath } from '../sample-params';
import type {
  AgentContext,
  AuditResult,
  Gap,
  Severity,
  PageHealth,
  FindingDimension,
} from '../types';
import { FINDING_DIMENSIONS } from '../types';

/** Shape the model must return — kept narrow so parsing is robust. */
interface AuditModelResponse {
  gaps: Array<{
    id?: string;
    category?: string;
    dimension?: string;
    severity?: string;
    confidence?: number | string;
    description?: string;
    plain?: string;
    whyItMatters?: string;
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

function coerceDimension(value: unknown): FindingDimension | undefined {
  if (typeof value !== 'string') return undefined;
  return (FINDING_DIMENSIONS as readonly string[]).includes(value)
    ? (value as FindingDimension)
    : undefined;
}

/**
 * Coerce a raw confidence value to [0, 1]. Accepts numbers and numeric
 * strings ("0.9", "90%"). Returns undefined for anything we can't parse —
 * letting callers fall through to a sensible default in the UI.
 */
function coerceConfidence(value: unknown): number | undefined {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim().replace(/%$/, '');
    n = parseFloat(trimmed);
    if (Number.isNaN(n)) return undefined;
    // Treat "85" as 0.85, "0.85" as 0.85.
    if (value.includes('%') || n > 1) n = n / 100;
  } else {
    return undefined;
  }
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
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
  if (typeof raw.plain === 'string' && raw.plain.trim()) {
    gap.plain = raw.plain.trim();
  }
  if (typeof raw.whyItMatters === 'string' && raw.whyItMatters.trim()) {
    gap.whyItMatters = raw.whyItMatters.trim();
  }
  const conf = coerceConfidence(raw.confidence);
  if (conf !== undefined) gap.confidence = conf;
  const dim = coerceDimension(raw.dimension);
  if (dim) gap.dimension = dim;
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
      const conf = typeof gap.confidence === 'number'
        ? ` · confidence ${Math.round(gap.confidence * 100)}%`
        : '';
      const dim = gap.dimension ? ` · ${gap.dimension}` : '';
      lines.push(`### ${gap.id} — ${gap.category}${dim} / ${gap.severity}${conf}`);
      lines.push('');
      if (gap.plain) {
        lines.push(`**In plain English:** ${gap.plain}`);
        lines.push('');
      }
      if (gap.whyItMatters) {
        lines.push(`**Why it matters:** ${gap.whyItMatters}`);
        lines.push('');
      }
      lines.push(`**Technical:** ${gap.description}`);
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

  if (result.breakpointScreenshots && Object.keys(result.breakpointScreenshots).length > 0) {
    lines.push('## Responsive screenshots');
    for (const [name, file] of Object.entries(result.breakpointScreenshots)) {
      lines.push(`- ${name}: \`${file}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function writeOutputs(
  ctx: AgentContext,
  result: AuditResult,
  screenshot?: string,
  html?: string,
  breakpointShots?: Record<string, string>,
): void {
  fs.mkdirSync(ctx.pageDir, { recursive: true });
  fs.writeFileSync(
    path.join(ctx.pageDir, 'audit.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(ctx.pageDir, 'audit.md'), renderMd(result), 'utf8');
  if (screenshot) {
    try {
      fs.writeFileSync(path.join(ctx.pageDir, 'audit.png'), Buffer.from(screenshot, 'base64'));
    } catch (err) {
      console.error(`[agent1-audit] failed to write screenshot to disk: ${String(err)}`);
    }
  }
  if (breakpointShots) {
    for (const [name, b64] of Object.entries(breakpointShots)) {
      if (!b64) continue;
      try {
        fs.writeFileSync(
          path.join(ctx.pageDir, `audit-${name}.png`),
          Buffer.from(b64, 'base64'),
        );
      } catch (err) {
        console.error(
          `[agent1-audit] failed to write breakpoint screenshot ${name}: ${String(err)}`,
        );
      }
    }
  }
  if (html) {
    try {
      fs.writeFileSync(path.join(ctx.pageDir, 'audit.html'), html, 'utf8');
    } catch (err) {
      console.error(`[agent1-audit] failed to write HTML snapshot to disk: ${String(err)}`);
    }
  }
}

const SYSTEM_INSTRUCTION = `You are a collaborative panel of three world-class expert personas representing diverse but related fields, cooperating to audit this web page:

1. Arthur Vance (Senior Lead QA Architect): Focuses on functional correctness, console/network errors, broken interactions, and code robustness.
2. Elena Rostova (Principal UX & Interface Designer): Focuses on visual hierarchy, brand consistency, layout constraints, and micro-interaction affordances.
3. Dr. Marcus Thorne (Compliance & Accessibility Specialist): Focuses on legal guidelines (e.g., TCPA, FTC, HIPAA), WCAG 2.2 accessibility, and secure markup standards.

Arthur, Elena, and Marcus must collaborate and align on their findings. Provide a unified, high-density, evidence-based list of functional and UX gaps. Tie every functional gap directly to console errors, network failures, or failed clicks where possible. Rank by real user impact.

DUAL-REGISTER OUTPUT — for EVERY gap, write BOTH:
- "description": the technical statement for an engineer (file:line where possible, terms of art OK)
- "plain":       the same issue, in plain English, for a non-technical product owner / founder / client. NO jargon. NO acronyms (or expand them inline the first time). Concrete, conversational, kind. Lead with the user-visible consequence, not the technical category. Bad: "Type drift on leads.created_at." Good: "Dates on the leads list will display wrong because the code expects one date format and the database stores another."

For EVERY gap also write:
- "whyItMatters": the concrete real-world consequence if shipped unfixed. Who is affected, when, and how. One or two sentences. Avoid restating the description.
- "confidence":   a number in [0, 1]. 0.95 = "I'd stake my reputation on this." 0.8 = "strong signal, worth fixing." 0.5 = "worth a look but I'm not sure." Be honest — overconfidence damages trust.
- "dimension":    a fine-grained classifier from: functional | ux | visual-hierarchy | brand-voice | microcopy | responsive | accessibility | performance | data-contract | security. Use the most specific applicable dimension.

TONE — write findings the way a senior designer gives a junior a crit: warm, specific, opinionated, never blame-y. Use "Try" not "Fix." Lead with the user, never with the code.

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
      "dimension": "functional" | "ux" | "visual-hierarchy" | "brand-voice" | "microcopy" | "responsive" | "accessibility" | "performance" | "data-contract" | "security",
      "severity": "critical" | "high" | "medium" | "low",
      "confidence": 0.95,               // your honest confidence in [0, 1] that this is a real issue
      "description": "TECHNICAL: what is wrong, observed concretely (for an engineer)",
      "plain":       "PLAIN ENGLISH: same issue, no jargon, written for a non-technical reader. Lead with the user-visible consequence.",
      "whyItMatters":"Concrete real-world consequence if shipped unfixed. Who is affected and how.",
      "recommendation": "What to change to fix it",
      "evidence": ["console error text or exercised interaction that proves it"]
    }
  ]
}
Use sequential ids starting at g1. "evidence" is optional but include it whenever a console error or interaction supports the gap. "plain", "whyItMatters", "confidence", and "dimension" are REQUIRED for every gap. If the page is fully sound, return {"gaps": []}.`;
}

export async function runAudit(ctx: AgentContext): Promise<AuditResult> {
  const pageId = ctx.page.route || ctx.page.slug;

  // Boot gate failed — cannot drive the page. Return a single explanatory gap.
  if (ctx.boot.status !== 'running') {
    const result: AuditResult = {
      page: pageId,
      health: {
        status: 'boot-failed',
        healthy: false,
        finalUrl: '',
        detail: `dev server boot status is "${ctx.boot.status}".${
          ctx.boot.reason ? ` Reason: ${ctx.boot.reason}` : ''
        }`,
      },
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
  let html = '';
  let driveError: string | undefined;
  let authRole: string | undefined;
  let loginNote: string | undefined;
  let health: PageHealth | undefined;
  const breakpointShots: Record<string, string> = {};
  const breakpointFiles: Record<string, string> = {};

  try {
    driver = await PageDriver.launch({
      readOnly: ctx.config.readOnlyExercise,
      mocksPath: ctx.config.mocksPath,
    });

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

    try {
      html = await driver.content();
    } catch (err) {
      console.error(`[agent1-audit] DOM capture failed: ${String(err)}`);
    }

    health = await driver.health(routePath, ctx.config.auth?.loginUrl);

    // Multi-breakpoint capture. Walk DEFAULT_BREAKPOINTS in order; each call
    // resizes the viewport on the live page (no re-navigation) and captures a
    // full-page screenshot at that size. A failure on one breakpoint never
    // aborts the rest — partial coverage is more useful than none.
    if (screenshot) {
      for (const bp of DEFAULT_BREAKPOINTS) {
        try {
          const shot = await driver.screenshotAt(bp.width, bp.height);
          if (shot) {
            breakpointShots[bp.name] = shot;
            breakpointFiles[bp.name] = `audit-${bp.name}.png`;
          }
        } catch (err) {
          console.error(
            `[agent1-audit] breakpoint capture failed for ${bp.name}: ${String(err)}`,
          );
        }
      }
    }
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
    ...(Object.keys(breakpointFiles).length > 0
      ? { breakpointScreenshots: breakpointFiles }
      : {}),
  };

  writeOutputs(ctx, result, screenshot, html, breakpointShots);
  return result;
}
