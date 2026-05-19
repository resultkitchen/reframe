# Retrospective — rebuild-pipeline, after the first real-world run

> Written 2026-05-19 after running the auth-aware review pass against
> CasesDaily (a ~230-route production Next.js monorepo). The pipeline had only
> ever been verified on a 4-page fixture. This is the candid "what we learned"
> for hardening it toward a public GitHub release.

## 1. What the run proved

The pipeline works end-to-end on a real, large, auth-gated SaaS app:

- Booted the real app with its real `.env.local` (`--real-env`).
- Logged in as 3 roles and audited 51 gated screens **authenticated**.
- Ran 4 review agents on every screen and emitted one consolidated
  `proposed-changes.md` (the optimization plan) behind an approval gate.
- 231/231 pages completed, 0 aborts — after the fixes below.

The core idea is sound: import any repo → boot it → audit every screen with a
multi-agent fan-out → emit an approve-then-apply plan.

## 2. What QA exposed — and the systemic lesson behind each

It took **3 runs and 5 bug fixes** to get a clean pass. Every bug is an
instance of a broader weakness:

| Bug found by running it | Systemic lesson |
| --- | --- |
| `loginAs` used `page.fill()` — never enabled the disabled submit button | Browser automation against *real* apps is the fragile core. It needs real keystrokes, real waits, and fallbacks — and 3 iterations to get right. |
| `loginAs` blind 5s wait raced the redirect under load | Never use fixed waits; wait on observable state (URL/selector). |
| `saveState` aborted pages on a transient Windows file lock | The pipeline was built/tested at 4-page scale. At 231 pages × concurrency 8 a whole class of concurrency + Windows file-locking bugs appeared that small runs never hit. |
| Stable scratch path → one locked leftover blocked **every** future run | Any per-run resource that an OS can lock must be unique-per-run + best-effort cleanup. |
| Bash tool cwd persisted and broke a later command | Operational: reset cwd / use absolute paths. |
| Mapper mapped 231 "pages" incl. every `/api/*` route | Mechanical work (route enumeration) was handed to an LLM. Use deterministic code for discovery; reserve the LLM for judgment. |

Two deeper findings, not yet fixed:

- **"PASS" was hollow.** The very first run reported 10/10 PASS while *every*
  gated screen was actually the anonymous landing-page redirect. Review-mode
  "pass" only means the agents ran — not that they saw the right page.
- **Error overlays pollute the audit.** Several gated screens rendered a
  Next.js dev error overlay; the audit captured *that* instead of real
  content, inflating the "gap" count with noise.

## 3. Improvements before public release (prioritized)

**P0 — Mapper scoping.** Exclude API/route handlers, fix the root-page route,
tell the model "UI screens only", raise its timeout. → see `FIX-MAPPER-PROMPT.md`.
Biggest single lever: ~230 pages → ~35, ~2h → minutes, signal not noise.

**P1 — Honest page health.** The driver should detect and report, distinctly
from UX gaps: (a) a login/auth redirect (page is not what we asked for),
(b) a framework error overlay (Next.js/Vite/React error boundary), (c) an HTTP
4xx/5xx. A "pass" must mean "audited the intended page in a healthy state."

**P1 — Meaningful pass/fail.** Surface per page: `audited` vs
`redirected` vs `errored`. Today all three look identical in the manifest.

**P2 — Effort estimate.** `proposed-changes.md` should compute a
severity-weighted estimate ("≈ N hours / N-minute optimization plan") so the
output matches the "xx-minute plan" promise.

**P2 — Dynamic routes.** `/dashboard/leads/[id]` needs a sample param value to
be auditable; today it is driven literally and 404s. Let the operator supply
sample params (or sniff one from the DB / a list page).

**P2 — Cost & speed controls.** One app = ~900 Gemini calls / ~2h. Add a
`--max-pages`, a cheap-model "quick scan" tier, and concurrency auto-tuning.
Disclose expected call volume up front.

**P3 — Resume polish.** Two resume bugs were already fixed (results not
reloaded; stale boot cache). The review→apply handoff needs dedicated tests.

## 4. Public-release checklist

- [ ] **Publish to npm** → `npx rebuild-pipeline rebuild .` (no clone needed).
- [ ] **`pipeline init`** — scaffold `brand` / `constraints` / `auth` template
      configs into a target repo so "import into your project" is one command.
- [ ] **Provider abstraction** — it is Gemini-only today. Abstract the model
      layer (build on `config/models.json` + `gemini.ts`) so OpenAI / Claude /
      local models work. Likely the #1 adoption blocker.
- [ ] **Cross-platform CI** — the Windows file-lock bugs prove it needs
      Linux + Windows + macOS test runs against a fixture repo.
- [ ] **README** — quickstart, a real `proposed-changes.md` sample, the
      review→apply gate, the safety model.
- [ ] **Security note** — it boots arbitrary repos and handles credentials
      (`--auth`, `--real-env`). Document: use test accounts, gitignore auth
      files (`config/*-auth.json` already is), read-only exercise, what
      `--real-env` does and does not stub.
- [ ] **Cost disclosure** — tell users a run makes ~N model calls.
- [ ] LICENSE, CONTRIBUTING, a public demo fixture repo.

## 5. One-line summary

The architecture is right and now proven on a real app; the work left is
**scope discipline (mapper), honest page-health reporting, and packaging** —
not a redesign.
