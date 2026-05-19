#!/usr/bin/env node
/**
 * gemini-fix.mjs — parallel Gemini-driven fix runner.
 *
 * Fans out one Gemini API call per file-group (disjoint file ownership so the
 * calls never collide), each producing the full rewritten content for its
 * files. The shared type contract is already frozen in src/types.ts; this
 * script only implements the consumers.
 *
 *   node scripts/gemini-fix.mjs            # run every call
 *   node scripts/gemini-fix.mjs A-browser  # run only the named call(s)
 *
 * Output is written straight to the target files — review with `git diff`.
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'gemini-3.1-pro-preview';
const CALL_TIMEOUT_MS = 300_000;

/* ─────────────────────────── env + key ─────────────────────────── */

function loadEnvLocal() {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!API_KEY) {
  console.error('No GEMINI_API_KEY / GOOGLE_API_KEY found in env or .env.local');
  process.exit(1);
}

/* ─────────────────────────── frozen contract ─────────────────────────── */

const CONTRACT = `
These types are ALREADY committed in src/types.ts. Do NOT redefine them —
import them from '../types' or './types' as appropriate.

  export type PageHealthStatus =
    | 'ok' | 'auth-redirect' | 'error-overlay' | 'http-error' | 'navigation-failed';
  export interface PageHealth {
    status: PageHealthStatus;
    healthy: boolean;        // true ONLY when status === 'ok'
    finalUrl: string;        // URL landed on after redirects
    httpStatus?: number;     // main document HTTP status when known
    detail: string;          // human-readable explanation, always set
  }
  export type PageOutcome =
    | 'audited' | 'redirected' | 'errored' | 'boot-failed' | 'drive-failed';

  AuditResult   gained  health?: PageHealth
  VerifyResult  gained  health?: PageHealth
  PageManifestEntry gained  status: PageOutcome (REQUIRED)  and  health?: PageHealth
  PipelineConfig gained  maxPages?: number,  quickScan: boolean (required),
                         sampleParams: Record<string,string> (required)

NEW MODULE — src/sample-params.ts (created by call B-agents) MUST export exactly:
  export const DEFAULT_SAMPLE_PARAM = '1';
  export function isDynamicRoute(route: string): boolean;
  export function resolveRoutePath(route: string, sampleParams: Record<string,string>): string;

NEW METHOD — src/browser.ts PageDriver (added by call A-browser):
  async health(expectedRoute: string, loginPath?: string): Promise<PageHealth>

EFFORT-ESTIMATE WEIGHTS (call C-proposed): minutes per audit gap / compliance
finding, by severity:  critical = 45, high = 25, medium = 12, low = 5.
`.trim();

const SYSTEM = `You are a meticulous senior TypeScript engineer editing a real, working
Node 24 + TypeScript (CommonJS, "strict": true) codebase: the "rebuild-pipeline".
You will be given a frozen type contract, a precise task, and the CURRENT FULL
CONTENTS of one or more files.

RULES:
- Return the COMPLETE new content of every file you were asked to write.
- Change ONLY what the task requires. Preserve every other line — comments,
  imports, formatting, the heavily-commented house style — VERBATIM.
- The code must compile under "strict": true with no type errors.
- Do not add new npm dependencies. Use only what the file already imports plus
  Node built-ins and 'playwright'.
- Match the existing file's comment density and style exactly.
- Output ONLY a JSON object, no prose, no markdown fences:
  { "files": { "<relative/path>": "<full file content>", ... } }`;

/* ─────────────────────────── per-call specs ─────────────────────────── */

