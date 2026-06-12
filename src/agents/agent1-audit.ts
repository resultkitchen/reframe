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
  AuditPersona,
  AuditResult,
  Gap,
  Severity,
  PageHealth,
  FindingDimension,
} from '../types';
import { AUDIT_PERSONAS, FINDING_DIMENSIONS } from '../types';
import { AuditOutputSchema } from '../schemas/agent-outputs';

/**
 * Shape the model must return — also enforced at runtime by AuditOutputSchema
 * (src/schemas/agent-outputs.ts). The Zod schema is the source of truth; this
 * interface mirrors it for the TS-only normalization path below.
 */
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
    personas?: string[];
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
 * Coerce a raw personas array to a deduped list of known persona ids.
 * The model is asked to emit lower-case ids (`arthur`, `elena`, `marcus`,
 * `camille`) but real LLMs sometimes emit "Arthur Vance" or "ARTHUR". We
 * lower-case and check the first word against the enum so the natural
 * variants still land. Returns undefined when nothing valid remains so
 * the field can be omitted from the gap entirely (the decorator just
 * doesn't fire the signal).
 */
function coercePersonas(value: unknown): AuditPersona[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = new Set<AuditPersona>(AUDIT_PERSONAS);
  const seen = new Set<AuditPersona>();
  const out: AuditPersona[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const head = raw.trim().toLowerCase().split(/[\s,\.]+/)[0] ?? '';
    if (known.has(head as AuditPersona) && !seen.has(head as AuditPersona)) {
      seen.add(head as AuditPersona);
      out.push(head as AuditPersona);
    }
  }
  return out.length > 0 ? out : undefined;
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

/**
 * Normalise a raw model gap into a contract-valid Gap.
 *
 * Exported so the live-LLM eval harness (tests/eval/run.ts --live)
 * can apply the exact same normalization to real agent output before
 * scoring against assertions — without having to drive the browser
 * or write to a runDir.
 */
export function normaliseGap(raw: AuditModelResponse['gaps'][number], index: number): Gap {
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
  const personas = coercePersonas(raw.personas);
  if (personas) gap.personas = personas;
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

export const AUDIT_SYSTEM_INSTRUCTION = `You are a collaborative panel of four world-class expert personas auditing this web page together. Your collective output is one unified, ranked gap list.

1. Arthur Vance — Senior Lead QA Architect. Functional correctness, console/network errors, broken interactions, code robustness.
2. Elena Rostova — Principal UX & Interface Designer. Visual hierarchy, layout, micro-interaction affordances, RESPONSIVE behavior, mobile vs desktop drift.
3. Dr. Marcus Thorne — Compliance & Accessibility Specialist. Legal guidelines (TCPA, FTC, HIPAA), WCAG 2.2 accessibility, contrast, keyboard nav, ARIA, focus order, screen-reader walkthrough.
4. Camille Reyes — Brand & Copy Director. BRAND VOICE drift, MICROCOPY quality (button labels, error messages, placeholders, empty states), emotional design, tone consistency against the pinned brand voice spec below.

Arthur, Elena, Marcus, and Camille must collaborate and align. Provide a unified, high-density, evidence-based list of gaps. Tie every functional gap directly to console errors, network failures, or failed clicks where possible. Rank by real user impact.

MULTI-DIMENSIONAL SCANNING — do NOT stop at functional/UX. Each persona must SYSTEMATICALLY scan their domain:
- Arthur: every interactive element exercised, every console error categorized.
- Elena: visual hierarchy at the captured viewport; responsive-design risks if the layout depends on a specific width.
- Marcus: every form input checked for an associated label; every interactive element checked for keyboard accessibility; every image checked for alt text; contrast checked against WCAG 2.2 AA where colors are inferable.
- Camille: every visible piece of copy (headlines, button labels, error states, empty states) compared against the pinned brand voice. Flag drift specifically — quote the offending copy, name the brand-voice attribute it violates, suggest a replacement.

DUAL-REGISTER OUTPUT — for EVERY gap, write BOTH:
- "description": the technical statement for an engineer (file:line where possible, terms of art OK)
- "plain":       the same issue, in plain English, for a non-technical product owner / founder / client. NO jargon. NO acronyms (or expand them inline the first time). Concrete, conversational, kind. Lead with the user-visible consequence, not the technical category.

For EVERY gap also write:
- "whyItMatters": the concrete real-world consequence if shipped unfixed. Who is affected, when, and how. One or two sentences. Avoid restating the description.
- "confidence":   a number in [0, 1]. 0.95 = "I'd stake my reputation on this." 0.8 = "strong signal, worth fixing." 0.5 = "worth a look but I'm not sure." Be honest — overconfidence damages trust.
- "dimension":    a fine-grained classifier — use the MOST SPECIFIC applicable from: functional | ux | visual-hierarchy | brand-voice | microcopy | responsive | accessibility | performance | data-contract | security. Don't default everything to "functional" or "ux" — those are the broad buckets, and the more specific dimensions are what differentiate a useful audit from a generic one.
- "personas":     an array of which persona(s) above raised the gap, lower-case ids only: ["arthur"] | ["elena"] | ["marcus"] | ["camille"]. When two or more personas would independently flag the same gap (e.g. an unlabeled button is BOTH a functional defect and an accessibility violation), list them all — the downstream system treats multi-persona agreement as a separate trust signal. Always include at least one persona per gap.

TONE — write findings the way a senior designer gives a junior a crit: warm, specific, opinionated, never blame-y. Use "Try" not "Fix." Lead with the user, never with the code.

Return STRICT JSON only — no prose, no markdown fences.`;

/**
 * Build the audit prompt. Exported so the live-LLM eval harness can
 * exercise the exact production prompt against fixture inputs without
 * driving a real browser. Keep the signature stable — eval imports it.
 */
export function buildAuditPrompt(
  ctx: AgentContext,
  snapshot: string,
  interactions: string[],
  consoleErrors: string[],
  health?: PageHealth,
): string {
  // The brand voice + component style come from the pinned (or bootstrapped)
  // brand spec. Camille (the brand persona in the system instruction) uses
  // them to flag voice drift on this specific page. If the brand isn't pinned
  // we mark it explicitly so the model knows to weight voice findings lower.
  const brandBlock = ctx.brand
    ? [
        `  name: ${ctx.brand.name}`,
        `  voice: ${ctx.brand.voice}`,
        `  componentStyle: ${ctx.brand.componentStyle}`,
        `  pinned: ${ctx.brand.pinned}`,
        ctx.brand.pinned
          ? ''
          : '  (UNPINNED — voice findings should be cautious; the brand spec is a Stage 0 bootstrap candidate.)',
      ].filter(Boolean).join('\n')
    : '  (no brand spec available — skip voice findings on this run.)';

  const knownCoveredBlock = ctx.constraints?.knownCovered && ctx.constraints.knownCovered.length > 0
    ? `\n  knownCoveredSurfaces: \n${ctx.constraints.knownCovered.map((s) => `    - ${s}`).join('\n')}`
    : '';

  const focusBlock = ctx.config.focus
    ? `\n  runFocusGoal: ${ctx.config.focus}`
    : '';

  return `Audit this page and return a JSON gap list.

PAGE
  slug: ${ctx.page.slug}
  route: ${ctx.page.route}
  purpose: ${ctx.page.purpose}
  userFunction: ${ctx.page.userFunction}
  sourceFile: ${ctx.page.filePath}${knownCoveredBlock}${focusBlock}

PINNED BRAND VOICE (compare every visible piece of copy against this — flag drift)
${brandBlock}

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
      "evidence": ["console error text or exercised interaction that proves it"],
      "personas":  ["arthur", "elena", "marcus", "camille"]
    }
  ]
}
Use sequential ids starting at g1. "evidence" is optional but include it whenever a console error or interaction supports the gap. "plain", "whyItMatters", "confidence", "dimension", and "personas" are REQUIRED for every gap. List MULTIPLE personas when the gap is multi-disciplinary — that drives the multi-persona-agreement trust signal. If the page is fully sound, return {"gaps": []}.`;
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
      urlQuery: ctx.config.urlQuery,
      extraHeaders: ctx.config.extraHeaders,
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

    if (ctx.config.noExercise) {
      // Live/prod-safe: do not click anything. Capture only what the page
      // load surfaced. No drift, no side effects.
      const note = '(exercise skipped — --no-exercise: no clicks on the live app)';
      interactions = loginNote ? [`login: ${loginNote}`, note] : [note];
      consoleErrors = driver.getConsoleErrors();
    } else {
    const exercised = await driver.exercise();
    interactions = loginNote
      ? [`login: ${loginNote}`, ...exercised.interactions]
      : exercised.interactions;
    consoleErrors = exercised.consoleErrors;

    // exercise() clicks links and may navigate away from the intended route
    // (e.g. a nav/footer link). Before capturing the snapshot/screenshot/health,
    // return to the intended route so they reflect THIS page — not wherever a
    // click wandered to. A genuine redirect (e.g. an un-onboarded account →
    // /book) simply re-redirects, so it's still surfaced honestly.
    try {
      const expectedPath = routePath.split('?')[0].replace(/\/+$/, '') || '/';
      const here = driver.currentPath().replace(/\/+$/, '') || '/';
      if (here !== expectedPath) {
        interactions.push(`re-settled to ${routePath} after exercise drifted to ${here}`);
        await driver.open(url);
      }
    } catch { /* best-effort re-settle */ }
    }

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

  // If health status is route-drift or auth-redirect, do not query Gemini. Return a placeholder result.
  if (health && (health.status === 'route-drift' || health.status === 'auth-redirect')) {
    const result: AuditResult = {
      page: pageId,
      health,
      consoleErrors,
      interactionsExercised: interactions,
      gaps: [
        {
          id: 'g1',
          category: 'functional',
          severity: 'high',
          description: health.status === 'route-drift'
            ? `Route drift detected: expected "${routePath}", landed on "${health.finalUrl}".`
            : `Authentication redirect detected: redirected to login/auth page "${health.finalUrl}".`,
          recommendation: health.status === 'route-drift'
            ? `Verify the application routing is correct or update sample parameters / auth state to avoid drifting away from the intended view.`
            : `Ensure valid test credentials are configured and that the user session is preserved to prevent authentication bounces.`,
          evidence: [`Landed URL: ${health.finalUrl}`],
          plain: health.status === 'route-drift'
            ? `Reframe landed on "${health.finalUrl}" instead of the expected route "${routePath}".`
            : `Reframe was redirected to the login/auth page "${health.finalUrl}" while trying to view this page.`,
          whyItMatters: `The automated audit could not inspect the intended page because the app drifted or bounced the user to a different view.`,
          dimension: 'functional',
          personas: ['arthur'],
        },
      ],
      ...(authRole ? { authRole } : {}),
      ...(Object.keys(breakpointFiles).length > 0
        ? { breakpointScreenshots: breakpointFiles }
        : {}),
    };
    writeOutputs(ctx, result, screenshot, html, breakpointShots);
    return result;
  }

  let gaps: Gap[] = [];

  try {
    // Schema-validated call: the LLM's gap array shape is enforced by
    // AuditOutputSchema. On a first-attempt validation failure the client
    // appends the Zod issues to the prompt and retries once before throwing.
    // Either way, the data reaching normaliseGap conforms to the contract.
    const response = await ctx.gemini.callJsonSchema(AuditOutputSchema, {
      role: 'agent1_audit',
      systemInstruction: AUDIT_SYSTEM_INSTRUCTION,
      prompt: buildAuditPrompt(ctx, snapshot, interactions, consoleErrors, health),
      json: true,
      images: screenshot ? [screenshot] : undefined,
    });

    const rawGaps = response.gaps;
    gaps = (rawGaps as AuditModelResponse['gaps']).map((raw, i) => normaliseGap(raw, i));
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
