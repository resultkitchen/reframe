/**
 * Shared contracts for the rebuild pipeline.
 *
 * Every module and every agent codes against THIS file. Keep it the single
 * source of truth for cross-module shapes; do not redefine these elsewhere.
 */

/* ─────────────────────────── Config ─────────────────────────── */

export type ApplyMode = 'pr' | 'propose' | 'review';

/** Gemini model IDs, one per pipeline role. Loaded from config/models.json. */
export interface ModelConfig {
  mapper: string;
  agent1_audit: string;
  agent2_ux: string;
  agent3_design: string;
  agent4_code: string;
  agent5_verify: string;
  agent6_compliance: string;
  mechanical: string;
}

/* ─────────────────────────── Auth ─────────────────────────── */

/** One test account + the routes it should be logged in to audit. */
export interface AuthRole {
  /** Human label, e.g. "admin", "attorney". */
  role: string;
  email: string;
  password: string;
  /**
   * Route patterns ('/admin', '/admin/*') — a page whose route matches any
   * of these is driven logged in as this role. First matching role wins.
   */
  routePatterns: string[];
}

/**
 * Auth config for auth-aware auditing — INPUT, loaded from `--auth <path>`.
 * Lets Agents 1 & 5 log in before driving gated routes so they audit real
 * authenticated content instead of a redirect to the public landing page.
 */
export interface AuthConfig {
  /** Login page path, appended to the booted app's baseUrl. */
  loginUrl: string;
  /** Playwright selector for the email/username input. */
  emailSelector: string;
  /** Playwright selector for the password input. */
  passwordSelector: string;
  /** Playwright selector for the submit button. */
  submitSelector: string;
  /** Wait after submitting, to let the post-login redirect settle. */
  postLoginWaitMs: number;
  roles: AuthRole[];
}

