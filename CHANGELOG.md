# Changelog

All notable changes to Reframe are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [0.3.0] — 2026-05-28

Theme: **the SPA earns its labels**. A founder-led critique of the review SPA (every button passes the 5-second "what does this do?" test, brand panel goes visual, broken connectors get wired, and the vibe-coder flow back to Claude Code is named.)

### Added — Review SPA

- **Vibe ⇄ Technical register toggle** in the top bar. One switch swaps every label in the SPA atomically via `review-app/src/copy.ts`. Vibe register avoids engineer vocabulary ("manifest", "fan-out", "approval bundle"); Technical register keeps it.
- **Product summary card** — 5-second answer generated from `scope.productGoal` + finding counts. The elevator pitch the audit already had, surfaced.
- **Row-anchored Approve / Skip / Comment / Copy-as-prompt strip** on every finding. Findings collapsed by default (severity + plain claim); expand for why / fix / signals. Auto-saves debounced. Status pills with Undo. No more scrolling to a footer textbox.
- **"Copy as prompt"** — clipboard-ready markdown block per finding (route + plain claim + suggested fix). **"Copy terminal command"** — the exact `npx reframe rebuild --resume <runDir> --apply-mode pr` invocation. The two connectors between the SPA and a vibe-coder's flow in Claude Code / their terminal.
- **Phone · Tablet · Desktop preset toggle** in the Preview pane. Native-res images in an `overflow:auto` frame — no scaled-iframe blur. Bound to `audit-{mobile,tablet,desktop}.png` already on disk.
- **`Open in new tab ↗`** wired to the audited URL. Replaces the dead "Live View" button (the canonical Norman door from the critique).
- **Visual Brand panel** — clickable color swatch grid (click to copy hex), live type ladder rendered in the brand fonts, voice descriptors as chips. Raw brand bible lives behind `<details>` "Show extracted brand bible". Stubbed `Edit brand & re-audit ↗` CTA points to the existing `npx reframe verify` flow (engine work is out of scope for this PR).
- **New Data / Contract panel** — parallel to Brand. Renders `scope.dataCalls` table + `scope.brokenContracts` list with honest empty state.
- **Filter chips with counts** — `All (n) · Functional (n) · A11y (n) · Brand (n) · Compliance (n)`. Each chip classifies findings by dimension + signal.
- **Resizable, collapsible workspace** — draggable splitter between findings + side column, per-panel collapse toggles, sidebar collapsible. Mobile (`< 1024px`) stacks vertically. Layout persisted to `localStorage` under `reframe.ui.v1`.
- **Engine drawer** — slides in from the right. Houses raw state + approvals JSON (where the "JS Telemetry Blueprint" debug dump used to sit inline below the fold).
- **Token-driven theming** — all colors flow through CSS custom properties in `review-app/src/tokens.css`. The SPA writes `brand.resolved.json` colors into `--rf-*` vars on mount, so the review tool itself reflects the brand the audit found.

### Changed

- **`review-app/src/App.tsx`** — 2,739 → ~290 lines of orchestration; 8 focused components under `review-app/src/components/`.
- **`review-app/src/index.css`** — 40 KB → 18 KB; gzipped CSS bundle now 3.9 KB.
- **`src/server.ts` `/api/run`** now also returns `brand` and `scope` (read-only file reads of `brand.resolved.json` + `scope.json`) so the SPA can render the Brand and Contract panels without a second fetch.

### Removed

- The "v2 Zen stepper" approve flow (`Step 1 / Step 2 / Step 3 ↓` cards). Replaced by the per-row inline control strip — the user works finding-by-finding, not step-by-step across all findings.
- The right-edge drag-resize handle on the preview. Replaced by the Phone/Tablet/Desktop preset toggle.
- "Save Selections" + "Download Changes Bundle" button pair. Replaced by a single register-aware primary action (`Send approved fixes to my IDE` / `Export approval bundle`) and an auto-saved indicator.
- "Visual Refactoring Workspace" tagline in Vibe register. Replaced with the brief's mandated voice — fragments, weapons.

### Added — Engine hardening (dogfood-driven)

