# MODULE-API — exact exported surface of every module

This is the integration contract. Every module is built to match these
signatures EXACTLY so parallel construction integrates cleanly. All types
(`PipelineConfig`, `ScopeDoc`, `AgentContext`, etc.) come from `src/types.ts`.

Runtime: Node 20+, TypeScript → CommonJS. Plain relative imports, no `.js`
suffix. Use `node:fs`, `node:path`, `node:child_process` from stdlib (no execa).

## src/config.ts
```ts
export function resolveConfig(argv: string[]): Promise<PipelineConfig>;
export function loadModels(): ModelConfig;          // reads config/models.json
export function loadBrand(path: string): BrandSpec;
export function loadConstraints(path: string): ConstraintsSpec;
```
`resolveConfig` parses argv (`rebuild <target>`, flags `--concurrency`,
`--apply-mode`, `--brand`, `--constraints`, `--scratch`, `--resume <runDir>`),
reads `GEMINI_API_KEY`/`GOOGLE_API_KEY` from env, derives `projectSlug`,
`scratchDir` (env `PIPELINE_SCRATCH` or `<os.tmpdir()>/rebuild-<slug>`),
`runDir` (`runs/<slug>-<ISO stamp>`), defaults: concurrency 8, applyMode 'pr',
callTimeoutMs 120000, maxRetries 2.

## src/gemini.ts
```ts
export class GeminiClient implements IGeminiClient {
  constructor(config: PipelineConfig);
  call(opts: GeminiCallOptions): Promise<string>;
  callJson<T>(opts: GeminiCallOptions): Promise<T>;
  readonly alerts: string[];
}
```
- Resolves the model id from `config.models[opts.role]`.
- Every call is AbortController-bounded by `opts.timeoutMs ?? config.callTimeoutMs`.
- On timeout/error: retry up to `config.maxRetries`; on final failure push a
  message to `this.alerts` AND `console.error` it immediately (operator alert).