/** Fully-resolved configuration for one pipeline run. */
export interface PipelineConfig {
  /** GitHub URL or local filesystem path of the target project. */
  target: string;
  /** True when `target` is a local path (skip clone). */
  isLocalPath: boolean;
  /** Short slug derived from the target, used in dir names. */
  projectSlug: string;
  /** Scratch dir for clones — deleted on run end (success or failure). */
  scratchDir: string;
  /** Working copy of the target the pipeline operates on. */
  workDir: string;
  /** Structured run output directory (runs/<slug>-<stamp>/). */
  runDir: string;
  /** Capped number of concurrent page-workers. */
  concurrency: number;
  /**
   * 'pr' = apply on a per-run branch + emit PR; 'propose' = diffs only;
   * 'review' = run the four review agents on every page, skip code/verify,
   * and emit a consolidated proposed-changes.md for approval.
   */
  applyMode: ApplyMode;
  /**
   * When true, the boot gate preserves the target's real `.env.local` instead
   * of writing safe stub values. Use to point at a fully-configured install.
   */
  realEnv: boolean;
  /**
   * When true, `PageDriver.exercise()` skips destructive clicks (delete, send,
   * pay, submit, …) so driving a live backend fires no real mutations.
   * Implied by `realEnv`.
   */
  readOnlyExercise: boolean;
  /**
   * Auth-aware auditing config. When set, Agents 1 & 5 log in before driving
   * routes that match a role's patterns. Loaded from `--auth <path>`; setting
   * it implies `realEnv` (the app must reach its real auth backend).
   */
  auth?: AuthConfig;
  /** Resolved Gemini model IDs. */
  models: ModelConfig;
  /** Path to the pinned brand spec (may be bootstrapped by Stage 0). */
  brandPath: string;
  /** Path to the pinned constraints spec. */
  constraintsPath: string;
  /** Gemini API key. */
  geminiApiKey: string;
  /** Per Gemini call timeout (ms). */
  callTimeoutMs: number;
  /** Max retries per Gemini call before surfacing failure. */
  maxRetries: number;
  /** When set, resume this existing run directory. */
  resumeRunDir?: string;
  /**
   * Cost/speed control: cap the number of pages processed in the fan-out.
   * Stage 0 still maps every screen; only the first `maxPages` are audited.
   * Undefined = no cap.
   */
  maxPages?: number;
  /**
   * Quick-scan tier: route the per-page review agents (audit/ux/design/verify)
   * to the cheap `mechanical` model for a faster, cheaper, lower-fidelity pass.
   * Resolved in config.ts by overriding the model ids. Default false.
   */
  quickScan: boolean;
  /**
   * Sample values for dynamic route segments, keyed by param name
   * (e.g. `{ id: "1", slug: "demo" }`). A route like `/leads/[id]` is driven
   * as `/leads/1`. Params with no entry fall back to DEFAULT_SAMPLE_PARAM.
   * Always present (defaults to `{}`).
   */
  sampleParams: Record<string, string>;
  /** Filter run to only pages matching specific role names (e.g. ['admin', 'media_buyer']). */
  onlyRoles?: string[];
  /**
   * Filter run to specific routes or page slugs. Supports exact routes
   * (`/reports`), route prefixes (`/reports/*`), and slugs
   * (`reports-builder`).
   */
  routePatterns?: string[];
  /** Path to static JSON mock routing mappings. */
  mocksPath?: string;
  /** Selected LLM provider, e.g. 'gemini', 'openai', 'anthropic', 'openai-compatible'. Default 'gemini' */
  llmProvider: string;
  /**
   * Scope verification to files changed in the working tree relative to
   * `diffBase`. Stage 0 still maps the whole app; the per-page fan-out
   * filters to pages whose source file appears in the diff. The flag that
   * makes a per-PR review tractable for a power user (Priya persona).
   */
  diffOnly: boolean;
  /**
   * Git ref to diff against when `diffOnly` is true. When undefined, the
   * engine probes `origin/main`, `origin/master`, `main`, `master` in
   * order and uses the first that resolves.
   */
  diffBase?: string;
  /**
   * When true, runPipeline exits cleanly after Stage 0 + brand resolution
   * without booting the dev server or running any agents. Used by the
   * `reframe bootstrap` subcommand to produce the candidate brand spec
   * before the operator commits to a full audit run.
   */
  bootstrapOnly: boolean;
  /**
   * When true, runPipeline skips agents 1-4 (audit/ux/design/code/compliance)
   * and only runs Agent 5 (verify) against the resumed run's existing
   * audit results. Used by the `reframe verify` subcommand for tight
   * incremental dev loops — fix something by hand, re-verify in seconds
   * without re-running the full pipeline. Implies --apply-mode propose
   * (no commit, no PR — verify is read-only by nature).
   */
  verifyOnly: boolean;
  /**
   * In `pr` mode, also post a top-level PR conversation comment with the
   * top-N plain-English findings — separately from the PR body, which
   * carries the full manifest. The comment is what GitHub sends as a
   * notification to subscribed reviewers; the body is the static
   * reference. Default off so a run never surprises a repo with
   * unsolicited automated comments.
   */
  postFindings: boolean;
  /** Optional workflow brief detailing the developer's intent and specific constraints. */
  brief?: string;
  /** Optional directory of manual screenshots, logs, or other evidence. */
  evidence?: string;
  /** Optional custom database seeding command. */
  seedCmd?: string;
  /** Optional active workflow scenario key from scenarios.json config. */
  scenario?: string;
  /** Optional run focus goal to target the audit and filter findings. */
  focus?: string;
}

/* ─────────────────────────── Approvals & Comments Ledger ─────────────────────────── */

export type ApprovalDecision = 'apply' | 'skip';

export interface PageApproval {
  decision: ApprovalDecision;
  gaps?: Record<string, ApprovalDecision>; // gapId -> apply|skip
  /**
   * Per-compliance-finding apply/skip decisions, keyed by
   * `${ruleId}::${location}` so multiple findings of the same rule at
   * different locations can be decided independently. Added in v1 to
   * give compliance findings the same per-item triage surface audit
   * gaps already had via `gaps`. Optional — older approvals.json files
   * without this field continue to work; absent decisions default to
   * 'apply'.
   */
  complianceFindings?: Record<string, ApprovalDecision>;
  note?: string;
  comments?: string[]; // Threaded collaborator comments/notes
}

