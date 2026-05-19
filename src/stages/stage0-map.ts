/**
 * Stage 0 — Map.
 *
 * Walks the target repo, builds a compact textual digest (file tree + key file
 * contents, large files truncated), and asks the `mapper` model to produce a
 * full `ScopeDoc`: product goal, per-page scope, DB tables, data calls,
 * component/library inventory, and — crucially — `brokenContracts` (code that
 * references DB tables/columns that do not exist, dead code paths, designed-
 * but-never-wired features). Also bootstraps a candidate `BrandSpec` from
 * tailwind/theme/CSS files (left `pinned:false` for an operator to pin).
 *
 * Writes `runDir/scope.json` and a human-readable `runDir/scope.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GeminiClient } from '../gemini';
import type {
  BrandSpec,
  DbTable,
  PageScope,
  PipelineConfig,
  ScopeDoc,
} from '../types';

/* ───────────────────────── tuning constants ───────────────────────── */

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.vercel', '.netlify', '.cache', 'vendor', '.svelte-kit',
  '.nuxt', '.output', 'runs', '.wolf', '.idea', '.vscode',
]);

/** Per-file content truncation cap (chars) in the digest. */
const FILE_TRUNCATE = 6_000;
/** Overall digest cap (chars) — keeps the mapper prompt bounded. */
const DIGEST_CAP = 220_000;
/** Max files walked before bailing (pathological repos). */
const MAX_FILES = 6_000;

/** Mapper model call timeout (ms) — big monorepo digests are slow. */
const MAPPER_TIMEOUT_MS = 300_000;

/** Above this page count, Stage 0 has almost certainly over-scoped. */
const PAGE_COUNT_WARN_THRESHOLD = 80;

/** Extensions whose contents are interesting to inline into the digest. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.sql', '.prisma', '.json', '.md', '.css', '.scss', '.env',
]);

/* ───────────────────────── small utilities ───────────────────────── */

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJson<T>(file: string): T | null {
  const raw = safeRead(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}

/** Kebab-case + filesystem-safe slug. */
function kebab(input: string): string {
  const s = input
    .replace(/^[./\\]+/, '')
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'page';
}

/** Make a slug unique within `seen`. */
function uniqueSlug(base: string, seen: Set<string>): string {
  let slug = base;
  let n = 2;
  while (seen.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  seen.add(slug);
  return slug;
}

/* ───────────────────────── repo walking ───────────────────────── */

interface WalkedFile {
  /** Path relative to workDir, POSIX separators. */
  rel: string;
  abs: string;
  size: number;
}

function walkRepo(root: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out.push({ rel, abs, size });
      }
    }
  }
  return out;
}

/* ───────────────────────── route detection ───────────────────────── */

interface DetectedRoute {
  route: string;
  filePath: string; // relative
}

/** Translate a Next.js app-router file path into a URL route. */
function appRouterRoute(rel: string): string | null {
  const m = rel.match(/(?:^|\/)app\/(.*)$/);
  if (!m) return null;
  let inner = m[1];
  // Only `page` entrypoints are user-facing screens. `route.(t|j)s` files are
  // API handlers, not pages — they must never become an auditable route.
  if (!/(?:^|\/)page\.(t|j)sx?$/.test(inner)) return null;
  // Anchor with (^|\/) so a repo-root `app/page.tsx` collapses to `/`
  // (a bare `/page\.tsx$` would not match and leave the route as `/page.tsx`).
  inner = inner.replace(/(^|\/)page\.(t|j)sx?$/, '');
  // Strip route groups (folder) and parallel/intercept segments.
  const segments = inner
    .split('/')
    .filter((s) => s.length > 0 && !s.startsWith('(') && !s.startsWith('@'));
  const route = `/${segments.join('/')}`;
  const normalized = route === '/' ? '/' : route.replace(/\/$/, '');
  // API handlers are not browser-auditable screens.
  if (normalized === '/api' || normalized.startsWith('/api/')) return null;
  return normalized;
}

