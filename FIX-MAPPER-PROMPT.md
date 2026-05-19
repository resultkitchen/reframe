# Fix-mapper prompt — paste into a fresh Claude Code context

Run from `C:\projects\rebuild-pipeline` (paths are absolute, so anywhere works).

---

Fix the **Stage 0 mapper over-scoping** in the rebuild-pipeline, then re-run the
auth-aware review pass on CasesDaily so it yields a clean ~30-40-screen
optimization plan instead of a 231-route, ~2-hour one.

## Context
`rebuild-pipeline` (`C:\projects\rebuild-pipeline`,
github.com/resultkitchen/rebuild-pipeline) is a working portable SaaS rebuild
pipeline — a Stage-0 mapper + a 6-agent per-page Gemini fan-out, with a
`--apply-mode review` gate and `--auth` auth-aware auditing. **Read
`BUILD-STATE.md`, `WORKFLOW-MODES.md`, and `RETROSPECTIVE.md` first.**

A prior auth-aware review run against CasesDaily worked end-to-end (231/231
pages, 51 gated pages audited logged in, 0 login failures) — but the Stage 0
mapper **over-scoped to 231 "pages"**: it counted every `/api/*` route handler
and non-UI endpoint as a screen. Real user-facing screens are ~30-40. The
bloat pushed the run to 1h52m / ~900 Gemini calls and polluted
`proposed-changes.md` with audits of API endpoints and error overlays.

## Root causes — all in `src/stages/stage0-map.ts`
1. `appRouterRoute()` accepts BOTH `page.*` and `route.*` files. In the Next.js
   app router, `route.ts` is an API / route handler, never a UI screen — so
   every `app/api/**/route.ts` became a "page".
2. The repo-root page is mis-routed: `app/page.tsx` → `/page.tsx` instead of
   `/`, because the strip regex `/\/(page|route)\.(t|j)sx?$/` requires a
   leading slash the root page file does not have.
3. `mapperSystemInstruction()` / `mapperPrompt()` tell the model it "may
   add/refine" pages and never say a page must be a user-facing UI screen — so
   the model echoes every detected route, API ones included.
4. The mapper Gemini call uses the default 120s timeout; on a large monorepo
   the prompt is big and the call times out (it then degrades to a
   static-only scope — see the run's alert #1).

## Task
### 1. Fix the mapper (`src/stages/stage0-map.ts`)
- `appRouterRoute()`: treat ONLY `page.(t|j)sx?` as a route. Drop `route.*`
  handling entirely. Defensively also return `null` for any resulting route
  that begins with `/api/`.
- Fix the root-page route so `app/page.tsx` and `pages/index.*` map to `/`
  (anchor the strip regex with `(^|\/)`).
- Strengthen the mapper prompt + system instruction: "`pages` are USER-FACING
  UI screens only — exclude API routes, route handlers, webhook/cron
  endpoints, middleware, and anything that renders no visible UI."
- Raise the mapper call timeout to ~300000ms (pass `timeoutMs`) so large
  repos do not time out. The per-page code agent already got this bump.
- KEEP dynamic routes (`/dashboard/leads/[id]`, `/[slug]/ai`, …) — they are
  real screens.
- After Stage 0, log the page count and warn if it exceeds ~80
  ("mapper may be over-scoping — review scope.md").

### 2. Build + re-run
`npm run build`, then:
```
node dist/cli.js rebuild C:/projects/should-i-fight-all-tasks/casesdaily \
  --apply-mode review \
  --auth config/casesdaily-auth.json \
  --brand config/casesdaily-brand.json
```
`--auth` implies `--real-env` + `--read-only`. `--brand` pins the brand so
Agent 3 is deterministic and the unpinned-brand alert disappears.

### 3. Verify before claiming done
- `runs/casesdaily-<stamp>/scope.md` lists ~30-40 pages, NO `/api/*` routes,
  and a real `/` home route (not `/page.tsx`).
- The run finishes in a fraction of the prior ~2h; 0 page aborts.
- `proposed-changes.md` covers only real screens; gated screens still show
  `Audited logged in as: <role>`.
- Report the manifest summary (page count, wall-clock, alerts).
- Commit the mapper fix on `master` and push; log the fix to
  `.wolf/buglog.json`.

Work autonomously end-to-end. Disk discipline: scratch is unique per run and
cleaned on exit.
