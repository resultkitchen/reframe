# Changelog

All notable changes to Reframe are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [Unreleased] — v0.2.0 sprint

Theme: **the dual-register sprint**. Every finding the pipeline emits now ships in two registers — plain-English for the founder, technical for the engineer — and the UI, CI integration, and review surfaces all light up around that.

### Added — Findings & agents

- **Dual-register `Finding` schema** (`FindingMeta` mixin on `Gap`, `ComplianceFinding`, `BrokenContract`): every finding carries `plain`, `whyItMatters`, `confidence`, and `dimension` alongside the existing technical fields. All optional so older runs still load.
- **`FindingDimension` enum** with eleven dimensions — functional, ux, visual-hierarchy, brand-voice, microcopy, responsive, accessibility, performance, compliance, data-contract, security. Drives filter chips and the Founder Digest.
- **Agent 1 — 4-persona scan**. Added Camille (brand voice + microcopy) to the existing Arthur (QA) / Elena (UX + responsive) / Marcus (compliance + accessibility) panel. Pinned brand spec is passed into every audit prompt so brand drift is flagged against a concrete reference.
- **Agent 6 — dual-register output**. System instruction and prompt updated to require `plain`, `whyItMatters`, `confidence`, `dimension` on every finding. Defaults `dimension` to `compliance` when omitted to keep filter chips populated.
- **Bootstrap brand inference upgrade**. `collectThemeFiles` now finds shadcn `components.json`, app-router root CSS, palette / colors / brand modules. New `extractStaticTokens` parses Tailwind configs, CSS custom properties, font families via regex (no sandboxed user-code execution). `collectVoiceSamples` pulls real product copy from `<h1>` / `<button>` content. The LLM call now **normalizes** instead of parsing, with an explicit no-generic-fallback instruction.
- **Multi-breakpoint capture** in `PageDriver.screenshotAt(w, h)`. Agent 1 walks `DEFAULT_BREAKPOINTS` (mobile 390×844 / tablet 768×1024 / desktop 1440×900) after the primary capture. Files written as `audit-{name}.png`; paths exposed via `AuditResult.breakpointScreenshots`.

### Added — CLI

- **`reframe bootstrap <target>`** subcommand + `--bootstrap-only` flag. Runs Stage 0 + brand resolution and exits without booting the dev server or running agents. Writes `<runDir>/brand.candidate.json`. Interactive TTY prompt offers to write `config/brand.json` on success — silent in non-TTY contexts.
- **`reframe show-brand <runDir>`** subcommand. Pretty-prints the bootstrapped (or resolved) brand spec with pin status and 3-step pin instructions. Closes the bootstrap UX loop without spinning up the SPA.
- **`--diff-only [--diff-base <ref>]`**. Filters per-page fan-out to source files changed on the current branch vs the base. Stage 0 still maps the whole app; only the agent pool narrows. Base auto-resolves `origin/main` → `origin/master` → `main` → `master`. The flag that makes Reframe usable as a CI gate on big repos.
- **`--post-findings`**. In `--apply-mode pr`, posts the top-3 plain-English digest as a PR conversation comment after opening the PR — GitHub sends notifications for comments but not for body edits. Off by default.
- **`--json-summary`**. Prints a single-line JSON summary as the LAST stdout line. `tail -n 1 | jq` works without parsing markdown. Stable v1 schema with `schemaVersion: 1`.

### Added — Review app

- **Dual-register toggle** — one-click switch between plain-English and technical language on every finding card.
- **Founder Digest** — top-of-dashboard card per page with the top-5 findings ranked by severity × confidence.
- **Filter chips** — severity, dimension (chips populated from findings present on the page), and a min-confidence slider.
- **Breakpoint strip** — buttons for Default / iPhone / iPad / Desktop. Selecting swaps the screenshot URL via `?breakpoint=`. CSS `resize: horizontal` on the preview wrapper lets reviewers drag arbitrary widths.
- **Run Overview** (sentinel `__overview__` slug) — cross-page "criticals first" view. Severity bucket counts at the top, ranked findings list (top 50 by impact across audit + compliance), click-through to source page.
- **Per-row Skip / Restore in Run Overview** — audit gaps AND compliance findings. Optimistic local update with rollback-on-failure. Page-level bypass dominates per-finding decisions.
- **`PageApproval.complianceFindings`** map — per-compliance-finding apply/skip decisions keyed by `${ruleId}::${location}`. Parity with the existing `gaps` map for audit findings.

### Added — Pull request output

- **Plain-English summary** at the top of every PR body, ranked by severity × confidence across audit + compliance. The non-technical-friendly version of the manifest table that follows.

### Added — LLM I/O & schemas

- **`callJsonSchema<S extends ZodTypeAny>(schema, opts): Promise<z.infer<S>>`** on `IGeminiClient`. Validates response shape, retries once with Zod issues fed back into the prompt before failing. Catches cross-LLM drift at the wire.
- **Zod schemas** in `src/schemas/agent-outputs.ts` for Audit, Compliance, UX, Design, Verify, Mapper, and Brand-Bootstrap outputs. Source of truth for the JSON shapes every agent emits.
- **All JSON-emitting agents migrated** to `callJsonSchema` — Agent 1, 2, 3, 5, 6, plus the Stage 0 mapper and its brand sub-call. Agent 4 (Code) stays on `call()` since it emits raw diff text.

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