/** Translate a Next.js pages-router file path into a URL route. */
function pagesRouterRoute(rel: string): string | null {
  const m = rel.match(/(?:^|\/)pages\/(.*)\.(t|j)sx?$/);
  if (!m) return null;
  let inner = m[1];
  if (inner.startsWith('api/')) return null; // API routes, not pages
  if (/(^|\/)_(app|document|error)$/.test(inner)) return null;
  inner = inner.replace(/\/index$/, '').replace(/^index$/, '');
  return inner ? `/${inner}` : '/';
}

function detectRoutes(files: WalkedFile[]): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const seenRoutes = new Set<string>();

  for (const f of files) {
    let route: string | null = null;
    if (/(?:^|\/)app\//.test(f.rel)) route = appRouterRoute(f.rel);
    if (!route && /(?:^|\/)pages\//.test(f.rel)) {
      route = pagesRouterRoute(f.rel);
    }
    if (route && !seenRoutes.has(route)) {
      seenRoutes.add(route);
      routes.push({ route, filePath: f.rel });
    }
  }
  return routes;
}

/** Heuristic: does this repo use React Router / TanStack Router? */
function detectClientRouter(files: WalkedFile[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (!/\.(t|j)sx?$/.test(f.rel)) continue;
    if (f.size > 200_000) continue;
    const txt = safeRead(f.abs);
    if (/react-router|createBrowserRouter|@tanstack\/react-router/.test(txt)) {
      // Pull every <Route path="..."> in the file.
      const re = /path\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        hits.push(`${m[1]} (in ${f.rel})`);
      }
    }
  }
  return hits;
}

/* ───────────────────────── DB schema detection ───────────────────────── */

interface SchemaSource {
  rel: string;
  abs: string;
  kind: 'sql' | 'prisma' | 'drizzle';
}

function detectSchemaSources(files: WalkedFile[]): SchemaSource[] {
  const sources: SchemaSource[] = [];
  for (const f of files) {
    if (/(?:^|\/)supabase\/migrations\/.*\.sql$/.test(f.rel)) {
      sources.push({ rel: f.rel, abs: f.abs, kind: 'sql' });
    } else if (/(?:^|\/)prisma\/schema\.prisma$/.test(f.rel)) {
      sources.push({ rel: f.rel, abs: f.abs, kind: 'prisma' });
    } else if (/schema\.(t|j)s$/.test(f.rel) && /drizzle|\/db\//.test(f.rel)) {
      sources.push({ rel: f.rel, abs: f.abs, kind: 'drizzle' });
    } else if (f.rel.endsWith('.sql')) {
      sources.push({ rel: f.rel, abs: f.abs, kind: 'sql' });
    }
  }
  return sources;
}

/* ───────────────────────── brand bootstrap ───────────────────────── */

/** Find tailwind/theme/CSS files worth feeding to the brand bootstrapper. */
function collectThemeFiles(files: WalkedFile[]): WalkedFile[] {
  return files.filter((f) => {
    const base = f.rel.split('/').pop() ?? '';
    if (/^tailwind\.config\.(js|cjs|mjs|ts)$/.test(base)) return true;
    if (/^theme\.(t|j)sx?$/.test(base)) return true;
    if (/(globals?|index|app|theme)\.(css|scss)$/.test(base)) return true;
    if (base === 'tokens.json' || base === 'design-tokens.json') return true;
    return false;
  });
}

/** Fallback brand when the model can't / doesn't return one. */
function defaultBrand(projectSlug: string): BrandSpec {
  return {
    name: projectSlug,
    colors: { primary: '#2563eb', background: '#ffffff', foreground: '#0f172a' },
    typeScale: { base: '16px/1.5', heading: '32px/1.2' },
    spacing: { sm: '8px', md: '16px', lg: '24px' },
    radii: { md: '8px' },
    voice: 'Clear, professional, plain-spoken.',
    componentStyle: 'Flat, generous padding, subtle shadow.',
    pinned: false,
  };
}

