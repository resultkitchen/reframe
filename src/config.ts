/**
 * Configuration resolution for the rebuild pipeline.
 *
 * Parses argv (`rebuild <target> [flags]`), loads `.env.local`, model pins,
 * brand + constraints specs, and derives every path the pipeline needs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type {
  ApplyMode,
  AuthConfig,
  BrandSpec,
  ConstraintsSpec,
  ModelConfig,
  PipelineConfig,
} from './types';
import { loadAuthConfig } from './auth';

/** Repo root — config.ts lives in src/, so root is one level up. */
const REPO_ROOT = path.resolve(__dirname, '..');

/* ─────────────────────────── env loading ─────────────────────────── */

/**
 * Manually load KEY=VALUE pairs from `.env.local` at the repo root into
 * `process.env` (only for keys not already set). Skips comments + blanks.
 */
function loadEnvLocal(): void {
  const envPath = path.join(REPO_ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (key === '') continue;

    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/* ─────────────────────────── file loaders ─────────────────────────── */

/** Read and parse `config/models.json` into a ModelConfig. */
export function loadModels(): ModelConfig {
  const modelsPath = path.join(REPO_ROOT, 'config', 'models.json');
  const raw = fs.readFileSync(modelsPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const get = (key: keyof ModelConfig): string => {
    const v = parsed[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`models.json missing/invalid model id for role "${key}"`);
    }
    return v;
  };

  return {
    mapper: get('mapper'),
    agent1_audit: get('agent1_audit'),
    agent2_ux: get('agent2_ux'),
    agent3_design: get('agent3_design'),
    agent4_code: get('agent4_code'),
    agent5_verify: get('agent5_verify'),
    agent6_compliance: get('agent6_compliance'),
    mechanical: get('mechanical'),
  };
}

/** Load a pinned (or template) brand spec from `path`. */
export function loadBrand(brandPath: string): BrandSpec {
  const raw = fs.readFileSync(brandPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  return {
    name: typeof parsed.name === 'string' ? parsed.name : 'Untitled',
    colors: (parsed.colors as Record<string, string>) ?? {},
    typeScale: (parsed.typeScale as Record<string, string>) ?? {},
    spacing: (parsed.spacing as Record<string, string>) ?? {},
    radii: parsed.radii as Record<string, string> | undefined,
    voice: typeof parsed.voice === 'string' ? parsed.voice : '',
    componentStyle:
      typeof parsed.componentStyle === 'string' ? parsed.componentStyle : '',
    pinned: parsed.pinned === true,
  };
}

/** Load a pinned (or template) constraints spec from `path`. */
export function loadConstraints(constraintsPath: string): ConstraintsSpec {
  const raw = fs.readFileSync(constraintsPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const knownCovered = Array.isArray(parsed.knownCovered)
    ? parsed.knownCovered.map(String)
    : undefined;

  return {
    project: typeof parsed.project === 'string' ? parsed.project : 'Untitled',
    rules: rules.map((r) => {
      const rule = r as Record<string, unknown>;
      return {
        id: String(rule.id ?? ''),
        domain: String(rule.domain ?? ''),
        description: String(rule.description ?? ''),
        appliesTo: String(rule.appliesTo ?? '*'),
        severity: (rule.severity as ConstraintsSpec['rules'][number]['severity']) ?? 'medium',
      };
    }),
    knownCovered,
  };
}

/** Load dynamic route sample parameters from `path`. */
export function loadSampleParams(paramsPath?: string): Record<string, string> {
  if (!paramsPath) return {};
  const raw = fs.readFileSync(path.resolve(paramsPath), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = String(v);
  }
  return out;
}

/* ─────────────────────────── argv parsing ─────────────────────────── */

interface ParsedArgs {
  target: string;
  concurrency?: number;
  applyMode?: ApplyMode;
  brand?: string;
  constraints?: string;
  scratch?: string;
  resume?: string;
  realEnv?: boolean;
  readOnly?: boolean;
  auth?: string;
  maxPages?: number;
  routes?: string[];
  quickScan?: boolean;
  params?: string;
  llmProvider?: string;
  onlyRoles?: string[];
  mocks?: string;
  diffOnly?: boolean;
  diffBase?: string;
  bootstrapOnly?: boolean;
  postFindings?: boolean;
  verifyOnly?: boolean;
  brief?: string;
  evidence?: string;
  seedCmd?: string;
  scenario?: string;
}

/**
 * Parse argv of the form `rebuild <target> [flags]`. `argv` is expected to be
 * the args AFTER node + script (i.e. `process.argv.slice(2)`), but a leading
 * `node`/script path or `rebuild` subcommand is tolerated and skipped.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const tokens = [...argv];

  // Drop a leading `rebuild` subcommand if present.
  if (tokens[0] === 'rebuild') tokens.shift();

  let target: string | undefined;
  const out: Partial<ParsedArgs> = {};

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = (): string => {
      const v = tokens[i + 1];
      if (v === undefined) throw new Error(`Flag "${tok}" requires a value`);
      i++;
      return v;
    };

    if (tok === '--concurrency') {
      const n = Number.parseInt(next(), 10);
      if (Number.isNaN(n) || n < 1) throw new Error('--concurrency must be a positive integer');
      out.concurrency = n;
    } else if (tok === '--apply-mode') {
      const v = next();
      if (v !== 'pr' && v !== 'propose' && v !== 'review') {
        throw new Error(
          `--apply-mode must be 'pr', 'propose', or 'review' (got "${v}")`,
        );
      }
      out.applyMode = v;
    } else if (tok === '--real-env') {
      out.realEnv = true;
    } else if (tok === '--read-only') {
      out.readOnly = true;
    } else if (tok === '--auth') {
      out.auth = next();
    } else if (tok === '--brand') {
      out.brand = next();
    } else if (tok === '--constraints') {
      out.constraints = next();
    } else if (tok === '--scratch') {
      out.scratch = next();
    } else if (tok === '--resume') {
      out.resume = next();
    } else if (tok === '--max-pages') {
      const n = Number.parseInt(next(), 10);
      if (Number.isNaN(n) || n < 1) throw new Error('--max-pages must be a positive integer');
      out.maxPages = n;
    } else if (tok === '--routes') {
      out.routes = next().split(',').map((r) => r.trim()).filter((r) => r.length > 0);
    } else if (tok === '--quick-scan') {
      out.quickScan = true;
    } else if (tok === '--params') {
      out.params = next();
    } else if (tok === '--only-roles') {
      out.onlyRoles = next().split(',').map((r) => r.trim()).filter((r) => r.length > 0);
    } else if (tok === '--mocks') {
      out.mocks = next();
    } else if (tok === '--llm-provider') {
      const v = next();
      if (v !== 'gemini' && v !== 'openai' && v !== 'anthropic' && v !== 'openai-compatible') {
        throw new Error(
          `--llm-provider must be 'gemini', 'openai', 'anthropic', or 'openai-compatible' (got "${v}")`,
        );
      }
      out.llmProvider = v;
    } else if (tok === '--diff-only') {
      out.diffOnly = true;
    } else if (tok === '--diff-base') {
      const v = next();
      if (!v || !v.trim()) throw new Error('--diff-base must be a non-empty git ref');
      out.diffBase = v.trim();
    } else if (tok === '--bootstrap-only') {
      out.bootstrapOnly = true;
    } else if (tok === '--post-findings') {
      out.postFindings = true;
    } else if (tok === '--verify-only') {
      out.verifyOnly = true;
    } else if (tok === '--brief') {
      out.brief = next();
    } else if (tok === '--evidence') {
      out.evidence = next();
    } else if (tok === '--seed-cmd') {
      out.seedCmd = next();
    } else if (tok === '--scenario') {
      out.scenario = next();
    } else if (tok.startsWith('--')) {
      throw new Error(`Unknown flag "${tok}"`);
    } else if (target === undefined) {
      target = tok;
    }
    // Extra positional args are ignored.
  }

  if (target === undefined || target.trim() === '') {
    throw new Error('Usage: rebuild <github-url|local-path> [flags]');
  }

  return { target, ...out };
}

/* ─────────────────────────── derivations ─────────────────────────── */

/** True when `target` resolves to an existing path on disk. */
function detectLocalPath(target: string): boolean {
  // GitHub URLs (https / ssh / scp form) are never local.
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(target)) return false;
  try {
    return fs.existsSync(path.resolve(target));
  } catch {
    return false;
  }
}

/** Lowercased, filesystem-safe slug from the last path/repo segment. */
function deriveSlug(target: string, isLocalPath: boolean): string {
  let segment: string;

  if (isLocalPath) {
    segment = path.basename(path.resolve(target));
  } else {
    // Strip query/fragment, trailing slash, `.git`, then take last segment.
    const clean = target.split(/[?#]/)[0].replace(/\/+$/, '');
    const lastSlash = clean.lastIndexOf('/');
    segment = lastSlash === -1 ? clean : clean.slice(lastSlash + 1);
    segment = segment.replace(/\.git$/i, '');
  }

  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'project';
}

/* ─────────────────────────── resolveConfig ─────────────────────────── */

/**
 * Resolve a fully-populated PipelineConfig from argv + env + config files.
 */
export async function resolveConfig(argv: string[]): Promise<PipelineConfig> {
  loadEnvLocal();

  const args = parseArgs(argv);

  const isLocalPath = detectLocalPath(args.target);
  const projectSlug = deriveSlug(args.target, isLocalPath);

  // ISO stamp (: replaced by -) — used for both the run dir and the default
  // scratch dir so each is unique per run.
  const stamp = new Date().toISOString().replace(/:/g, '-');

  const scratchDir =
    args.scratch ??
    process.env.PIPELINE_SCRATCH ??
    // Unique per run: a STABLE scratch path means a single locked leftover
    // (e.g. a dev-server file handle Windows has not released) would block
    // every future run. A run-scoped path sidesteps that entirely.
    path.join(os.tmpdir(), `rebuild-${projectSlug}-${stamp}`);

  // For a local-path target, the pipeline works on a COPY inside scratchDir so
  // the original is never mutated. For a clone, the clone IS the working copy.
  const workDir = isLocalPath
    ? path.join(scratchDir, projectSlug)
    : path.join(scratchDir, projectSlug);

  // Run dir: runs/<slug>-<ISO stamp>.
  const runDir = args.resume
    ? path.resolve(args.resume)
    : path.join(process.cwd(), 'runs', `${projectSlug}-${stamp}`);

  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';

  const brandPath = args.brand
    ? path.resolve(args.brand)
    : path.join(REPO_ROOT, 'config', 'brand.template.json');

  const constraintsPath = args.constraints
    ? path.resolve(args.constraints)
    : path.join(REPO_ROOT, 'config', 'constraints.template.json');

  // --auth: load the auth config now so a malformed file fails fast. Setting
  // it implies --real-env (the app must reach its real auth backend to log in)
  // and therefore --read-only.
  let auth: AuthConfig | undefined;
  if (args.auth) {
    auth = loadAuthConfig(path.resolve(args.auth));
  }
  const realEnv = (args.realEnv ?? false) || auth !== undefined;

  const models = loadModels();
  if (args.quickScan) {
    models.agent1_audit = models.mechanical;
    models.agent2_ux = models.mechanical;
    models.agent3_design = models.mechanical;
    models.agent5_verify = models.mechanical;
  }

  const config: PipelineConfig = {
    target: args.target,
    isLocalPath,
    projectSlug,
    scratchDir,
    workDir,
    runDir,
    concurrency: args.concurrency ?? 8,
    applyMode: args.applyMode ?? 'pr',
    realEnv,
    // --real-env / --auth always drive read-only so a live backend takes no
    // mutations (loginAs is exempt — it is a separate, deliberate action).
    readOnlyExercise: (args.readOnly ?? false) || realEnv,
    ...(auth ? { auth } : {}),
    models,
    brandPath,
    constraintsPath,
    geminiApiKey,
    callTimeoutMs: 120000,
    maxRetries: 2,
    ...(args.resume ? { resumeRunDir: path.resolve(args.resume) } : {}),
    maxPages: args.maxPages,
    routePatterns: args.routes,
    quickScan: args.quickScan ?? false,
    sampleParams: loadSampleParams(args.params),
    onlyRoles: args.onlyRoles,
    mocksPath: args.mocks ? path.resolve(args.mocks) : undefined,
    llmProvider: args.llmProvider ?? 'gemini',
    diffOnly: args.diffOnly ?? false,
    diffBase: args.diffBase,
    bootstrapOnly: args.bootstrapOnly ?? false,
    postFindings: args.postFindings ?? false,
    verifyOnly: args.verifyOnly ?? false,
    brief: args.brief,
    evidence: args.evidence,
    seedCmd: args.seedCmd,
    scenario: args.scenario,
  };

  return config;
}
