# rebuild-pipeline

> Portable SaaS rebuild pipeline — **1 mapper + a 6-agent per-page fan-out**,
> Gemini-driven. Point it at any GitHub URL or local project: it scopes the
> app, boots it, audits and rebuilds every page in parallel, and emits a
> rebuilt/audited working copy plus a human-test scaffold.

---

## What it does

Given a target repo, the pipeline:

1. **Maps** the whole app — pages, routes, DB tables, data calls, component &
   library inventory — and diffs the code against the schema to surface
   **broken contracts** (orphaned tables/columns, dead paths, type drift).
2. **Boots** the app in a provisioned, integration-stubbed environment. A
   "won't start" result is a first-class outcome, not a crash.
3. **Fans out per page** through six agents (audit → UX → design + compliance
   → code → verify), running many pages concurrently.
4. **Applies** the fixes on a per-run branch and opens a PR (`pr` mode), or
   emits diffs only (`propose` mode).
5. **Scaffolds** real test users — one per role — with numbered, non-technical
   test scripts.
6. Writes a **run manifest**: per-page pass/fail, wall-clock time, alerts.

Nothing is invented per-run: the **brand** and **constraints** are pinned
inputs, so re-runs are deterministic.

---

## The model — 1 mapper + 6 agents

| Stage / Agent | Role | Output |
| ------------- | ---- | ------ |
| **Stage 0 — Map** | Mapper | `ScopeDoc`: pages, DB tables, data calls, inventories, broken contracts, a bootstrapped brand candidate |
| **Stage 0.5 — Boot gate** | — | `BootResult`: installs deps, boots the dev server, stubs external integrations |
| **Agent 1 — Audit** | per page | Drives the live page, exercises it, returns a gap list (functional + UX) |
| **Agent 2 — UX** | per page | ASCII wireframe + functional spec, constrained to existing libraries |
| **Agent 3 — Design** | per page | Visual spec expressed **only** in pinned-brand tokens |
| **Agent 6 — Compliance** | per page | Domain/legal findings vs the pinned `constraints.json` |
| **Agent 4 — Code** | per page | Implements the page per agents 1/2/3/6 |
| **Agent 5 — Verify** | per page | Re-drives the page, confirms gaps closed, reports regressions |
| **Final — Test scaffold** | — | Seeds a real user per role + numbered test scripts |

### The per-page DAG

Agents do **not** all run in parallel. The honest dependency graph is:

```
audit ─→ ux ─→ design ┐
                       ├─→ code ─→ verify
compliance ────────────┘
```

`audit` and `compliance` start immediately. `ux` needs `audit`; `design`
needs `ux` + `audit`. `code` needs all of audit/ux/design/compliance.
`verify` runs last. The orchestrator runs the audit→ux→design chain in
parallel with compliance, then code, then verify — for every page, with up
to `--concurrency` pages in flight at once.

---

## Install

```bash
git clone <this repo>
cd rebuild-pipeline
npm install            # also installs the Playwright Chromium browser
```

Requires **Node 20+**. Set a Gemini API key:

```bash
export GEMINI_API_KEY=...      # or GOOGLE_API_KEY
```

Build the compiled CLI (`dist/cli.js`, exposed as the `pipeline` bin):

```bash
npm run build
```

---

## Usage

### Via npm (no build needed — runs through `tsx`)

```bash
npm run pipeline rebuild https://github.com/acme/todo-saas
```

### Via the built `pipeline` bin

```bash
npm run build
pipeline rebuild https://github.com/acme/todo-saas
pipeline --help
```

### Local-path targets

A local path is detected automatically — it is copied into scratch and never
modified or deleted in place:

```bash
pipeline rebuild ./local/project
pipeline rebuild C:\projects\my-saas
```

### Flags

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--concurrency <n>` | `8` | Max concurrent page-workers |
| `--apply-mode <pr\|propose>` | `pr` | `pr` = per-run branch + PR; `propose` = diffs only |
| `--brand <path>` | — | Pinned brand spec (see below) |
| `--constraints <path>` | `config/constraints.template.json` | Pinned constraints for Agent 6 |
| `--scratch <path>` | `$PIPELINE_SCRATCH` or OS tmp | Scratch dir for the clone |
| `--resume <runDir>` | — | Resume an existing run |

```bash
pipeline rebuild https://github.com/acme/app \
  --apply-mode propose \
  --concurrency 4 \
  --brand config/brand.json \
  --constraints config/constraints.json
```

### Programmatic / ForgeSmith

```ts
import { forgesmithRebuild } from './src/forgesmith';

