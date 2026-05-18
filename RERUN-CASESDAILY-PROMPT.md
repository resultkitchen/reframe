# Re-run prompt — paste into a fresh Claude Code context

Run this from `C:\projects\rebuild-pipeline` (or anywhere — paths are absolute).

---

Re-run the **rebuild-pipeline** against CasesDaily, this time with **auth-aware
auditing** so logged-in pages are actually audited.

## Context
`rebuild-pipeline` (`C:\projects\rebuild-pipeline`,
github.com/resultkitchen/rebuild-pipeline) is a built, working portable SaaS
rebuild pipeline — a Stage-0 mapper + a 6-agent per-page Gemini fan-out
(audit, ux, design, code, verify, compliance). **Read `BUILD-STATE.md` and
`docs/MODULE-API.md` first** — they are the spec and the module contract.
It is verified end-to-end. A prior CasesDaily run worked but audited every page
as an ANONYMOUS visitor, so auth-gated pages (`/dashboard/*`, `/admin/*`,
`/media-buyer/*`) redirected to the landing page and were never really audited.

## Task — add auth-aware auditing, then re-run on CasesDaily

### 1. Build auth-aware auditing
- Add a `--auth <path>` CLI flag. `config/casesdaily-auth.json` already exists
  (gitignored). Shape: `{ loginUrl, emailSelector, passwordSelector,
  submitSelector, postLoginWaitMs, roles: [{ role, email, password,
  routePatterns }] }`.
- Add an `AuthConfig` type to `src/types.ts`; have `resolveConfig` load it;
  thread it through `PipelineConfig` and `AgentContext`.
- `PageDriver` (`src/browser.ts`): add `loginAs(baseUrl, authConfig, role)` —
  navigate to `baseUrl + loginUrl`, fill the email + password selectors, click
  submit, wait `postLoginWaitMs`.
- Agents 1 (audit) and 5 (verify): before driving a page, if the page route
  matches a role's `routePatterns`, call `loginAs` for that role FIRST in the
  same browser context (the session cookie then carries to the target page).
  Public pages: no login, as today.
- **CRITICAL — the booted app must reach REAL Supabase for login to work.** The
  boot gate currently stubs `NEXT_PUBLIC_SUPABASE_URL` etc. to fake localhost
  values, which breaks client-side `signInWithPassword`. Fix: when `--auth` is
  set, do NOT stub the Supabase env — let the booted scratch copy use
  CasesDaily's real `.env.local` (it is copied into the scratch workdir; the
  boot gate currently overwrites it — make it preserve/merge instead, or add a
  `--no-stub-auth` behaviour). Still stub Resend / GHL / Stripe so no real
  emails or webhooks fire. The audit only navigates + observes; with dedicated
  test accounts this is acceptable.

### 2. Re-run
`npm run build`, then:
```
node dist/cli.js rebuild C:\projects\should-i-fight-all-tasks\casesdaily \
  --apply-mode propose \
  --brand config/casesdaily-brand.json \
  --auth config/casesdaily-auth.json
```
Already committed and in place: the agent4-code 120s→300s timeout fix, the
boot-gate PORT fix, and the pinned brand `config/casesdaily-brand.json`.

### 3. Test accounts (already seeded in Supabase kxnvnxzuakjfgakitzwa)
| Role | Email | Password | Lands on |
|---|---|---|---|
| admin | pipeline-admin@casesdaily-test.com | CasesDailyTest!2026 | /admin |
| attorney | pipeline-attorney@casesdaily-test.com | CasesDailyTest!2026 | /dashboard |
| media_buyer | pipeline-buyer@casesdaily-test.com | CasesDailyTest!2026 | /media-buyer |

All log in at `/auth/login` (email + password inputs, `button[type=submit]`);
middleware routes by role after sign-in.

### 4. Verify before claiming done
- Boot succeeds; the run completes; the scratch clone is deleted.
- Confirm gated pages were audited **logged in** — open
  `runs/casesdaily-*/pages/dashboard/audit.md` (and `admin`, `media-buyer`):
  they must show real dashboard content (lead/invoice tables, settings), NOT
  the marketing landing page.
- Show the manifest summary — per-page pass/fail, wall-clock, alerts.
- Commit the pipeline changes on `master` and push.

Work autonomously end-to-end. Disk discipline: clones go to a scratch dir,
deleted on exit/failure. Concurrency cap 8.