/* ───────────────────────── digest builder ───────────────────────── */

/** A few file globs whose full content always belongs in the digest. */
function isAlwaysInteresting(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  return (
    /^readme/i.test(base) ||
    base === 'package.json' ||
    base === 'next.config.js' ||
    base === 'next.config.mjs' ||
    base === 'next.config.ts' ||
    /tailwind\.config\./.test(base) ||
    /(globals?|index)\.css$/.test(base)
  );
}

function buildDigest(
  root: string,
  files: WalkedFile[],
  schemaSources: SchemaSource[],
): string {
  const parts: string[] = [];

  // 1. File tree.
  parts.push('### FILE TREE');
  parts.push(
    files
      .map((f) => `${f.rel}  (${f.size}b)`)
      .slice(0, MAX_FILES)
      .join('\n'),
  );

  // 2. Schema files in full (truncated).
  if (schemaSources.length > 0) {
    parts.push('\n### DB SCHEMA SOURCES');
    for (const s of schemaSources) {
      parts.push(`--- ${s.rel} (${s.kind}) ---`);
      parts.push(truncate(safeRead(s.abs), FILE_TRUNCATE));
    }
  }

  // 3. Key file contents (README, configs, source).
  parts.push('\n### KEY FILE CONTENTS');
  let used = parts.join('\n').length;
  for (const f of files) {
    if (used >= DIGEST_CAP) break;
    const ext = path.extname(f.rel).toLowerCase();
    const interesting = isAlwaysInteresting(f.rel) || SOURCE_EXT.has(ext);
    if (!interesting) continue;
    // Skip files already inlined as schema.
    if (schemaSources.some((s) => s.rel === f.rel)) continue;
    if (f.size > 400_000) continue;
    const body = truncate(safeRead(f.abs), FILE_TRUNCATE);
    if (!body.trim()) continue;
    const block = `\n--- ${f.rel} ---\n${body}`;
    if (used + block.length > DIGEST_CAP) {
      parts.push(`\n--- ${f.rel} --- [omitted — digest cap reached]`);
      break;
    }
    parts.push(block);
    used += block.length;
  }

  return parts.join('\n');
}

/* ───────────────────────── mapper response shape ───────────────────────── */

/**
 * The raw JSON the mapper model is asked to return. We normalize it into a
 * `ScopeDoc` afterwards (slugs, defaults, dedup).
 */
interface MapperResponse {
  productGoal?: string;
  pages?: Array<{
    route?: string;
    filePath?: string;
    purpose?: string;
    userFunction?: string;
    libraries?: string[];
    dataDependencies?: Array<{
      kind?: string;
      target?: string;
      description?: string;
    }>;
  }>;
  dbTables?: Array<{
    name?: string;
    columns?: string[];
    relationships?: string[];
  }>;
  dataCalls?: Array<{
    page?: string;
    kind?: string;
    target?: string;
    description?: string;
  }>;
  componentInventory?: string[];
  libraryInventory?: string[];
  brokenContracts?: Array<{
    kind?: string;
    location?: string;
    detail?: string;
    severity?: string;
  }>;
  bootstrappedBrand?: Partial<BrandSpec>;
}

const VALID_DATACALL_KINDS = ['query', 'api', 'rpc', 'mutation'] as const;
const VALID_BROKEN_KINDS = [
  'missing-table', 'missing-column', 'dead-path', 'type-drift',
  'orphaned-feature',
] as const;
const VALID_SEVERITY = ['critical', 'high', 'medium', 'low'] as const;

function asDataCallKind(v: unknown): 'query' | 'api' | 'rpc' | 'mutation' {
  return (VALID_DATACALL_KINDS as readonly string[]).includes(String(v))
    ? (v as 'query' | 'api' | 'rpc' | 'mutation')
    : 'query';
}