export interface ApprovalsDoc {
  runDir: string;
  approvedAt: string;
  pages: Record<string, PageApproval>; // slug -> approval details
}

/* ─────────────────────────── Brand & Constraints ─────────────────────────── */

/** Pinned brand spec — INPUT to Agent 3, never invented per-run. */
export interface BrandSpec {
  name: string;
  colors: Record<string, string>;        // token -> hex
  typeScale: Record<string, string>;     // token -> size/lineheight
  spacing: Record<string, string>;       // token -> value
  radii?: Record<string, string>;
  voice: string;                          // brand voice / tone description
  componentStyle: string;                 // e.g. "flat, generous padding, subtle shadow"
  /** True once an operator has reviewed + pinned it (vs. a raw bootstrap). */
  pinned: boolean;
}

/** One compliance/correctness rule Agent 6 enforces. */
export interface ConstraintRule {
  id: string;
  domain: string;                         // e.g. "TCPA", "HIPAA", "FTC"
  description: string;
  appliesTo: string;                      // routes/pages glob or "*"
  severity: Severity;
}

/** Pinned constraints spec — INPUT to Agent 6. */
export interface ConstraintsSpec {
  project: string;
  rules: ConstraintRule[];
  /** Optional list of known covered surfaces to prevent redundant agent cycles. */
  knownCovered?: string[];
}

/* ─────────────────────────── Stage 0 — Map ─────────────────────────── */

export interface DbTable {
  name: string;
  columns: string[];
  relationships: string[];                // free-text FK/relation notes
}

/** A DB query or API call mapped to the page that triggers it. */
export interface DataCall {
  page: string;                           // route/page slug
  kind: 'query' | 'api' | 'rpc' | 'mutation';
  target: string;                         // table / endpoint
  description: string;
}

/**
 * A code-vs-schema mismatch (adjustment #2): code referencing tables/columns
 * that don't exist, dead code paths, types that don't match the DB.
 */
export interface BrokenContract extends FindingMeta {
  kind: 'missing-table' | 'missing-column' | 'dead-path' | 'type-drift' | 'orphaned-feature';
  location: string;                       // file:line
  detail: string;
  severity: Severity;
}

/** Per-page scope block. */
export interface PageScope {
  slug: string;                           // filesystem-safe id
  route: string;                          // URL route
  filePath: string;                       // primary source file
  purpose: string;
  userFunction: string;                   // user-facing function
  dataDependencies: DataCall[];
  libraries: string[];                    // libs in play for THIS page
  role?: string;                          // derived user role privilege group
}

/** Stage 0 output. */
export interface ScopeDoc {
  productGoal: string;
  pages: PageScope[];
  dbTables: DbTable[];
  dataCalls: DataCall[];
  componentInventory: string[];
  libraryInventory: string[];
  brokenContracts: BrokenContract[];
  /** Candidate brand spec derived from the repo (operator pins it). */
  bootstrappedBrand: BrandSpec;
}

/* ─────────────────────────── Stage 0.5 — Boot gate ─────────────────────────── */

export type BootStatus = 'running' | 'wont-start' | 'no-server';

export interface BootResult {
  status: BootStatus;
  /** Base URL the app serves on when status === 'running'. */
  baseUrl?: string;
  /** Command used to start the dev server. */
  startCommand?: string;
  /** PID of the running server (for teardown). */
  pid?: number;
  installLog: string;
  bootLog: string;
  /** Human-readable reason when status !== 'running'. */
  reason?: string;
  /** External integrations detected + how they were stubbed. */
  stubbedIntegrations: string[];
}

/* ─────────────────────────── Page health ─────────────────────────── */

