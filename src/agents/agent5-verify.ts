/**
 * Agent 5 — Verify.
 *
 * Re-drives the (now-rewritten) page in a real browser, exercises it,
 * screenshots it, and asks the model which Agent 1 gap ids are now closed,
 * which are still open, and whether any regressions were introduced.
 *
 * `pass` = every non-low gap is closed AND no regressions.
 *
 * Output: VerifyResult plus `<pageDir>/verify.json` + `<pageDir>/verify.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentContext, Gap, VerifyResult, PageHealth } from '../types';
import { PageDriver } from '../browser';
import { matchAuthRole } from '../auth';
import { resolveRoutePath } from '../sample-params';

/** Render the human-readable verify report. */
function renderMd(
  ctx: AgentContext,
  result: VerifyResult,
  reason: string,
  consoleErrors: string[],
  interactions: string[],
): string {
  const lines: string[] = [];
  lines.push(`# Verify — ${result.page}`);
  lines.push('');
  lines.push(`**Result:** ${result.pass ? 'PASS' : 'FAIL'}`);
  if (reason) {
    lines.push('');
    lines.push(`> ${reason}`);
  }
  lines.push('');
  lines.push(`**Gaps closed:** ${result.gapsClosed.length}`);
  if (result.gapsClosed.length > 0) {
    for (const id of result.gapsClosed) lines.push(`- ${id}`);
  }
  lines.push('');
  lines.push(`**Gaps still open:** ${result.gapsOpen.length}`);
  if (result.gapsOpen.length > 0) {
    for (const id of result.gapsOpen) lines.push(`- ${id}`);
  }
  lines.push('');
  lines.push(`**Regressions:** ${result.regressions.length}`);
  if (result.regressions.length > 0) {
    for (const r of result.regressions) lines.push(`- ${r}`);
  }
  lines.push('');
  if (interactions.length > 0) {
    lines.push('## Interactions exercised');
    for (const it of interactions) lines.push(`- ${it}`);
    lines.push('');
  }
  if (consoleErrors.length > 0) {
    lines.push('## Console errors observed after rebuild');
    for (const e of consoleErrors) lines.push(`- ${e}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Persist verify.json + verify.md into the page's run dir. */
function writeArtifacts(
  ctx: AgentContext,
  result: VerifyResult,
  reason: string,
  consoleErrors: string[],
  interactions: string[],
  screenshot?: string,
): void {
  try {
    fs.mkdirSync(ctx.pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.pageDir, 'verify.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ctx.pageDir, 'verify.md'),
      renderMd(ctx, result, reason, consoleErrors, interactions),
      'utf8',
    );
    if (screenshot) {
      fs.writeFileSync(path.join(ctx.pageDir, 'audit.png'), Buffer.from(screenshot, 'base64'));
      fs.writeFileSync(path.join(ctx.pageDir, 'verify.png'), Buffer.from(screenshot, 'base64'));
    }
  } catch (err) {
    console.error(`[agent5-verify] failed to write artifacts: ${String(err)}`);
  }
}

/** Join two URL fragments without doubling or dropping the separator. */
function joinUrl(base: string, route: string): string {
  if (!route) return base;
  const b = base.replace(/\/+$/, '');
  const r = route.startsWith('/') ? route : `/${route}`;
  return b + r;
}

/**
 * Compute pass/fail: every non-low gap must be closed and no regressions.
 * A gap is "non-low" when its declared severity is critical/high/medium.
 */
function computePass(gaps: Gap[], gapsClosed: string[], regressions: string[], health?: PageHealth): boolean {
  if (health && health.status !== 'ok') return false;
  if (regressions.length > 0) return false;
  const closed = new Set(gapsClosed);
  for (const g of gaps) {
    if (g.severity !== 'low' && !closed.has(g.id)) return false;
  }
  return true;
}

interface VerifyJsonResponse {
  gapsClosed?: unknown;
  gapsOpen?: unknown;
  regressions?: unknown;
}

/** Coerce an unknown JSON value into a string[] of trimmed non-empty entries. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()))
    .filter((s) => s !== '');
}

export async function runVerify(ctx: AgentContext): Promise<VerifyResult> {
  const pageId = ctx.page.route || ctx.page.slug;
  const gaps = ctx.audit?.gaps ?? [];
  const routePath = resolveRoutePath(ctx.page.route, ctx.config.sampleParams);

  // Boot gate: if the app isn't running we cannot verify anything.
  if (ctx.boot?.status !== 'running' || !ctx.boot.baseUrl) {
    const reason =
      `App not running (boot status: ${ctx.boot?.status ?? 'unknown'}` +
      `${ctx.boot?.reason ? ` — ${ctx.boot.reason}` : ''}); page could not be verified.`;
    const result: VerifyResult = {
      page: pageId,
      health: {
        status: 'navigation-failed',
        healthy: false,
        finalUrl: ctx.boot?.baseUrl ?? '',
        detail: reason,
      },
      gapsClosed: [],
      gapsOpen: gaps.map((g) => g.id),
      regressions: [],
      pass: false,
    };
    writeArtifacts(ctx, result, reason, [], []);
    console.error(`[agent5-verify] ${reason}`);
    return result;
  }

  const url = joinUrl(ctx.boot.baseUrl, routePath);

  let driver: PageDriver | null = null;
  let consoleErrors: string[] = [];
  let interactions: string[] = [];
  let screenshot = '';
  let snapshot = '';
  let loginNote: string | undefined;
  let health: PageHealth | undefined;

  try {
    driver = await PageDriver.launch({
      readOnly: ctx.config.readOnlyExercise,
      mocksPath: ctx.config.mocksPath,
    });

    // Auth-aware: re-verify gated routes logged in, matching the audit pass.
    if (ctx.config.auth) {
      const role = matchAuthRole(ctx.page.route, ctx.config.auth);
      if (role) {
        const login = await driver.loginAs(
          ctx.boot.baseUrl,
          ctx.config.auth,
          role,
        );
        loginNote = login.detail;
      }
    }

    await driver.open(url);
    const exercised = await driver.exercise();
    interactions = loginNote
      ? [`login: ${loginNote}`, ...(exercised.interactions ?? [])]
      : exercised.interactions ?? [];
    consoleErrors = exercised.consoleErrors ?? [];
    try {
      screenshot = await driver.screenshot();
    } catch (err) {
      console.error(`[agent5-verify] screenshot failed: ${String(err)}`);
    }
    try {
      snapshot = await driver.snapshot();
    } catch (err) {
      console.error(`[agent5-verify] snapshot failed: ${String(err)}`);
    }

    health = await driver.health(routePath, ctx.config.auth?.loginUrl);
  } catch (err) {
    // Could not drive the page at all — treat as unverifiable / fail.
    const reason = `Failed to drive ${url}: ${String(err)}.`;
    const result: VerifyResult = {
      page: pageId,
      health: {
        status: 'navigation-failed',
        healthy: false,
        finalUrl: url,
        detail: reason,
      },
      gapsClosed: [],
      gapsOpen: gaps.map((g) => g.id),
      regressions: [],
      pass: false,
    };
    writeArtifacts(ctx, result, reason, consoleErrors, interactions);
    console.error(`[agent5-verify] ${reason}`);
    return result;
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch (err) {
        console.error(`[agent5-verify] driver close failed: ${String(err)}`);
      }
    }
  }

  // No gaps to verify → trivially pass once the page drives without crashing.
  if (gaps.length === 0) {
    const pass = !health || health.status === 'ok';
    const result: VerifyResult = {
      page: pageId,
      health,
      gapsClosed: [],
      gapsOpen: [],
      regressions: [],
      pass,
    };
    writeArtifacts(
      ctx,
      result,
      pass
        ? 'No audit gaps to verify; page drove successfully.'
        : `Page is unhealthy: ${health?.status} — ${health?.detail}`,
      consoleErrors,
      interactions,
      screenshot,
    );
    return result;
  }

  const gapsBlock = gaps
    .map(
      (g) =>
        `- id: ${g.id}\n  category: ${g.category}\n  severity: ${g.severity}\n  description: ${g.description}\n  expected after fix: ${g.recommendation}`,
    )
    .join('\n');

  const priorConsole = ctx.audit?.consoleErrors ?? [];

  const systemInstruction =
    'You are a QA verification agent. A page was just rebuilt to close a list ' +
    'of known gaps. You are given each gap (with a stable id), the console ' +
    'errors observed BEFORE the rebuild, the console errors observed NOW, the ' +
    'interactions exercised, and the current screenshot + DOM snapshot. ' +
    'Decide, per gap id, whether it is now CLOSED or still OPEN, judging ONLY ' +
    'from the supplied evidence. Also report REGRESSIONS: new breakage that the ' +
    'rebuild introduced (new console errors, broken interactions, missing ' +
    'content that previously worked). Respond with STRICT JSON only — no prose.';

  const prompt = [
    `Page: ${pageId}  (${url})`,
    `Purpose: ${ctx.page.purpose}`,
    '',
    '=== GAPS TO VERIFY (each must be judged closed or open) ===',
    gapsBlock,
    '',
    '=== CONSOLE ERRORS BEFORE REBUILD ===',
    priorConsole.length > 0 ? priorConsole.join('\n') : '(none)',
    '',
    '=== CONSOLE ERRORS NOW ===',
    consoleErrors.length > 0 ? consoleErrors.join('\n') : '(none)',
    '',
    '=== INTERACTIONS EXERCISED NOW ===',
    interactions.length > 0 ? interactions.join('\n') : '(none)',
    '',
    '=== CURRENT DOM SNAPSHOT ===',
    snapshot || '(snapshot unavailable)',
    '',
    'The current screenshot is attached as an image.',
    '',
    'Output JSON exactly:',
    '{',
    '  "gapsClosed": ["<gap id>", ...],',
    '  "gapsOpen": ["<gap id>", ...],',
    '  "regressions": ["<concrete description of new breakage>", ...]',
    '}',
    'Every supplied gap id must appear in exactly one of gapsClosed or gapsOpen.',
  ].join('\n');

  let gapsClosed: string[] = [];
  let gapsOpen: string[] = [];
  let regressions: string[] = [];

  try {
    const response = await ctx.gemini.callJson<VerifyJsonResponse>({
      role: 'agent5_verify',
      systemInstruction,
      prompt,
      json: true,
      images: screenshot ? [screenshot] : undefined,
    });

    const validIds = new Set(gaps.map((g) => g.id));
    gapsClosed = toStringArray(response?.gapsClosed).filter((id) => validIds.has(id));
    regressions = toStringArray(response?.regressions);

    // Reconcile: every gap not explicitly reported closed is treated as open.
    const closedSet = new Set(gapsClosed);
    gapsOpen = gaps.map((g) => g.id).filter((id) => !closedSet.has(id));
  } catch (err) {
    // Gemini failure — cannot judge gaps. Fail safe: everything open.
    console.error(`[agent5-verify] Gemini call failed for ${pageId}: ${String(err)}`);
    const result: VerifyResult = {
      page: pageId,
      health,
      gapsClosed: [],
      gapsOpen: gaps.map((g) => g.id),
      regressions: [],
      pass: false,
    };
    writeArtifacts(
      ctx,
      result,
      `Verification model call failed: ${String(err)}.`,
      consoleErrors,
      interactions,
      screenshot,
    );
    return result;
  }

  const pass = computePass(gaps, gapsClosed, regressions, health);

  const result: VerifyResult = {
    page: pageId,
    health,
    gapsClosed,
    gapsOpen,
    regressions,
    pass,
  };
  writeArtifacts(
    ctx,
    result,
    pass ? '' : 'One or more non-low gaps remain open or a regression was found.',
    consoleErrors,
    interactions,
    screenshot,
  );
  return result;
}