function asBrokenKind(
  v: unknown,
): (typeof VALID_BROKEN_KINDS)[number] {
  return (VALID_BROKEN_KINDS as readonly string[]).includes(String(v))
    ? (v as (typeof VALID_BROKEN_KINDS)[number])
    : 'dead-path';
}

function asSeverity(v: unknown): (typeof VALID_SEVERITY)[number] {
  return (VALID_SEVERITY as readonly string[]).includes(String(v))
    ? (v as (typeof VALID_SEVERITY)[number])
    : 'medium';
}

/* ───────────────────────── prompt ───────────────────────── */

function mapperSystemInstruction(): string {
  return [
    'You are the Stage 0 mapper of a SaaS rebuild pipeline.',
    'You receive a compact digest of a code repository (file tree, DB schema',
    'sources, key file contents). Produce a precise, factual scope document.',
    'Rules:',
    '- "pages" are user-facing UI SCREENS ONLY — routes a person navigates to',
    '  in a browser and sees rendered UI. NEVER include API route handlers,',
    '  server endpoints, any /api/* route, route.ts/route.js files, middleware,',
    '  layouts, or non-visual files. If a route returns JSON/data rather than a',
    '  rendered screen, exclude it. A typical SaaS app has ~20-50 real screens;',
    '  if you are about to emit far more, you are almost certainly including',
    '  non-screen routes — drop them.',
    '- Only describe things actually present in the digest. Do not invent.',
    '- For brokenContracts, actively diff CODE against SCHEMA: find code that',
    '  references DB tables or columns that do NOT exist in the schema',
    '  sources, dead/unreachable code paths, types that drift from the DB,',
    '  and features that look designed but were never wired up.',
    '- Return ONLY a JSON object, no prose, no markdown fences.',
  ].join('\n');
}

function mapperPrompt(
  projectSlug: string,
  digest: string,
  detectedRoutes: DetectedRoute[],
  clientRoutes: string[],
  schemaSources: SchemaSource[],
): string {
  const routeHints = detectedRoutes
    .map((r) => `${r.route}  ->  ${r.filePath}`)
    .join('\n');
  return [
    `Project slug: ${projectSlug}`,
    '',
    'Statically-detected page routes (use as the basis for "pages", but you',
    'may add/refine if the digest shows more). These are UI screens only —',
    'API endpoints and route handlers have already been filtered out and must',
    'NOT be re-added:',
    routeHints || '(none detected statically)',
    '',
    clientRoutes.length > 0
      ? `Client-router route hints:\n${clientRoutes.join('\n')}`
      : 'No client-side router routes detected.',
    '',
    schemaSources.length > 0
      ? `DB schema sources present: ${schemaSources.map((s) => s.rel).join(', ')}`
      : 'No DB schema files detected — dbTables may be empty.',
    '',
    'Return a JSON object with EXACTLY these keys:',
    `{
  "productGoal": string,
  "pages": [{
    "route": string,
    "filePath": string,
    "purpose": string,
    "userFunction": string,
    "libraries": string[],
    "dataDependencies": [{ "kind": "query|api|rpc|mutation", "target": string, "description": string }]
  }],
  "dbTables": [{ "name": string, "columns": string[], "relationships": string[] }],
  "dataCalls": [{ "page": string (route), "kind": "query|api|rpc|mutation", "target": string, "description": string }],
  "componentInventory": string[],
  "libraryInventory": string[],
  "brokenContracts": [{ "kind": "missing-table|missing-column|dead-path|type-drift|orphaned-feature", "location": "file:line", "detail": string, "severity": "critical|high|medium|low" }],
  "bootstrappedBrand": {
    "name": string, "colors": { token: hex }, "typeScale": { token: value },
    "spacing": { token: value }, "radii": { token: value },
    "voice": string, "componentStyle": string
  }
}`,
    '',
    'For bootstrappedBrand, derive tokens from tailwind.config / CSS custom',
    'properties / theme files in the digest. If none exist, give sensible',
    'neutral defaults.',
    '',
    '=== REPOSITORY DIGEST ===',
    digest,
  ].join('\n');
}

