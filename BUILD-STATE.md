# reframe — Build State & Spec

> Portable SaaS rebuild pipeline: 1 mapper (Stage 0) + a 6-agent per-page fan-out.
> Imports ANY GitHub/local project, scopes it, audits + rebuilds every page in
> parallel, and emits a rebuilt/audited app with a human-test scaffold.

## Status — COMPLETE
- [x] Project scaffolded (`C:\projects\reframe`, branch `master`)
- [x] Foundation: types, config, model pins, brand/constraints templates
- [x] Core infra (gemini, git, scratch, state, manifest, browser)
- [x] Stages (0 map, 0.5 boot, final scaffold)
- [x] Agents 1-6
- [x] Orchestrator + CLI + ForgeSmith wrapper
- [x] End-to-end run verified (fixture: InvoicePilot SaaS) — see runs/
- [x] Commit on master (no push)

### Verified end-to-end (run 5, local-path; run 6, GitHub clone)
- Stage 0 mapped 4 pages + broken contracts; Stage 0.5 booted the app;
  6-agent fan-out ran on every page; test scaffold seeded 2 users;
  manifest written; scratch clone deleted (`scratchCleaned: true`).
- Wall-clock ~8 min for a 4-page app (24 Gemini calls + 8 Playwright sessions).
- Bugs found+fixed during verification: boot-port detection (ANSI codes,
  then IPv6 `::1`), git-repo bootstrap for non-VCS targets, dev-server
  teardown before scratch cleanup.
- `pass=false` per page is honest verification output (Agent 5 reports gaps
  not fully closed in one pass), not a pipeline failure.

### Test fixture
`github.com/resultkitchen/invoicepilot-fixture` — small Vite+React SaaS,
boots with zero external services. Used as the end-to-end proof + regression
fixture. (Source also at `C:\fixtures\saas-fixture`.)

## Decisions (locked)
- **Stack**: Node 24 + TypeScript, CommonJS output, deps kept minimal.
- **Provider**: Gemini only for the per-page fan-out. Mapper may use the
  strongest model. Models pinned in `config/models.json` (swappable).
- **Models (Flagship 3.5 & 3.1 GA Tiers, updated May 2026)**:
  - mapper / code / compliance → `gemini-3.1-pro-preview`
  - audit / ux / design / verify → `gemini-3.5-flash`
  - mechanical sub-tasks → `gemini-3.1-flash-lite`
- **Concurrency**: operator machine has 32 GB RAM → default cap 8 page-workers,
  auto-dial-back on OOM / hang detection.
- **Apply mode**: `pr` — Agent 4 applies on a per-run branch and the run emits a
  PR; `propose` mode writes diffs only. Default `pr`.
- **Disk**: clone into `PIPELINE_SCRATCH` or `<os-tmp>/rebuild-<project>`;
  deleted on success AND failure. Never accumulate clones.
- **Timeouts**: every Gemini call is AbortController-bounded; timeouts are
  surfaced to the operator (stderr + manifest), not silently retried forever.

## The 12 adjustments folded in (vs. the original consultant prompt)
1. **Agent 6 — Compliance**: 6th agent, driven by pinned `constraints.json`.
2. **Stage 0 diffs code-vs-schema**: emits `brokenContracts` (orphaned tables/
   columns, dead code paths, type/schema drift).
3. **Apply gated**: per-run branch + PR (operator choice), `propose` fallback.
4. **Honest DAG**: fan-out is `{audit,ux,design,compliance} ∥ → code → verify`.
5. **Stage 0.5 boot gate**: provision env, install, boot; "won't start" is a
   first-class state, not a crash.
6. **Safe test-user seeding**: seed against the app's path but with external
   integrations stubbed (no real emails / webhooks).
7. **brand.json bootstrap**: Stage 0 derives a candidate brand spec from the
   repo; operator pins it; frozen thereafter.
8. **Concurrency from real limits**: cap derived from RAM + model tier.
9. **Per-run branch** (not one master commit on the target).
10. **Resumable**: per-page AND per-agent checkpoints; manifest = resume ledger.
11. **One CLI**: ForgeSmith wrapper just shells out to the CLI.
12. **Model split**: pinned in `config/models.json`.

## Layout
```
config/         models.json, brand.template.json, constraints.template.json
src/
  types.ts      shared contracts (the interface every module codes against)
  config.ts     resolve env + flags + files -> PipelineConfig
  gemini.ts     Gemini client: timeout, retry, alerting, JSON-mode helper
  git.ts        clone, per-run branch, PR, cleanup
  scratch.ts    scratch dir lifecycle + disk guard
  state.ts      durable RunState (resume ledger)
  manifest.ts   RunManifest read/write
  browser.ts    Playwright driver helpers (drive page, capture console)
  stages/
    stage0-map.ts        scope doc + code-vs-schema diff + brand bootstrap
    stage0_5-boot.ts     provision + boot gate
    final-scaffold.ts    per-role test users + numbered test scripts
  agents/
    agent1-audit.ts      drive page, gap list (functional + UX)
    agent2-ux.ts         ASCII wireframe + functional spec (existing libs only)
    agent3-design.ts     visual design from pinned brand.json
    agent4-code.ts       implement page per agents 1-3 + 6
    agent5-verify.ts     re-drive, confirm gaps closed, report regressions
    agent6-compliance.ts domain/legal correctness vs constraints.json
  orchestrator.ts  DAG, concurrency pool, resumability
  cli.ts           `pipeline rebuild <github-url|path>`
  forgesmith.ts    ForgeSmith-invokable tool wrapper (shells to CLI)
runs/            run output dirs (gitignored)
```

## Run directory layout
```
runs/<project>-<ISO-stamp>/
  manifest.json              project, pages, agents, pass/fail, wall-clock
  state.json                 resume ledger (per-page/per-agent status)
  scope.json / scope.md      Stage 0 output
  boot.json                  Stage 0.5 output
  brand.resolved.json        pinned brand actually used
  constraints.resolved.json  pinned constraints actually used
  pages/<page-slug>/
    audit.json|md  ux.json|md  design.json|md  compliance.json|md
    code.diff  verify.json|md  status.json
  test-scaffold/
    users.json  <role>-test-script.md
  logs/
```

## Test repo for the end-to-end proof
Pick a small open-source SaaS repo that boots with NO external services
(SQLite or in-memory). Candidates: a small Next.js/SQLite todo-SaaS or
kanban. Final choice recorded here when the run executes.

## Resume
`pipeline rebuild <target> --resume <runDir>` re-reads `state.json` and skips
completed page/agent checkpoints.