/**
 * Honest health of a page as actually driven — kept DISTINCT from UX gaps.
 * A meaningful "pass" requires the audit to have seen the INTENDED page in a
 * healthy state, not an auth redirect or a framework error overlay.
 */
export type PageHealthStatus =
  | 'ok'                  // intended page rendered; no overlay; HTTP < 400
  | 'auth-redirect'       // bounced to a login/auth page — not what was asked
  | 'error-overlay'       // a Next.js/Vite/React framework error overlay shows
  | 'http-error'          // the document responded 4xx/5xx
  | 'navigation-failed'  // the browser could not navigate to the route
  | 'boot-failed'        // the app server failed to boot
  | 'degraded-empty'     // empty page or missing backing data detected
  | 'soft-lockout'       // page displays an expired auth connection / lockout state
  | 'route-drift';       // landed on a different non-auth page than expected

export interface PageHealth {
  status: PageHealthStatus;
  /** True only when status === 'ok'. */
  healthy: boolean;
  /** URL actually landed on, after any redirects. */
  finalUrl: string;
  /** HTTP status of the main document response, when known. */
  httpStatus?: number;
  /** Human-readable explanation — always populated. */
  detail: string;
  /** True if the Playwright browser ended up on a different route than requested. */
  routeDrift?: boolean;
}

/** The honest outcome of a page in the manifest (P1 — meaningful pass/fail). */
export type PageOutcome =
  | 'audited'       // driven healthy and audited as the intended page
  | 'redirected'    // bounced to auth — audit did not see the intended page
  | 'errored'       // framework error overlay or HTTP 4xx/5xx
  | 'boot-failed'   // the app never booted
  | 'drive-failed'  // the browser could not drive the route
  | 'route-drift';  // landed on a different non-auth page than expected

/* ─────────────────────────── Agents ─────────────────────────── */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type AgentName = 'audit' | 'ux' | 'design' | 'code' | 'verify' | 'compliance';

/**
 * Fine-grained classification beyond the broad `category` axis.
 * Agents fill this when they can; review app filters/groups on it.
 */
export type FindingDimension =
  | 'functional'
  | 'ux'
  | 'visual-hierarchy'
  | 'brand-voice'
  | 'microcopy'
  | 'responsive'
  | 'accessibility'
  | 'performance'
  | 'compliance'
  | 'data-contract'
  | 'security';

export const FINDING_DIMENSIONS: readonly FindingDimension[] = [
  'functional',
  'ux',
  'visual-hierarchy',
  'brand-voice',
  'microcopy',
  'responsive',
  'accessibility',
  'performance',
  'compliance',
  'data-contract',
  'security',
] as const;

/**
 * Dual-register fields shared across every finding-shaped output (Gap,
 * ComplianceFinding, BrokenContract).
 *
 * - `plain`           : the same issue written for a non-technical reader
 *                       (founder, designer, client). No jargon, concrete impact.
 * - `whyItMatters`    : the user-facing consequence if shipped as-is.
 * - `dimension`       : finer category for grouping / filtering.
 * - `signals`         : ADR-0001 — concrete reasons to trust the finding.
 *                       Each is produced by a known mechanical check
 *                       (browser evidence, broken-contract match, persona
 *                       agreement, …). NEVER invented by the LLM.
 * - `confidenceTier`  : ADR-0001 — derived mechanically from `signals.length`
 *                       (0–1 → low, 2 → medium, 3+ → high). The new ranking
 *                       primitive; replaces the float in v0.4.
 * - `confidence`      : DEPRECATED — kept one release for back-compat with
 *                       the review-app's slider. Back-filled from
 *                       `signals` via `confidenceFromSignals()` when the
 *                       agent doesn't produce one directly. To be removed
 *                       in v0.4 once the chip-based UI ships.
 *
 * All optional so legacy outputs and older agent versions remain valid.
 */
import type { ConfidenceTier, FindingSignal } from './findings/signals';

/**
 * Agent 1's collaborative scan runs as four personas (ADR-0001 slice 3).
 * Each gap can be attributed to one or more personas; when two or more
 * agree, the decorator fires the `multi-persona-agreement` signal.
 */
