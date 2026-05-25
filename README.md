# Reframe

> Reframe — **Portable SaaS screen-by-screen architectural refactoring engine.**
> 1 mapper + a 6-agent per-page fan-out. Point it at any GitHub URL or local project: it maps the codebase, boots it, audits, designs, and refactors every page in parallel, and opens a clean Pull Request with verified, human-tested fixes.

---

## What it does

Given a target codebase, Reframe executes a clean, sandboxed engineering pipeline:

1. **Maps** the whole app — pages, routes, DB tables, data calls, components, and library inventories — and diffs the code against the database schema to surface **broken contracts** (orphaned tables/columns, dead paths, type drift).
2. **Boots** the app in a provisioned, integration-stubbed environment. A "won't start" result is a first-class outcome, not a crash.
3. **Fans out per page** through a multi-agent parallel pool (audit → UX → design + compliance → code → verify).
4. **Applies** changes on a per-run branch and opens a Pull Request (`pr` mode), or emits proposed diffs only (`propose` mode).
5. **Scaffolds** real test users — one per role — with manual, plain-English test scripts.
6. Writes a **run manifest** detailing page pass/fail, wall-clock time, and alerts.

---

## Interactive Review & Human Commenting (The Clincher)

Reframe is built to keep the developer, designer, and client in absolute control:

*   **Review Mode (`--apply-mode review`)**: Reframe scans your app, executes only the audit/UX/compliance steps, and compiles a clean, human-readable review dashboard. No code changes are written yet.
*   **Threaded Commenting**: Non-technical team members (clients, PMs, designers) can review screen cards, type direct feedback comments (e.g. *"Change the submit button color to matching royal-blue"*), and toggle **[Approve]** or **[Skip]** on specific fixes.
*   **Resume and Apply**: When you resume the run, Reframe reads your decisions and comments from `approvals.json`, rewrites only the approved code blocks, performs verification double-checks, and opens a GitHub Pull Request with the **entire human conversation embedded directly inside the Pull Request description** for your developers!

---

## The Model — 1 Mapper + 6 Agents

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

```
audit ─→ ux ─→ design ┐
                       ├─→ code ─→ verify
compliance ────────────┘
```

---

## Install

Requires **Node 20+**. Clone the repo and install dependencies:

```bash
git clone https://github.com/resultkitchen/reframe.git
cd reframe
npm install            # also installs the Playwright Chromium browser
```

Configure your environmental keys in `.env.local` based on what LLMs you wish to use (e.g. `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).

Build the compiled engine:

```bash
npm run build
```

---

## Usage

### 1. Initialize a Project (`reframe init`)
Run this inside any target project directory to instantly bootstrap your `/config` templates:
```bash
npm run reframe init ./my-new-saas
```
Customize `config/brand.template.json` (styling rules), `config/auth.template.json` (test user logins), and `config/constraints.template.json` (compliance rules) to align the AI with your exact product.

### 2. Run a Review Pass
Scan the repository and build the review dashboard:
```bash
npm run reframe rebuild ./my-new-saas --apply-mode review --auth config/auth.json
```

### 3. Resume and Code Approved Fixes
After reviewing findings and configuring your approvals in `approvals.json`, execute the code rewrite and verification steps:
```bash
npm run reframe rebuild ./my-new-saas --resume runs/my-new-saas-<stamp> --apply-mode pr
```

---

## Swappable LLM Providers

Reframe features a **swappable AI provider framework**. You do **not** need a Gemini key if you use other models. Set your models inside `config/models.json`:

*   **Gemini (Default)**: Highly recommended for general runs. Runs at `concurrency: 8+`, completing a 30-screen app in **10–15 minutes** (ultra-affordable).
*   **Claude (Anthropic)**: Excellent for premium visual design and complex coding tasks. Requires `concurrency: 2` to avoid rate limits (runs in **40–60 minutes**).
*   **OpenAI**: Highly interchangeable.
*   **OpenAI-Compatible (Custom / Local)**: Connect to local models (Ollama, LM Studio) by configuring your custom local base URL (e.g. `http://localhost:11434/v1`).

---

## Project layout

```
config/   models.json, brand.template.json, constraints.template.json
src/
  types.ts         shared contracts — every module codes against this
  config.ts        env + flags + files -> PipelineConfig
  git.ts           clone, branch, commit, diff, PR
  scratch.ts       scratch dir lifecycle + disk guard
  state.ts         durable RunState (resume ledger)
  manifest.ts      RunManifest read/write + markdown render
  browser.ts       Playwright page driver
  llm/             LLM providers: gemini.ts, types.ts, factory.ts
  stages/          stage0-map, stage0_5-boot, init-scaffold, final-scaffold
  agents/          agent1..6
  orchestrator.ts  DAG, concurrency pool, resumability
  cli.ts           `reframe rebuild <target>`
runs/              run output dirs (gitignored)
```

---

*Ship a rebuilt app, not a guess. Customize your brand, review with comments, and refactor with confidence.*d
```

---

*Ship a rebuilt app, not a guess. Pin the brand, pin the constraints, and
every re-run is reproducible.*