- `callJson` requests JSON output and parses; strips ``` fences defensively.
- Use `@google/genai` via dynamic `import()` (it is ESM). Multimodal: pass
  `opts.images` (base64 PNG) as inlineData parts.

## src/git.ts
```ts
export function isGitRepo(dir: string): Promise<boolean>;
export function cloneRepo(url: string, destDir: string): Promise<void>;
export function createRunBranch(workDir: string, branch: string): Promise<void>;
export function commitAll(workDir: string, message: string): Promise<void>;
export function getDiff(workDir: string, fromRef?: string): Promise<string>;
export function openPr(workDir: string, branch: string, title: string, body: string): Promise<string>;
```
`openPr` uses the `gh` CLI; if there is no GitHub remote it returns `''`.
Use `simple-git` for clone/branch/commit/diff.

## src/scratch.ts
```ts
export function prepareScratch(config: PipelineConfig): Promise<void>;
export function cleanupScratch(config: PipelineConfig): Promise<boolean>;
export function checkDisk(scratchDir: string): Promise<{ freeMb: number; ok: boolean }>;
```
`cleanupScratch` removes the scratch clone; returns true on success. Must be
safe to call on failure paths. Never deletes a local-path target (`config.isLocalPath`).

## src/state.ts
```ts
export function newRunState(config: PipelineConfig, slugs: string[]): RunState;
export function loadState(runDir: string): RunState | null;
export function saveState(runDir: string, state: RunState): void;
```
`saveState` writes `runDir/state.json` atomically. Called after every checkpoint.

## src/manifest.ts
```ts
export function writeManifest(runDir: string, manifest: RunManifest): void;
export function renderManifestMd(manifest: RunManifest): string;
```
Writes `runDir/manifest.json` and `runDir/manifest.md`.

## src/browser.ts
```ts
export class PageDriver {
  static launch(): Promise<PageDriver>;
  open(url: string): Promise<void>;
  exercise(): Promise<{ interactions: string[]; consoleErrors: string[] }>;
  screenshot(): Promise<string>;   // base64 PNG, no data: prefix
  snapshot(): Promise<string>;     // accessibility/DOM text snapshot
  close(): Promise<void>;
}
```
`exercise` clicks every visible button/link, focuses inputs, and collects
`console` errors + page errors. Must be resilient: never throw on a single
failed interaction — record it and continue.

## src/stages/stage0-map.ts
```ts
export function runStage0(config: PipelineConfig, gemini: GeminiClient): Promise<ScopeDoc>;
```
Reads the repo (README, package.json, routes, DB migrations/schema, components).
Uses the `mapper` model for the scope doc; `mechanical` model for per-file
summaries. Produces `ScopeDoc` incl. `brokenContracts` (code-vs-schema diff)
and `bootstrappedBrand`. Writes `runDir/scope.json` + `runDir/scope.md`.

## src/stages/stage0_5-boot.ts
```ts
export function runBootGate(config: PipelineConfig): Promise<BootResult>;
```
Detects package manager, installs deps, finds the dev/start script, boots it,
waits for an HTTP port, returns `baseUrl`. Detects external integrations
(Supabase, Stripe, Resend, SMTP, GHL, etc.) and stubs them (env overrides /
localhost) so seeding fires no real side effects. Writes `runDir/boot.json`.
"won't-start" is a normal returned status — never throw.

## src/stages/final-scaffold.ts
```ts
export function runTestScaffold(
  config: PipelineConfig, scope: ScopeDoc, boot: BootResult, gemini: GeminiClient,
): Promise<TestUser[]>;
```
For each distinct user role, seeds a real account through the app's own
signup/admin path (integrations stubbed via `boot.stubbedIntegrations`) and
writes a numbered, non-technical test script per role to
`runDir/test-scaffold/<role>-test-script.md`; writes `users.json`.

## src/agents/agent{1..6}-*.ts
```ts
export function runAudit(ctx: AgentContext): Promise<AuditResult>;       // agent1
export function runUx(ctx: AgentContext): Promise<UxProposal>;           // agent2
export function runDesign(ctx: AgentContext): Promise<DesignSpec>;       // agent3
export function runCode(ctx: AgentContext): Promise<CodeResult>;         // agent4
export function runVerify(ctx: AgentContext): Promise<VerifyResult>;     // agent5
export function runCompliance(ctx: AgentContext): Promise<ComplianceResult>; // agent6
```
Each agent: writes its own `ctx.pageDir/<name>.json` + `<name>.md`. Agents 1 & 5
construct their own `PageDriver` from `browser.ts`. Agent roles → model role:
audit→agent1_audit, ux→agent2_ux, design→agent3_design, code→agent4_code,
verify→agent5_verify, compliance→agent6_compliance.
- Agent 1 drives `boot.baseUrl + page.route`, exercises it, returns gap list.
- Agent 2 proposes UX — constrained to `scope.libraryInventory` (no new deps).
- Agent 3 designs using ONLY `ctx.brand` tokens.
- Agent 4 implements the page in `config.workDir` per ctx.audit/ux/design/
  compliance; in 'pr' mode writes files + returns diff (`applied:true`); in
  'propose' mode returns the diff only (`applied:false`). "Fix identified gaps
  only — do not change unrelated behavior."
- Agent 5 re-drives the page, confirms each `ctx.audit.gaps[].id` closed.
- Agent 6 checks the page against `ctx.constraints.rules` whose `appliesTo`
  matches; `clean` is false if any critical/high finding exists.

## src/orchestrator.ts
```ts
export function runPipeline(config: PipelineConfig): Promise<RunManifest>;
```
Drives: scratch+clone → Stage 0 → operator brand pin check → Stage 0.5 →
per-page fan-out with a concurrency pool of `config.concurrency`
(DAG: {audit,ux,design,compliance} parallel → code → verify) → test scaffold →
manifest. Checkpoints `RunState` after every step (resumable). Always cleans
scratch in a `finally`. Drains `gemini.alerts` into `manifest.alerts`.

## src/cli.ts
Shebang `#!/usr/bin/env node`. Parses argv via `resolveConfig`, calls
`runPipeline`, prints the manifest summary, exits 0/1. Subcommand: `rebuild`.

## src/forgesmith.ts
```ts
export function forgesmithRebuild(input: { target: string; concurrency?: number;
  applyMode?: ApplyMode; brand?: string; constraints?: string }): Promise<RunManifest>;
```
Thin wrapper: builds argv and shells out to the CLI (or calls `runPipeline`
directly). No VPS-only paths.