const CALLS = [
  {
    id: 'A-browser',
    files: ['src/browser.ts'],
    spec: `Add honest page-health detection to PageDriver.

1. Track the main navigation. Add two private fields, e.g.
   \`private lastNavStatus: number | undefined;\` and
   \`private navFailed = false;\`. At the START of \`open()\` reset both
   (\`this.navFailed = false; this.lastNavStatus = undefined;\`). \`page.goto\`
   returns a \`Response | null\` — capture it on BOTH the networkidle attempt
   and the domcontentloaded fallback: on a successful goto set
   \`this.lastNavStatus = resp?.status();\`. If the fallback's catch block runs
   (both navigations failed) set \`this.navFailed = true\`.

2. Add a public method:
     async health(expectedRoute: string, loginPath?: string): Promise<PageHealth>
   Compute \`status\` in THIS priority order:
   (a) 'navigation-failed' — if this.navFailed.
   (b) 'http-error' — if this.lastNavStatus !== undefined && this.lastNavStatus >= 400.
   (c) 'error-overlay' — detect a framework dev error overlay. In a try/catch,
       page.evaluate() returning a boolean true if ANY of these is present:
       a <nextjs-portal> element whose shadowRoot contains
       '[data-nextjs-dialog]' or '[data-nextjs-dialog-overlay]' or
       '#nextjs__container_errors_label'; a <vite-error-overlay> element;
       or document.body.innerText matching
       /Unhandled Runtime Error|Build Error|Failed to compile|Application error: a (server|client)-side exception/i.
   (d) 'auth-redirect' — parse the pathname of this.page.url(). Normalise
       loginPath to have a leading slash. If expectedRoute is NOT itself a
       login route AND the final pathname looks like a login page — it equals
       or startsWith the normalised loginPath, OR it matches
       /(^|\\/)(login|sign-?in|signin|auth)(\\/|$)/i — then 'auth-redirect'.
       If expectedRoute itself matches that login regex, never flag it.
   (e) otherwise 'ok'.
   Return { status, healthy: status === 'ok', finalUrl: this.page.url(),
            httpStatus: this.lastNavStatus, detail }. \`detail\` must be a
   clear one-sentence human explanation specific to the case.

3. Import the PageHealth type from './types'. Preserve EVERYTHING else in the
   file verbatim — DESTRUCTIVE_LABEL, launch(), loginAs(), exercise(),
   screenshot(), snapshot(), close(), all comments.`,
  },
  {
    id: 'B-agents',
    files: ['src/sample-params.ts', 'src/agents/agent1-audit.ts', 'src/agents/agent5-verify.ts'],
    spec: `Three files.

FILE src/sample-params.ts (NEW — create it). A small deterministic helper for
dynamic Next.js route segments. Match the house comment style. Export exactly:
  - export const DEFAULT_SAMPLE_PARAM = '1';
  - export function isDynamicRoute(route: string): boolean
      true when the route contains a '[...]' segment.
  - export function resolveRoutePath(route, sampleParams): string
      Replace each dynamic segment with a concrete value:
        [param]         -> sampleParams[param] ?? DEFAULT_SAMPLE_PARAM
        [...param]      -> same lookup on 'param'
        [[...param]]    -> same lookup on 'param'
      Non-dynamic segments unchanged. Preserve the leading slash. The param
      NAME is the bracket contents with any leading dots removed.

FILE src/agents/agent1-audit.ts (MODIFY). Import resolveRoutePath from
'../sample-params'. Build the driven URL from the RESOLVED path:
  const routePath = resolveRoutePath(ctx.page.route, ctx.config.sampleParams);
  const url = \`\${ctx.boot.baseUrl}\${routePath}\`;
After driving the page (after exercise/snapshot/screenshot), call
  const health = await driver.health(routePath, ctx.config.auth?.loginUrl);
Set \`health\` on the SUCCESS-path AuditResult. On the "could not drive the
page at all" early return, set health to
  { status: 'navigation-failed', healthy: false, finalUrl: url, detail: driveError ?? 'page could not be driven' }.
On the boot-not-running early return, leave health undefined. Add a short
"PAGE HEALTH" block to the audit model prompt (so the model knows if it is
looking at a redirect/error page rather than the intended screen). In
renderMd add a line near the top: \`Page health: <status> — <detail>\` when
health is present. Preserve all else.

FILE src/agents/agent5-verify.ts (MODIFY). Import resolveRoutePath from
'../sample-params' and use it so dynamic routes resolve (apply it to
ctx.page.route before building the verify URL). After driving, call
driver.health(resolvedRoutePath, ctx.config.auth?.loginUrl) and attach it to
VerifyResult.health on every returned result (including early-return failure
results — use a sensible PageHealth there). Update computePass so a page whose
health is present and health.status !== 'ok' can NEVER pass: give computePass
the health and return false when it is unhealthy. The "no gaps -> trivially
pass" branch must also fail when health is not ok. Preserve all else.`,
  },
  {
    id: 'C-proposed',
    files: ['src/proposed-changes.ts'],
    spec: `Add a severity-weighted effort estimate and honest page-health
surfacing to the proposed-changes report.

1. Effort estimate. Minutes per audit gap AND per compliance finding by
   severity: critical 45, high 25, medium 12, low 5. Sum across every page.
   Add a "## Effort estimate" section AFTER the bullet counts and BEFORE the
   "## Summary" table. Render a headline: when total < 90 minutes,
   \`**≈ <N>-minute optimization plan**\`; otherwise
   \`**≈ <H>h <M>m optimization plan**\`. Below it a small markdown table
   breaking the estimate down by severity (count and subtotal minutes).

2. Honest page health. Add a "Health" column to the Summary table showing
   audit.health?.status (or '—' when absent). In each per-screen section, when
   audit.health exists and audit.health.status !== 'ok', render a prominent
   warning line BEFORE the audit gaps:
   \`> ⚠ Page health: **<status>** — <detail>. Findings below may not reflect the intended screen.\`

Preserve the existing apply-pass instructions block, the UX/design/compliance
rendering, the cell() helper and everything else.`,
  },
  {
    id: 'D-orchestrator',
    files: ['src/orchestrator.ts'],
    spec: `Three changes to the orchestrator.

1. --max-pages cap. After Stage 0 has produced \`scope\` and BEFORE the run
   state is seeded / the fan-out runs: if config.maxPages is set and
   scope.pages.length > config.maxPages, slice scope.pages to the first
   config.maxPages entries (mutate so state seeding, fan-out and
   proposed-changes all see the capped list) and push to extraAlerts:
   "Page cap: processing N of M mapped pages (--max-pages N). Re-run without
   --max-pages for full coverage." Log it too.

2. Quick-scan log. If config.quickScan, log
   "[pipeline] quick-scan tier: per-page review agents on the cheap model."
   near the fan-out start.

3. Honest manifest status. Add a helper
     function deriveOutcome(boot: BootResult, audit: AuditResult | undefined): PageOutcome
   boot.status !== 'running' -> 'boot-failed'; else no audit or no audit.health
   -> 'drive-failed'; else map audit.health.status: 'ok'->'audited',
   'auth-redirect'->'redirected', 'http-error'|'error-overlay'->'errored',
   'navigation-failed'->'drive-failed'.
   EVERY pageEntries.push(...) must now include \`status\` and \`health\`:
   - In processPage (normal path): status = deriveOutcome(boot, ctx.audit),
     health: ctx.audit?.health.
   - In the runPool abort-path push: status = boot.status !== 'running'
     ? 'boot-failed' : 'drive-failed'; health omitted.
   Also make the review-mode \`pass\` honest: in review mode, pass should be
   \`reviewAgents.every(a => pageState.agents[a] === 'done') && deriveOutcome(boot, ctx.audit) === 'audited'\`
   so a screen that was an auth redirect or error page does NOT pass.
   Import PageOutcome from './types' (BootResult and AuditResult are already
   imported there).

Preserve all other logic verbatim — scratch cleanup, branch/PR, resume,
test scaffold, the finally block.`,
  },
  {
    id: 'E-cli-config',
    files: ['src/cli.ts', 'src/config.ts'],
    spec: `Add three operator flags. Two files.

FILE src/config.ts (MODIFY).
- ParsedArgs: add  maxPages?: number;  quickScan?: boolean;  params?: string;
- parseArgs: handle  --max-pages <n>  (positive integer, else throw),
  --quick-scan  (boolean flag),  --params <path>  (string).
- Add a loader: read the --params JSON file into a Record<string,string>
  (coerce every value with String()); default to {} when --params is absent.
- In resolveConfig set the three new PipelineConfig fields:
  maxPages: args.maxPages (undefined when not given),
  quickScan: args.quickScan ?? false,
  sampleParams: <loaded map or {}>.
- Quick-scan model override: after \`loadModels()\`, when quickScan is true,
  replace agent1_audit, agent2_ux, agent3_design and agent5_verify with the
  \`mechanical\` model id (the cheap tier). Keep mapper/code/compliance.

FILE src/cli.ts (MODIFY). Document the three new flags in the FLAGS section of
the HELP string, in the existing style:
  --max-pages <n>    Cap pages processed in the fan-out (cost/speed control).
  --quick-scan       Route per-page review agents to the cheap model tier.
  --params <path>    JSON map of dynamic-route sample values, e.g.
                     { "id": "1", "slug": "demo" } — so /leads/[id] is driven.
Add one EXAMPLES line showing --max-pages + --quick-scan. Preserve all else.`,
  },
  {
    id: 'F-manifest',
    files: ['src/manifest.ts'],
    spec: `Add an honest outcome column to the manifest's Pages table.

In renderManifestMd, the Pages table: add a "Status" column (showing
p.status — audited / redirected / errored / boot-failed / drive-failed)
immediately AFTER the "Result" column; update the header row, the divider
row and every data row. Above the table, in addition to the existing
"N / M pages passed." line, add a second line with the honest outcome tally,
e.g. "<a> audited · <r> redirected · <e> errored · <f> failed." counting
p.status across pagesProcessed (failed = boot-failed + drive-failed).
Preserve the Test Users and Alerts sections, formatDuration, cell() and
writeManifest exactly.`,
  },
  {
    id: 'G-tests',
    files: [
      'scripts/test-login.mjs',
      'src/test/sample-params.test.ts',
      'src/test/state.test.ts',
    ],
    spec: `Create a login smoke test and two unit-test files. All NEW files.

FILE scripts/test-login.mjs (NEW, ESM). A standalone Playwright login smoke
test — the lasting guard that auth-aware login still works. It must:
  - Parse --auth <path> (required) and --base-url <url> (required) from argv.
  - Import { PageDriver } from '../dist/browser.js' and
    { loadAuthConfig } from '../dist/auth.js'. If '../dist/browser.js' does
    not exist, print "Build first: npm run build" and exit 1.
  - For each role in the loaded auth config: PageDriver.launch({readOnly:true}),
    call loginAs(baseUrl, authConfig, role), close the driver, record ok+detail.
  - Print one PASS/FAIL line per role with the detail.
  - Exit 0 only if every role logged in ok, else exit 1.
  - Include a header comment with a usage example.

FILE src/test/sample-params.test.ts (NEW). Use node:test and node:assert/strict.
Import { resolveRoutePath, isDynamicRoute, DEFAULT_SAMPLE_PARAM } from
'../sample-params'. Cover: a static route returned unchanged; '/leads/[id]'
with { id: '7' } -> '/leads/7'; a missing param falls back to
DEFAULT_SAMPLE_PARAM; a catch-all '/docs/[...slug]' resolves; isDynamicRoute
true for '/x/[id]' and false for '/x/y'.

FILE src/test/state.test.ts (NEW). Use node:test and node:assert/strict.
Import { newRunState, saveState, loadState } from '../state'. newRunState's
first arg is a PipelineConfig but only reads .runDir and .projectSlug — pass
\`{ runDir, projectSlug: 'demo' } as unknown as import('../types').PipelineConfig\`.
Test the resume ledger round-trip: create a temp dir under os.tmpdir(),
newRunState with a couple of slugs, saveState, loadState, assert the reload
deep-equals on projectSlug + page slugs; then set one page's
agents.audit = 'done', saveState again, loadState again, assert that 'done'
persisted (this is the core resume guarantee). Clean up the temp dir in the
end. Keep it tsc-strict-clean.`,
  },
];