export type AuditPersona = 'arthur' | 'elena' | 'marcus' | 'camille';

export const AUDIT_PERSONAS: readonly AuditPersona[] = [
  'arthur',
  'elena',
  'marcus',
  'camille',
] as const;

export interface FindingMeta {
  plain?: string;
  whyItMatters?: string;
  /** DEPRECATED (ADR-0001): use signals + confidenceTier. Removed in v0.4. */
  confidence?: number;
  dimension?: FindingDimension;
  signals?: FindingSignal[];
  confidenceTier?: ConfidenceTier;
  /**
   * Which Agent-1 personas raised this gap. ≥2 = `multi-persona-agreement`
   * signal at decoration time. Only set on audit gaps; absent on compliance
   * findings (Agent 6 isn't a multi-persona scan).
   */
  personas?: AuditPersona[];
}

/** A single functional/UX gap found by Agent 1. */
export interface Gap extends FindingMeta {
  id: string;                             // stable id, referenced by verify
  category: 'functional' | 'ux';
  severity: Severity;
  description: string;
  recommendation: string;
  /** Console errors / evidence captured while driving the page. */
  evidence?: string[];
}

/** Agent 1 — Audit. */
export interface AuditResult {
  page: string;
  consoleErrors: string[];
  interactionsExercised: string[];
  gaps: Gap[];
  /** Role the page was driven logged in as (auth-aware audit); omitted for
   * public pages or when login failed. */
  authRole?: string;
  /** Honest health of the page as driven (auth-redirect / error-overlay /
   * HTTP-error detection). Present whenever the page was driven. */
  health?: PageHealth;
  /**
   * Map of breakpoint name -> relative path of screenshot file
   * (e.g. `{ mobile: 'audit-mobile.png', tablet: 'audit-tablet.png', ... }`).
   * Captured by Agent 1 at multiple viewport sizes so the review app can
   * show responsive behavior side-by-side without a separate run.
   */
  breakpointScreenshots?: Record<string, string>;
}

/** Agent 2 — UX proposal. */
export interface UxProposal {
  page: string;
  asciiWireframe: string;
  functionalSpec: string;
  /** Libraries used — MUST already be in the project. */
  librariesUsed: string[];
}

/** Agent 3 — Design. */
export interface DesignSpec {
  page: string;
  /** Concrete visual spec, expressed in pinned-brand tokens. */
  spec: string;
  brandTokensUsed: string[];
}

/** Agent 6 — Compliance. */
export interface ComplianceFinding extends FindingMeta {
  ruleId: string;
  domain: string;
  severity: Severity;
  location: string;
  problem: string;
  requiredFix: string;
}
export interface ComplianceResult {
  page: string;
  findings: ComplianceFinding[];
  /** True when no critical/high findings remain unaddressed in the spec. */
  clean: boolean;
}

/** Agent 4 — Code. */
export interface CodeResult {
  page: string;
  filesChanged: string[];
  /** Unified diff of all changes for this page. */
  diff: string;
  applied: boolean;                       // true in 'pr' mode, false in 'propose'
  notes: string;
}

/** Agent 5 — Verify. */
export interface VerifyResult {
  page: string;
  /** Gap ids from Agent 1 confirmed closed. */
  gapsClosed: string[];
  /** Gap ids still open. */
  gapsOpen: string[];
  regressions: string[];
  pass: boolean;
  /** Honest health of the page on the verify re-drive. A page that is not
   * `ok` (auth-redirect / error overlay / HTTP error) can never pass. */
  health?: PageHealth;
}