/* ───────────────────────── normalization ───────────────────────── */

function normalizeBrand(
  raw: Partial<BrandSpec> | undefined,
  projectSlug: string,
): BrandSpec {
  const fallback = defaultBrand(projectSlug);
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallback.name,
    colors:
      raw.colors && typeof raw.colors === 'object'
        ? (raw.colors as Record<string, string>)
        : fallback.colors,
    typeScale:
      raw.typeScale && typeof raw.typeScale === 'object'
        ? (raw.typeScale as Record<string, string>)
        : fallback.typeScale,
    spacing:
      raw.spacing && typeof raw.spacing === 'object'
        ? (raw.spacing as Record<string, string>)
        : fallback.spacing,
    radii:
      raw.radii && typeof raw.radii === 'object'
        ? (raw.radii as Record<string, string>)
        : fallback.radii,
    voice:
      typeof raw.voice === 'string' && raw.voice ? raw.voice : fallback.voice,
    componentStyle:
      typeof raw.componentStyle === 'string' && raw.componentStyle
        ? raw.componentStyle
        : fallback.componentStyle,
    // ALWAYS false — this is a candidate, an operator pins it.
    pinned: false,
  };
}

function normalizeScope(
  raw: MapperResponse,
  config: PipelineConfig,
  detectedRoutes: DetectedRoute[],
  depsInventory: string[],
): ScopeDoc {
  const seenSlugs = new Set<string>();

  // Build pages — prefer model output, fall back to detected routes.
  const modelPages = Array.isArray(raw.pages) ? raw.pages : [];
  const pages: PageScope[] = [];

  const pageSource =
    modelPages.length > 0
      ? modelPages
      : detectedRoutes.map((r) => ({
          route: r.route,
          filePath: r.filePath,
          purpose: '',
          userFunction: '',
          libraries: [] as string[],
          dataDependencies: [] as Array<{
            kind?: string;
            target?: string;
            description?: string;
          }>,
        }));

  for (const p of pageSource) {
    const route = typeof p.route === 'string' && p.route ? p.route : '/';
    const slugBase = kebab(route === '/' ? 'home' : route);
    const slug = uniqueSlug(slugBase, seenSlugs);
    const deps = Array.isArray(p.dataDependencies) ? p.dataDependencies : [];
    pages.push({
      slug,
      route,
      filePath:
        typeof p.filePath === 'string' && p.filePath ? p.filePath : '(unknown)',
      purpose: typeof p.purpose === 'string' ? p.purpose : '',
      userFunction: typeof p.userFunction === 'string' ? p.userFunction : '',
      libraries: Array.isArray(p.libraries)
        ? p.libraries.filter((x): x is string => typeof x === 'string')
        : [],
      dataDependencies: deps.map((d) => ({
        page: slug,
        kind: asDataCallKind(d.kind),
        target: typeof d.target === 'string' ? d.target : '',
        description: typeof d.description === 'string' ? d.description : '',
      })),
    });
  }

  const dbTables: DbTable[] = (Array.isArray(raw.dbTables) ? raw.dbTables : [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      name: t.name as string,
      columns: Array.isArray(t.columns)
        ? t.columns.filter((c): c is string => typeof c === 'string')
        : [],
      relationships: Array.isArray(t.relationships)
        ? t.relationships.filter((r): r is string => typeof r === 'string')
        : [],
    }));

  const dataCalls = (Array.isArray(raw.dataCalls) ? raw.dataCalls : [])
    .filter((d) => d && typeof d.target === 'string')
    .map((d) => ({
      page: typeof d.page === 'string' ? d.page : '',
      kind: asDataCallKind(d.kind),
      target: d.target as string,
      description: typeof d.description === 'string' ? d.description : '',
    }));

  const brokenContracts = (
    Array.isArray(raw.brokenContracts) ? raw.brokenContracts : []
  )
    .filter((b) => b && typeof b.detail === 'string')
    .map((b) => ({
      kind: asBrokenKind(b.kind),
      location: typeof b.location === 'string' ? b.location : '(unknown)',
      detail: b.detail as string,
      severity: asSeverity(b.severity),
    }));

  const componentInventory = Array.isArray(raw.componentInventory)
    ? raw.componentInventory.filter((x): x is string => typeof x === 'string')
    : [];

  // Library inventory: union of model output + actual deps from package.json.
  const libSet = new Set<string>(depsInventory);
  if (Array.isArray(raw.libraryInventory)) {
    for (const l of raw.libraryInventory) {
      if (typeof l === 'string') libSet.add(l);
    }
  }

  return {
    productGoal:
      typeof raw.productGoal === 'string' && raw.productGoal
        ? raw.productGoal
        : 'Unknown — mapper did not infer a product goal.',
    pages,
    dbTables,
    dataCalls,
    componentInventory,
    libraryInventory: [...libSet].sort(),
    brokenContracts,
    bootstrappedBrand: normalizeBrand(raw.bootstrappedBrand, config.projectSlug),
  };
}