/* ─────────────────────────── runner ─────────────────────────── */

const ai = new GoogleGenAI({ apiKey: API_KEY });

function readFileBlocks(files) {
  return files
    .map((rel) => {
      const abs = path.join(ROOT, rel);
      const exists = fs.existsSync(abs);
      const head = `=== FILE: ${rel} ${exists ? '(EXISTING — rewrite in full)' : '(NEW — create)'} ===`;
      return `${head}\n${exists ? fs.readFileSync(abs, 'utf8') : '(this file does not exist yet)'}`;
    })
    .join('\n\n');
}

function extractText(res) {
  if (typeof res?.text === 'string') return res.text;
  const parts = res?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p?.text ?? '').join('');
}

function parseFiles(raw) {
  let txt = raw.trim();
  if (txt.startsWith('```')) txt = txt.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
  const obj = JSON.parse(txt);
  if (!obj || typeof obj.files !== 'object') throw new Error('response missing "files"');
  return obj.files;
}

async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timed out after ${ms}ms (${label})`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function runCall(call) {
  const prompt = [
    SYSTEM,
    '',
    '=== FROZEN TYPE CONTRACT ===',
    CONTRACT,
    '',
    '=== TASK ===',
    call.spec,
    '',
    '=== CURRENT FILE CONTENTS ===',
    readFileBlocks(call.files),
  ].join('\n');

  const res = await withTimeout(
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', maxOutputTokens: 65536 },
    }),
    CALL_TIMEOUT_MS,
    call.id,
  );

  const raw = extractText(res);
  if (!raw || !raw.trim()) throw new Error('empty response');

  let files;
  try {
    files = parseFiles(raw);
  } catch (err) {
    const dump = path.join(ROOT, `scripts/.gemini-${call.id}.raw.txt`);
    fs.writeFileSync(dump, raw, 'utf8');
    throw new Error(`parse failed (${err.message}) — raw saved to ${dump}`);
  }

  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`empty content for ${rel}`);
    }
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    written.push(rel);
  }
  return written;
}

async function main() {
  const only = process.argv.slice(2);
  const calls = only.length > 0 ? CALLS.filter((c) => only.includes(c.id)) : CALLS;
  if (calls.length === 0) {
    console.error(`No matching calls. Known: ${CALLS.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`[gemini-fix] running ${calls.length} call(s) in parallel on ${MODEL}\n`);
  const started = Date.now();

  const results = await Promise.allSettled(
    calls.map(async (call) => {
      const t0 = Date.now();
      const written = await runCall(call);
      console.log(`  ✓ ${call.id} (${((Date.now() - t0) / 1000).toFixed(0)}s) → ${written.join(', ')}`);
      return call.id;
    }),
  );

  console.log(`\n[gemini-fix] done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed++;
      console.error(`  ✗ ${calls[i].id}: ${r.reason?.message ?? r.reason}`);
    }
  });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[gemini-fix] FATAL:', err?.stack ?? err);
  process.exit(1);
});