/* ─────────────────────────── State & Manifest ─────────────────────────── */

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** Per-page, per-agent checkpoint for resumability (adjustment #10). */
export interface PageState {
  slug: string;
  agents: Record<AgentName, StepStatus>;
  pass?: boolean;
}

/** Durable run ledger — written after every checkpoint. */
export interface RunState {
  runDir: string;
  projectSlug: string;
  startedAt: string;
  stage0: StepStatus;
  stage0_5: StepStatus;
  pages: Record<string, PageState>;       // slug -> state
  testScaffold: StepStatus;
  finishedAt?: string;
}

/** Per-page summary in the manifest. */
export interface PageManifestEntry {
  slug: string;
  route: string;
  agentsRun: AgentName[];
  pass: boolean;
  /** Honest outcome — audited vs redirected vs errored vs failed (P1). */
  status: PageOutcome;
  /** Page-health detail behind `status`, when the page was driven. */
  health?: PageHealth;
  gapsFound: number;
  gapsClosed: number;
  complianceFindings: number;
}

/** A seeded human-test user. */
export interface TestUser {
  role: string;
  email: string;
  password: string;
  loginUrl: string;
  scriptPath: string;                     // path to that role's test script
}

/** Final run manifest (adjustment: pass/fail per page + wall-clock). */
export interface RunManifest {
  project: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  bootStatus: BootStatus;
  pagesProcessed: PageManifestEntry[];
  testUsers: TestUser[];
  applyMode: ApplyMode;
  prUrl?: string;
  scratchCleaned: boolean;
  /** Timeouts / alerts surfaced during the run (adjustment: timeout alerting). */
  alerts: string[];
}

/* ─────────────────────────── Gemini ─────────────────────────── */

export type ModelRole = keyof ModelConfig;

export interface GeminiCallOptions {
  role: ModelRole;
  systemInstruction?: string;
  prompt: string;
  /** Request strict JSON output. */
  json?: boolean;
  /** Inline image parts (base64 PNG screenshots) for multimodal calls. */
  images?: string[];
  /** Override the default per-call timeout. */
  timeoutMs?: number;
}

/**
 * Public surface of the Gemini client (implemented in src/gemini.ts).
 *
 * `callJsonSchema` is the modern entry point: it calls the LLM, validates
 * the response against the supplied Zod schema, and on validation failure
 * appends the issues to the prompt and retries ONCE. Use it for any new
 * agent. `callJson<T>` is the legacy unvalidated form — still supported
 * but the caller carries all the burden of trust.
 *
 * The schema parameter takes a real `ZodSchema<T>` so TypeScript can infer
 * T from the schema at the call site (a structural surrogate wouldn't).
 * zod is already a runtime dep — no new transitive cost on consumers.
 */
export interface IGeminiClient {
  call(opts: GeminiCallOptions): Promise<string>;
  callJson<T>(opts: GeminiCallOptions): Promise<T>;
  /**
   * Generic is constrained to ZodTypeAny so TypeScript infers the OUTPUT
   * type via `z.infer<S>` at the call site — without this pattern, T
   * collapses to `{}` and every field access on the response becomes a
   * compile error. (Confirmed against TS 5.4 / 5.6 / 5.7.)
   */
  callJsonSchema<S extends import('zod').ZodTypeAny>(
    schema: S,
    opts: GeminiCallOptions,
  ): Promise<import('zod').infer<S>>;
  /** Timeout/failure alerts accumulated during the run. */
  readonly alerts: string[];
}

/* ─────────────────────────── Agent context ─────────────────────────── */

/**
 * Everything an agent receives. The orchestrator builds one per page and
 * populates the upstream-result fields as the DAG progresses:
 *   {audit, ux, design, compliance} run first → code → verify.
 */
export interface AgentContext {
  config: PipelineConfig;
  page: PageScope;
  scope: ScopeDoc;
  brand: BrandSpec;
  constraints: ConstraintsSpec;
  boot: BootResult;
  gemini: IGeminiClient;
  /** Absolute path to this page's run output dir (runs/.../pages/<slug>/). */
  pageDir: string;
  /** Upstream results — present when that agent has already run. */
  audit?: AuditResult;
  ux?: UxProposal;
  design?: DesignSpec;
  compliance?: ComplianceResult;
  code?: CodeResult;
  approval?: PageApproval;
}