/* ───────────────────────── scope.md renderer ───────────────────────── */

function renderScopeMd(scope: ScopeDoc, config: PipelineConfig): string {
  const lines: string[] = [];
  lines.push(`# Scope — ${config.projectSlug}`);
  lines.push('');
  lines.push(`**Target:** ${config.target}`);
  lines.push('');
  lines.push('## Product Goal');
  lines.push(scope.productGoal);
  lines.push('');

  lines.push(`## Pages (${scope.pages.length})`);
  for (const p of scope.pages) {
    lines.push(`### \`${p.route}\` — ${p.slug}`);
    lines.push(`- **File:** \`${p.filePath}\``);
    if (p.purpose) lines.push(`- **Purpose:** ${p.purpose}`);
    if (p.userFunction) lines.push(`- **User function:** ${p.userFunction}`);
    if (p.libraries.length > 0) {
      lines.push(`- **Libraries:** ${p.libraries.join(', ')}`);
    }
    if (p.dataDependencies.length > 0) {
      lines.push('- **Data dependencies:**');
      for (const d of p.dataDependencies) {
        lines.push(`  - [${d.kind}] ${d.target} — ${d.description}`);
      }
    }
    lines.push('');
  }

  lines.push(`## DB Tables (${scope.dbTables.length})`);
  for (const t of scope.dbTables) {
    lines.push(`- **${t.name}**: ${t.columns.join(', ') || '(no columns)'}`);
    for (const r of t.relationships) lines.push(`  - rel: ${r}`);
  }
  lines.push('');

  lines.push(`## Data Calls (${scope.dataCalls.length})`);
  for (const d of scope.dataCalls) {
    lines.push(`- \`${d.page}\` [${d.kind}] ${d.target} — ${d.description}`);
  }
  lines.push('');

  lines.push(`## Broken Contracts (${scope.brokenContracts.length})`);
  if (scope.brokenContracts.length === 0) {
    lines.push('_None detected._');
  }
  for (const b of scope.brokenContracts) {
    lines.push(
      `- **[${b.severity}] ${b.kind}** @ \`${b.location}\` — ${b.detail}`,
    );
  }
  lines.push('');

  lines.push(`## Component Inventory (${scope.componentInventory.length})`);
  lines.push(scope.componentInventory.join(', ') || '_None._');
  lines.push('');

  lines.push(`## Library Inventory (${scope.libraryInventory.length})`);
  lines.push(scope.libraryInventory.join(', ') || '_None._');
  lines.push('');

  const b = scope.bootstrappedBrand;
  lines.push('## Bootstrapped Brand (candidate — NOT pinned)');
  lines.push(`- **Name:** ${b.name}`);
  lines.push(
    `- **Colors:** ${Object.entries(b.colors)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  lines.push(
    `- **Type scale:** ${Object.entries(b.typeScale)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  lines.push(
    `- **Spacing:** ${Object.entries(b.spacing)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  lines.push(`- **Voice:** ${b.voice}`);
  lines.push(`- **Component style:** ${b.componentStyle}`);
  lines.push(`- **Pinned:** ${b.pinned}`);
  lines.push('');

  return lines.join('\n');
}

/* ───────────────────────── main ───────────────────────── */

export async function runStage0(
  config: PipelineConfig,
  gemini: GeminiClient,
): Promise<ScopeDoc> {
  fs.mkdirSync(config.runDir, { recursive: true });

  // 1. Walk the working copy.
  const files = walkRepo(config.workDir);

  // 2. Static detection.
  const detectedRoutes = detectRoutes(files);
  const clientRoutes = detectClientRouter(files);
  const schemaSources = detectSchemaSources(files);

  // 3. package.json -> library inventory.
  const pkgPath = path.join(config.workDir, 'package.json');
  const pkg = safeReadJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(pkgPath);
  const depsInventory = [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ].sort();

  // 4. Build the digest and call the mapper model.
  const digest = buildDigest(config.workDir, files, schemaSources);

  let raw: MapperResponse;
  try {
    raw = await gemini.callJson<MapperResponse>({
      role: 'mapper',
      json: true,
      // Big monorepo digests take far longer than the default 120s.
      timeoutMs: MAPPER_TIMEOUT_MS,
      systemInstruction: mapperSystemInstruction(),
      prompt: mapperPrompt(
        config.projectSlug,
        digest,
        detectedRoutes,
        clientRoutes,
        schemaSources,
      ),
    });
  } catch (err) {
    // The mapper failing should not crash the run — degrade to a static scope.
    // (gemini.ts already records the failure into gemini.alerts.)
    console.error(
      `[stage0] mapper call failed, falling back to static scope: ${
        (err as Error).message
      }`,
    );
    raw = {};
  }

  // 5. If the model returned no brand, do one focused mechanical sub-call
  //    against just the theme files so the brand bootstrap isn't empty.
  if (!raw.bootstrappedBrand && collectThemeFiles(files).length > 0) {
    const themeFiles = collectThemeFiles(files).slice(0, 8);
    const themeDigest = themeFiles
      .map((f) => `--- ${f.rel} ---\n${truncate(safeRead(f.abs), FILE_TRUNCATE)}`)
      .join('\n\n');
    try {
      const brand = await gemini.callJson<Partial<BrandSpec>>({
        role: 'mechanical',
        json: true,
        systemInstruction:
          'Extract a candidate brand spec from these theme/CSS/Tailwind ' +
          'files. Return ONLY JSON with keys: name, colors, typeScale, ' +
          'spacing, radii, voice, componentStyle.',
        prompt: themeDigest,
      });
      raw.bootstrappedBrand = brand;
    } catch (err) {
      console.error(
        `[stage0] brand bootstrap sub-call failed: ${(err as Error).message}`,
      );
    }
  }

  // 6. Normalize into a strict ScopeDoc.
  const scope = normalizeScope(raw, config, detectedRoutes, depsInventory);

  // 6b. Over-scope guard — a real app rarely has more than ~50 UI screens.
  if (scope.pages.length > PAGE_COUNT_WARN_THRESHOLD) {
    const warning =
      `[stage0] WARNING: mapped ${scope.pages.length} pages ` +
      `(> ${PAGE_COUNT_WARN_THRESHOLD}). This usually means over-scoping — ` +
      `API routes, route handlers, or non-screen files leaking into "pages". ` +
      `A typical app has ~30-40 real screens. Review scope.md before ` +
      `proceeding; a full run over this many pages is slow and costly.`;
    console.warn(warning);
    gemini.alerts.push(warning);
  }

  // 7. Persist.
  fs.writeFileSync(
    path.join(config.runDir, 'scope.json'),
    JSON.stringify(scope, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(config.runDir, 'scope.md'),
    renderScopeMd(scope, config),
    'utf8',
  );

  return scope;
}