const manifest = await forgesmithRebuild({
  target: 'https://github.com/acme/todo-saas',
  applyMode: 'propose',
  concurrency: 4,
  brand: 'config/brand.json',
});
```

`forgesmithRebuild` builds the same argv the CLI uses, runs the pipeline
in-process (no subprocess, no VPS-only paths), and returns the `RunManifest`.

### Exit codes

`0` when **every** processed page passed verification; `1` if any page
failed or the run errored.

---

## Run directory layout

Each run writes a self-contained directory under `runs/`:

```
runs/<project>-<ISO-stamp>/
  manifest.json               project, pages, agents, pass/fail, wall-clock
  manifest.md                 human-readable summary
  state.json                  resume ledger (per-page / per-agent status)
  scope.json / scope.md       Stage 0 output (the map)
  boot.json                   Stage 0.5 output (boot gate)
  brand.resolved.json         the brand actually used this run
  constraints.resolved.json   the constraints actually used this run
  pages/<page-slug>/
    audit.json|md   ux.json|md   design.json|md
    compliance.json|md   code.diff   verify.json|md   status.json
  test-scaffold/
    users.json                seeded test users
    <role>-test-script.md     numbered, non-technical test script per role
  logs/
```

The `runs/` directory is gitignored.

---

## Brand & constraints pinning

Agent 3 (design) and Agent 6 (compliance) read **pinned** input specs so the
pipeline is deterministic.

- **Brand** — Stage 0 *bootstraps* a candidate brand from the repo (Tailwind
  config, CSS variables, components). On the first run, no pinned brand
  exists, so the pipeline writes that candidate to
  `runs/.../brand.resolved.json`, uses it, and prints a clear notice that the
  run is **non-deterministic**. To pin it: review that file, set
  `"pinned": true`, save it as `config/brand.json`, and re-run with
  `--brand config/brand.json`. Full workflow in
  [`docs/BRAND_SPEC.md`](docs/BRAND_SPEC.md).
- **Constraints** — the domain/legal rules Agent 6 enforces (TCPA, FTC,
  HIPAA, …). Copy `config/constraints.template.json` to
  `config/constraints.json`, edit it for the target's vertical, and pass it
  with `--constraints`. Without a constraints file, Agent 6 runs with zero
  rules.

The brand/constraints actually used are always persisted into the run dir as
`brand.resolved.json` / `constraints.resolved.json`.

---

## Resuming a run

Runs are checkpointed after **every agent**. If a run is interrupted, resume
it — completed Stage 0/0.5 work and completed page/agent checkpoints are
skipped:

```bash
pipeline rebuild <target> --resume runs/<project>-<stamp>
```

The resume ledger lives in `state.json` inside the run directory.

---

## Model configuration

Gemini model IDs are pinned per role in `config/models.json` and read through
`src/config.ts` — swap them freely:

| Role | Default model |
| ---- | ------------- |
| `mapper`, `agent4_code`, `agent6_compliance` | `gemini-3.1-pro-preview` |
| `agent1_audit`, `agent2_ux`, `agent3_design`, `agent5_verify` | `gemini-3-flash-preview` |
| `mechanical` (sub-tasks) | `gemini-3.1-flash-lite-preview` |

For long-term stability, swap the `pro` pins to `gemini-2.5-pro` and the
`flash` pins to `gemini-2.5-flash`.

Every Gemini call is AbortController-bounded (`callTimeoutMs`, default
120 s) and retried up to `maxRetries` (default 2). Timeouts surface to
stderr **and** the manifest `alerts` array — they are never silently
swallowed.

---

## Project layout

```
config/   models.json, brand.template.json, constraints.template.json
src/
  types.ts         shared contracts — every module codes against this
  config.ts        env + flags + files -> PipelineConfig
  gemini.ts        Gemini client: timeout, retry, alerting, JSON helper
  git.ts           clone, per-run branch, commit, diff, PR
  scratch.ts       scratch dir lifecycle + disk guard
  state.ts         durable RunState (resume ledger)
  manifest.ts      RunManifest read/write + markdown render
  browser.ts       Playwright page driver
  stages/          stage0-map, stage0_5-boot, final-scaffold
  agents/          agent1..6
  orchestrator.ts  DAG, concurrency pool, resumability
  cli.ts           `pipeline rebuild <target>`
  forgesmith.ts    in-process ForgeSmith wrapper
runs/              run output dirs (gitignored)
docs/              MODULE-API.md, BRAND_SPEC.md
```

---

*Ship a rebuilt app, not a guess. Pin the brand, pin the constraints, and
every re-run is reproducible.*