- **PageDriver auto-dismisses unhandled dialogs** (`alert` / `confirm` / `prompt` / `beforeunload`). A click in `exercise()` that triggers a synchronous `window.alert` previously blocked every subsequent Playwright operation until the dialog was manually dismissed — there was no audit-side handler. Reframe-on-Reframe surfaced this hang against the redesigned SPA's toast button.
- **PageDriver auto-closes popup windows.** `<a target="_blank">` clicks under `exercise()` spawn new pages in the BrowserContext; they used to stack up silently and eventually wedge the parent page's locator queries on Windows. Now closed on spawn, recorded as `[popup]` console entries.
- **`exercise()` hard wall-clock cap of 45s.** Per-click timeouts (2s × 60 clickables) were bounded in theory, but `count()` and `getAttribute()` had no explicit timeouts and could chain forever on pathological DOMs. All per-attribute calls now timeout at 1s and the outer loop breaks at 45s with `exercise budget exhausted` interactions recorded so the audit still proceeds.
- **`/api/screenshot/:slug?breakpoint=`** falls back to the default `audit.png` when a per-breakpoint capture wasn't recorded (instead of returning 404). Lets the SPA's Phone / Tablet preset toggle show a usable image on runs that didn't exercise multi-breakpoint capture.

### Fixed — Review SPA (caught by Reframe-on-Reframe)

