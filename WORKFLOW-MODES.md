# Workflow modes — review gate, real-env, read-only exercise

Added 2026-05-18. Extends the pipeline with an approval-gated, two-pass workflow
and the ability to point at a real, fully-configured installation.

## `--apply-mode review` — the approval gate

A first pass that runs **only the four review agents** (audit, ux, design,
compliance) on **every screen**, skips code+verify, and writes one consolidated
`runs/<run>/proposed-changes.md` aggregating every screen's findings.

```
node dist/cli.js rebuild <target> --apply-mode review
# read + edit runs/<run>/proposed-changes.md, then:
node dist/cli.js rebuild <target> --resume runs/<run> --apply-mode pr
```

The apply pass resumes the same run: audit/ux/design/compliance are already
`done` (their results are reloaded from each page's `*.json`), so only Agent 4
(code) + Agent 5 (verify) run — against exactly the feedback you approved.

## `--real-env` — point at an existing installation

Boot gate preserves the target's real `.env.local` instead of writing safe
stubs. Use when the app must reach real Supabase/data so the audit sees real
content. `--real-env` implies `--read-only`.

## `--read-only` — read-only browser exercise

`PageDriver.exercise()` still focuses inputs and clicks navigation, but skips
any button/link whose label matches a destructive pattern (delete, remove,
send, pay, submit, save, sign out, …) and any `type=submit`. Prevents real
mutations/emails/charges when driving a live backend.

## Implementation notes

- `ApplyMode` gained `'review'`; `PipelineConfig` gained `realEnv` +
  `readOnlyExercise`.
- Resume now reloads each done agent's `*.json` into `AgentContext` (was a bug:
  resumed runs passed `undefined` upstream results to code/verify).
- Boot gate always re-runs on resume — scratch is deleted at run end, so a
  cached `boot.json` baseUrl points at a dead server.

## `--auth <path>` — auth-aware auditing

Audits gated routes (`/dashboard/*`, `/admin/*`, …) **logged in** instead of
as an anonymous visitor that redirects to the landing page.

```
node dist/cli.js rebuild <target> --apply-mode review --auth config/myapp-auth.json
```

- Auth config (JSON): `{ loginUrl, emailSelector, passwordSelector,
  submitSelector, postLoginWaitMs, roles: [{ role, email, password,
  routePatterns }] }`. Copy `config/auth.template.json`; `config/*-auth.json`
  is gitignored (it holds credentials — use dedicated TEST accounts).
- `--auth` implies `--real-env` (the app must reach its real auth backend) and
  therefore `--read-only`.
- Agents 1 & 5: before driving a page, `matchAuthRole` checks the route
  against each role's `routePatterns`; a match triggers `PageDriver.loginAs`
  (form-fill in the same browser context, so the session cookie carries to the
  target page). Public routes: no login, as before.
- `loginAs` is exempt from read-only mode — it is a deliberate, known-safe
  action. The audit report records `Audited logged in as: <role>`.

### Implementation

- `src/auth.ts` — `loadAuthConfig` (load + validate) and `matchAuthRole`
  (route → role, `*` globs supported).
- `PageDriver.loginAs(baseUrl, auth, role)` — navigate to the login page, fill
  email + password, submit, wait `postLoginWaitMs`; returns `{ ok, detail }`.
- `AuthConfig` type on `PipelineConfig.auth`; `AuditResult.authRole` records
  the role a page was driven as.