- **Toast no longer blocks underlying clicks** (`pointer-events: none`). The first dogfood run flagged this as a critical functional regression: the success toast intercepted pointer events on the workspace for its 3-second visible window.
- **Phone / Tablet preset tabs no longer dead-end on runs without per-breakpoint captures.** They now fall back to the desktop screenshot rather than rendering as permanently disabled controls.
- **Demo banner copy tightened** — "A demo run. Connect a real audit with…" → "Demo run. Connect with: npx reframe review &lt;runDir&gt;." (vibe register matches the brief's voice rules — fragments).
- **`window.alert` → inline `rf-toast` component** for the primary action confirmation. Modal alerts are bad UX in general and also exactly the kind of thing `exercise()` interacts badly with.

### Docs

- **README — "Hundreds of small agents, not one big one"** section. Names the 6×30=180 parallel-calls math, the three reasons (accuracy, cost, 15-min runs vs 15-hour incomplete ones), and calls out Gemini Flash as the default for its 3–7× speed/$ ratio.

## [0.2.0] — 2026-05-27

Theme: **the dual-register sprint**. Every finding the pipeline emits now ships in two registers — plain-English for the founder, technical for the engineer — and the UI, CI integration, and review surfaces all light up around that.

### Added — Findings & agents

- **Dual-register `Finding` schema** (`FindingMeta` mixin on `Gap`, `ComplianceFinding`, `BrokenContract`): every finding carries `plain`, `whyItMatters`, `confidence`, and `dimension` alongside the existing technical fields. All optional so older runs still load.
- **`FindingDimension` enum** with eleven dimensions — functional, ux, visual-hierarchy, brand-voice, microcopy, responsive, accessibility, performance, compliance, data-contract, security. Drives filter chips and the Founder Digest.
- **Agent 1 — 4-persona scan**. Added Camille (brand voice + microcopy) to the existing Arthur (QA) / Elena (UX + responsive) / Marcus (compliance + accessibility) panel. Pinned brand spec is passed into every audit prompt so brand drift is flagged against a concrete reference.
- **Agent 6 — dual-register output**. System instruction and prompt updated to require `plain`, `whyItMatters`, `confidence`, `dimension` on every finding. Defaults `dimension` to `compliance` when omitted to keep filter chips populated.
- **Bootstrap brand inference upgrade**. `collectThemeFiles` now finds shadcn `components.json`, app-router root CSS, palette / colors / brand modules. New `extractStaticTokens` parses Tailwind configs, CSS custom properties, font families via regex (no sandboxed user-code execution). `collectVoiceSamples` pulls real product copy from `<h1>` / `<button>` content. The LLM call now **normalizes** instead of parsing, with an explicit no-generic-fallback instruction.
- **Multi-breakpoint capture** in `PageDriver.screenshotAt(w, h)`. Agent 1 walks `DEFAULT_BREAKPOINTS` (mobile 390×844 / tablet 768×1024 / desktop 1440×900) after the primary capture. Files written as `audit-{name}.png`; paths exposed via `AuditResult.breakpointScreenshots`.

### Added — CLI

- **`reframe bootstrap <target>`** subcommand + `--bootstrap-only` flag. Runs Stage 0 + brand resolution and exits without booting the dev server or running agents. Writes `<runDir>/brand.candidate.json` and **renders the candidate inline** via the same `renderBrand` formatter `show-brand` uses. Interactive TTY prompt offers to write `config/brand.json` on success — silent in non-TTY contexts.
- **`reframe show-brand <runDir>`** subcommand. Pretty-prints the bootstrapped (or resolved) brand spec with pin status and 3-step pin instructions.
- **`reframe pin <runDir> [--out <path>] [--force]`** subcommand. Non-interactive equivalent of the `bootstrap` y/N prompt — same write semantics, works in CI / shell scripts. Refuses to overwrite an existing pinned brand unless `--force` is set.
- **`reframe verify <runDir>`** subcommand + `--verify-only` flag. Re-runs only Agent 5 against an existing run dir. Reads the target out of `manifest.json`, resets the verify checkpoint state, rehydrates `ctx.audit` from disk, runs Agent 5, writes a fresh `verify.json`. Skips commit/PR/scaffold (verify is read-only). Tight dev loop: fix by hand, verify in ~30s.
- **`--diff-only [--diff-base <ref>]`**. Filters per-page fan-out to source files changed on the current branch vs the base. Base auto-resolves `origin/main` → `origin/master` → `main` → `master`. The flag that makes Reframe usable as a CI gate on big repos.
- **`--post-findings`**. In `--apply-mode pr`, posts the top-3 plain-English digest as a PR conversation comment after opening the PR — GitHub sends notifications for comments but not for body edits. Off by default.
- **`--json-summary`**. Prints a single-line JSON summary as the LAST stdout line. `tail -n 1 | jq` works without parsing markdown. Stable v1 schema with `schemaVersion: 1`.

### Added — Review app

- **Dual-register toggle** — one-click switch between plain-English and technical language on every finding card.
- **Founder Digest** — top-of-dashboard card per page with the top-5 findings ranked by severity × confidence.
- **Filter chips** — severity, dimension (chips populated from findings present on the page), and a min-confidence slider.
- **Breakpoint strip** — buttons for Default / iPhone / iPad / Desktop. Selecting swaps the screenshot URL via `?breakpoint=`. CSS `resize: horizontal` on the preview wrapper lets reviewers drag arbitrary widths.
- **Run Overview** (sentinel `__overview__` slug) — cross-page "criticals first" view. Severity bucket counts at the top, ranked findings list (top 50 by impact across audit + compliance), click-through to source page.
- **Per-row Skip / Restore in Run Overview** — audit gaps AND compliance findings. Optimistic local update with rollback-on-failure. Page-level bypass dominates per-finding decisions.
- **Per-page compliance findings card** — was missing entirely; now sits between the preview and the UX/Design spec rows. Same Skip / Restore as Run Overview. Hidden when the page has no compliance findings.
- **Pattern insights panel** in Run Overview — driven by the new `/api/telemetry` endpoint. Surfaces dimensions and severities the reviewer has skipped ≥70% of the time across recent runs (sample ≥5). Fail-open: hidden when the endpoint errors or returns empty.
- **`PageApproval.complianceFindings`** map — per-compliance-finding apply/skip decisions keyed by `${ruleId}::${location}`. Parity with the existing `gaps` map for audit findings.

### Added — Pull request output

- **Plain-English summary** at the top of every PR body, ranked by severity × confidence across audit + compliance. The non-technical-friendly version of the manifest table that follows.

### Added — LLM I/O & schemas

- **`callJsonSchema<S extends ZodTypeAny>(schema, opts): Promise<z.infer<S>>`** on `IGeminiClient`. Validates response shape, retries once with Zod issues fed back into the prompt before failing. Catches cross-LLM drift at the wire.
- **Zod schemas** in `src/schemas/agent-outputs.ts` for Audit, Compliance, UX, Design, Verify, Mapper, and Brand-Bootstrap outputs. Source of truth for the JSON shapes every agent emits.
- **All JSON-emitting agents migrated** to `callJsonSchema` — Agent 1, 2, 3, 5, 6, plus the Stage 0 mapper and its brand sub-call. Agent 4 (Code) stays on `call()` since it emits raw diff text.

### Added — Server / telemetry

- **`/api/telemetry`** endpoint. Walks sibling run dirs (capped at 50 most-recent, 90 days back), reads each run's `audit.json` + `compliance.json` + `approvals.json`, and aggregates apply/skip decisions per dimension and per severity. Computes "insights": (axis, value) tuples with skip-rate ≥70% AND sample ≥5, each shipped with a ready-rendered headline. Page-level bypass propagates down — every finding on a bypassed page counts as skipped.
- **Engine honors `approval.complianceFindings`** — orchestrator filters `ctx.compliance.findings` after compliance runs and before agent 4, matching the existing `approval.gaps` filter behavior. Recomputes `compliance.clean` after the filter. PR-body's approvals ledger also lists Compliance Finding Decisions.

### Added — CI integration

- **`.github/workflows/reframe-pr-template.yml`** — drop-in GitHub Action template for application repos. Runs `--diff-only --post-findings --json-summary --quick-scan --max-pages 12` on every PR. Uploads `runs/` and the JSON summary as artifacts (14-day retention). Cancels in-flight runs on each new push via `concurrency`.

### Added — Tests & eval

- **`tests/fixtures/`** — contributor-facing fixture format. Seven hand-curated `(input, expected, assertions)` triples: 4 audit (broken-submit, auth-redirect, clean, mobile-CTA, brand-voice-drift, accessibility-missing-labels) + 3 compliance (missing-TCPA, fabricated-FTC-savings, clean).
- **`npm run check-fixtures`** — structural validator. Confirms every fixture has the required shape, agent points to a known agent, assertions use recognized kinds with the right fields. No LLM calls.
- **`npm run eval`** — assertion runner. Self-consistency mode runs each fixture's `assertions` block against its own `expected` block (catches contradictions, runs in CI on every PR).
- **`npm run eval -- --live --provider gemini|anthropic|openai`** — live LLM eval. Calls the actual production prompts of Agent 1 and Agent 6 against fixture inputs via real `GeminiClient`. Reuses the same assertion engine. Reports wall-clock LLM time + per-agent counts. Skips gracefully when the required API key isn't set.
- **Prompt extraction** — `AUDIT_SYSTEM_INSTRUCTION` / `buildAuditPrompt` / `normaliseGap` exported from agent1; `COMPLIANCE_SYSTEM_INSTRUCTION` / `buildCompliancePrompt` / `normaliseComplianceFinding` exported from agent6. Eval calls the same prompts the production agents run — no duplication.

### Changed

- **Bootstrap brand inference** now runs unconditionally (was: only when the mapper omitted the field) so the static extraction lands on every run.
- **`AgentContext.brand`** is now passed into every Agent 1 audit prompt, with explicit "lower confidence on voice findings when the brand is unpinned" guidance.
- **Server `/api/screenshot/:slug`** accepts an optional `?breakpoint=<name>` query parameter to serve `audit-{name}.png`. Strict safelist on the name prevents path traversal.
- **PR body** now leads with the plain-English summary block before the manifest table.

### Fixed

- **`IGeminiClient.callJsonSchema` generic inference** — was using a structural schema surrogate that prevented TypeScript from binding `T`, so every `response.gaps` / `response.findings` was typed `{}`. The project's `tsc` was silently masking the resulting errors by bailing on a `node10` deprecation before compile. Fixed both the interface and the implementation to use the Zod-canonical `<S extends ZodTypeAny>(schema: S): Promise<z.infer<S>>` pattern. Added `"ignoreDeprecations": "6.0"` to `tsconfig.json` so future `npm run typecheck` runs actually surface real errors.

### Docs

- **README refresh** — every section updated to surface the sprint's additions. New CI integration section documenting the GitHub Action template end-to-end.
- **Customer journey maps** (`docs/`) — three single-page visual artifacts mapping the experience of the primary ICP (Maya, the vibe-coding founder) plus two adjacent personas (Devon, the agency lead; Priya, the recovering senior engineer). Each artifact has an emotional arc, a 9-stage grid of mindset/doing/quote/emotion/touchpoint/friction/opportunity, and trio annotations from three expert personas (Linnea/Mira/Rishi).
- **`tests/fixtures/README.md`** — fixture format spec + assertion vocabulary + how-to-contribute guide.
- **CLAUDE.md** — scope boundary clarified: this repo contains only the open-source local-first engine; commercial SaaS (Cloud Run + Firebase) lives in a separate `rebuild-saas` repo.

### Deferred (with reasoning)

The trio review surfaced these as legitimately useful but explicitly out of scope for v1:

- **Inline PR review comments** (file:line precision). Compliance findings have file:line, but those line numbers shift after agent 4's edits — posting against the merge base requires juggling commit SHAs the engine doesn't currently track. The `--post-findings` conversation comment lands the same data in the thread reviewers actually read. Revisit when there's user signal that file:line precision is the bottleneck.
- **Dedicated brand-voice agent (Agent 7)**. The Camille persona inside Agent 1 exercises the brand-voice dimension on every page; the new fixture `05-brand-voice-drift` tests it. Promoting to a standalone agent would add a 7th entry to `AgentName`, `RunState.pages.agents`, the orchestrator DAG, per-agent UI surfaces, manifest counts — substantial architectural work that doesn't unlock new capability vs the inline scan. Promote when fixture coverage proves the inline path is bottlenecked.
- **Per-page compliance card per-finding Skip UI**. The Run Overview surfaces per-finding skip for compliance now; the per-page detail card still uses a single page-level decision. Adding parallel UI is mechanical work, deferred until reviewers ask.
- **Bulk select + bulk approve/skip from Overview**. Per-row Skip lands fast enough that the bulk-select complexity isn't justified yet. Revisit if runs routinely produce 200+ findings.

---

## [0.1.0]

Initial open-source release. The 1-mapper + 6-agent fan-out, the review SPA, the bootstrap brand pin gate, broken-contract detection, auth-aware auditing, live-backend safety, resumable runs, Windows-hardened scratch. See `README.md` for the full scope of v0.1.
