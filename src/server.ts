/**
 * Zero-dependency local Node.js server for the Reframe Review App.
 *
 * Serves the React visual review client and provides REST API endpoints
 * to load/save the approvals ledger and serve local screen screenshots.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadApprovals, saveApprovals } from './state';
import type { ApprovalsDoc, PageApproval } from './types';

/* ─────────────────────────── telemetry aggregation ─────────────────────────── */

interface BucketStats {
  apply: number;
  skip: number;
  /** Heads-up pill text suggested when this bucket is dominated by skips. */
  suggestion?: string;
}

interface TelemetryResponse {
  schemaVersion: 1;
  scannedRuns: number;
  totalDecisions: number;
  /** Aggregate decisions per dimension across every scanned run. */
  byDimension: Record<string, BucketStats>;
  /** Aggregate decisions per severity across every scanned run. */
  bySeverity: Record<string, BucketStats>;
  /** High-skip-rate (>= 70%) buckets with enough sample (>= 5) to surface. */
  insights: Array<{
    axis: 'dimension' | 'severity';
    value: string;
    applies: number;
    skips: number;
    skipRate: number;
    headline: string;
  }>;
}

const TELEMETRY_RUN_CAP = 50;
const TELEMETRY_AGE_DAYS_CAP = 90;
const INSIGHT_MIN_SAMPLE = 5;
const INSIGHT_SKIP_RATE_THRESHOLD = 0.7;

function computeTelemetry(runsParent: string, currentRunDir: string): TelemetryResponse {
  const result: TelemetryResponse = {
    schemaVersion: 1,
    scannedRuns: 0,
    totalDecisions: 0,
    byDimension: {},
    bySeverity: {},
    insights: [],
  };

  if (!fs.existsSync(runsParent) || !fs.statSync(runsParent).isDirectory()) {
    return result;
  }

  const cutoffMs = Date.now() - TELEMETRY_AGE_DAYS_CAP * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(runsParent)
    .map((name) => {
      const abs = path.join(runsParent, name);
      try {
        const stat = fs.statSync(abs);
        return stat.isDirectory() && stat.mtimeMs >= cutoffMs ? { abs, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { abs: string; mtimeMs: number } => Boolean(x))
    // Always include the current run plus the most-recent prior runs.
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, TELEMETRY_RUN_CAP);

  // Make sure the current run is in the set even when there are >50 priors.
  if (!entries.some((e) => e.abs === currentRunDir) && fs.existsSync(currentRunDir)) {
    entries.unshift({ abs: currentRunDir, mtimeMs: Date.now() });
  }

  const bump = (bucket: Record<string, BucketStats>, key: string, decision: 'apply' | 'skip'): void => {
    if (!bucket[key]) bucket[key] = { apply: 0, skip: 0 };
    bucket[key][decision]++;
    result.totalDecisions++;
  };

  for (const { abs: runDir } of entries) {
    const pagesDir = path.join(runDir, 'pages');
    if (!fs.existsSync(pagesDir)) continue;
    const approvalsRaw = (() => {
      try {
        const apath = path.join(runDir, 'approvals.json');
        return fs.existsSync(apath)
          ? (JSON.parse(fs.readFileSync(apath, 'utf8')) as ApprovalsDoc)
          : null;
      } catch {
        return null;
      }
    })();

    let slugs: string[];
    try {
      slugs = fs.readdirSync(pagesDir).filter((s) => {
        try { return fs.statSync(path.join(pagesDir, s)).isDirectory(); } catch { return false; }
      });
    } catch {
      continue;
    }
    if (slugs.length === 0) continue;
    result.scannedRuns++;

    for (const slug of slugs) {
      const pageDir = path.join(pagesDir, slug);
      const pageApproval = approvalsRaw?.pages?.[slug];
      const pageBypassed = pageApproval?.decision === 'skip';

      // Audit gaps
      try {
        const auditPath = path.join(pageDir, 'audit.json');
        if (fs.existsSync(auditPath)) {
          const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
          for (const gap of audit.gaps ?? []) {
            const dec = pageBypassed || pageApproval?.gaps?.[gap.id] === 'skip' ? 'skip' : 'apply';
            if (gap.dimension) bump(result.byDimension, gap.dimension, dec);
            if (gap.severity) bump(result.bySeverity, gap.severity, dec);
          }
        }
      } catch { /* skip malformed audit.json */ }

      // Compliance findings
      try {
        const compliancePath = path.join(pageDir, 'compliance.json');
        if (fs.existsSync(compliancePath)) {
          const compliance = JSON.parse(fs.readFileSync(compliancePath, 'utf8'));
          for (const finding of compliance.findings ?? []) {
            const key = `${finding.ruleId}::${finding.location}`;
            const dec = pageBypassed || pageApproval?.complianceFindings?.[key] === 'skip' ? 'skip' : 'apply';
            if (finding.dimension) bump(result.byDimension, finding.dimension, dec);
            if (finding.severity) bump(result.bySeverity, finding.severity, dec);
          }
        }
      } catch { /* skip malformed compliance.json */ }
    }
  }

  // Compute high-skip-rate insights — the actionable pattern the UI surfaces.
  const buildInsights = (
    axis: 'dimension' | 'severity',
    bucket: Record<string, BucketStats>,
  ): void => {
    for (const [value, stats] of Object.entries(bucket)) {
      const sample = stats.apply + stats.skip;
      if (sample < INSIGHT_MIN_SAMPLE) continue;
      const skipRate = stats.skip / sample;
      if (skipRate < INSIGHT_SKIP_RATE_THRESHOLD) continue;
      const pct = Math.round(skipRate * 100);
      result.insights.push({
        axis,
        value,
        applies: stats.apply,
        skips: stats.skip,
        skipRate,
        headline:
          axis === 'dimension'
            ? `You've skipped ${stats.skip}/${sample} ${value} finding${sample === 1 ? '' : 's'} (${pct}%). Consider hiding the ${value} dimension by default.`
            : `You've skipped ${stats.skip}/${sample} ${value}-severity finding${sample === 1 ? '' : 's'} (${pct}%). Consider raising the minimum severity filter.`,
      });
    }
  };
  buildInsights('dimension', result.byDimension);
  buildInsights('severity', result.bySeverity);
  result.insights.sort((a, b) => b.skipRate - a.skipRate);

  return result;
}

/** Find the built SPA assets folder across dev and prod build structures. */
function resolveStaticDir(): string {
  const candidates = [
    // Production layout (compiled JS inside dist/, review-app inside dist/review-app)
    path.join(__dirname, 'review-app'),
    // Development layout (source in src/, review-app inside review-app/dist)
    path.join(__dirname, '..', 'review-app', 'dist'),
    path.join(__dirname, '..', 'dist', 'review-app'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      return c;
    }
  }

  // Fallback to current folder
  return __dirname;
}

/**
 * Resolve a list of run dirs into the primary + per-slug routing map.
 *
 * Multi-run mode (review across N persona-scoped runs in one SPA) requires
 * that each page slug is owned by exactly one run dir. Stage 0's role
 * filter keeps slugs disjoint across role-scoped runs of the same target,
 * so collisions are a real bug to surface — not silently merge.
 */
function buildRunSet(input: string | string[]): {
  primary: string;
  all: string[];
  slugToRunDir: Map<string, string>;
} {
  const list = Array.isArray(input) ? input : [input];
  const all = list.map((p) => path.resolve(p));
  for (const dir of all) {
    if (!fs.existsSync(dir)) {
      console.error(`Error: target run directory does not exist: ${dir}`);
      process.exit(1);
    }
  }
  const slugToRunDir = new Map<string, string>();
  for (const dir of all) {
    const pagesDir = path.join(dir, 'pages');
    if (!fs.existsSync(pagesDir)) continue;
    for (const slug of fs.readdirSync(pagesDir)) {
      const slugPath = path.join(pagesDir, slug);
      if (!fs.statSync(slugPath).isDirectory()) continue;
      const existing = slugToRunDir.get(slug);
      if (existing && existing !== dir) {
        console.error(
          `Error: slug "${slug}" present in multiple run dirs ` +
            `(${existing} and ${dir}). Multi-run review requires disjoint slugs.`,
        );
        process.exit(1);
      }
      slugToRunDir.set(slug, dir);
    }
  }
  return { primary: all[0], all, slugToRunDir };
}

export function startReviewServer(
  runDir: string | string[],
  port: number,
): Promise<http.Server> {
  const runSet = buildRunSet(runDir);
  const absRunDir = runSet.primary;
  const isMultiRun = runSet.all.length > 1;
  const dirForSlug = (slug: string): string => runSet.slugToRunDir.get(slug) ?? absRunDir;
  const staticDir = resolveStaticDir();

  if (isMultiRun) {
    console.log(`[reframe] starting review server across ${runSet.all.length} run(s):`);
    for (const d of runSet.all) console.log(`[reframe]   - ${d}`);
  } else {
    console.log(`[reframe] starting review server for run: ${absRunDir}`);
  }
  console.log(`[reframe] static web assets directory: ${staticDir}`);

  const server = http.createServer(async (req, res) => {
    // Enable CORS for development ease
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '', `http://localhost:${port}`);
    const pathname = url.pathname;

    // ────────────────────────── REST API ──────────────────────────

    // 1. GET /api/run — Load full dashboard data
    if (pathname === '/api/run' && req.method === 'GET') {
      try {
        const statePath = path.join(absRunDir, 'state.json');
        if (!fs.existsSync(statePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'state.json not found in run directory' }));
          return;
        }

        const stateRaw = fs.readFileSync(statePath, 'utf8');
        const state = JSON.parse(stateRaw);

        // Approvals: load per-run, then merge. In multi-run mode each run's
        // approvals.json is the source of truth for its own slugs (so a later
        // `--apply-mode pr` resume against a single run dir sees the right
        // decisions). The merged view here is read-only — writes route back
        // to the originating run via the POST handler below.
        const mergedApprovals: ApprovalsDoc = {
          runDir: absRunDir,
          approvedAt: new Date().toISOString(),
          pages: {},
        };
        for (const dir of runSet.all) {
          const a = loadApprovals(dir);
          if (!a) continue;
          for (const [slug, approval] of Object.entries(a.pages)) {
            mergedApprovals.pages[slug] = approval;
          }
        }
        const approvals = mergedApprovals;

        // Aggregate pages details across every run dir in the set.
        const pages: any[] = [];
        for (const sourceDir of runSet.all) {
          const pagesDir = path.join(sourceDir, 'pages');
          if (!fs.existsSync(pagesDir)) continue;
          const slugs = fs.readdirSync(pagesDir);
          for (const slug of slugs) {
            const pageDir = path.join(pagesDir, slug);
            if (!fs.statSync(pageDir).isDirectory()) continue;

            const pageDetails: any = { slug, originRunDir: sourceDir };

            // Load audit
            const auditPath = path.join(pageDir, 'audit.json');
            if (fs.existsSync(auditPath)) {
              try {
                pageDetails.audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
              } catch {}
            }

            pageDetails.route = pageDetails.audit?.page || '/' + slug.replace(/-/g, '/');

            // Load UX spec
            const uxPath = path.join(pageDir, 'ux.json');
            if (fs.existsSync(uxPath)) {
              try {
                pageDetails.ux = JSON.parse(fs.readFileSync(uxPath, 'utf8'));
              } catch {}
            }

            // Load Design spec
            const designPath = path.join(pageDir, 'design.json');
            if (fs.existsSync(designPath)) {
              try {
                pageDetails.design = JSON.parse(fs.readFileSync(designPath, 'utf8'));
              } catch {}
            }

            // Load Compliance findings
            const compliancePath = path.join(pageDir, 'compliance.json');
            if (fs.existsSync(compliancePath)) {
              try {
                pageDetails.compliance = JSON.parse(fs.readFileSync(compliancePath, 'utf8'));
              } catch {}
            }

            // Load Code proposal details & diff
            const codePath = path.join(pageDir, 'code.json');
            if (fs.existsSync(codePath)) {
              try {
                pageDetails.code = JSON.parse(fs.readFileSync(codePath, 'utf8'));
              } catch {}
            }

            const codeDiffPath = path.join(pageDir, 'code.diff');
            if (fs.existsSync(codeDiffPath)) {
              try {
                pageDetails.codeDiff = fs.readFileSync(codeDiffPath, 'utf8');
              } catch {}
            }

            // Verify if screenshots and HTML exist
            pageDetails.hasScreenshot = fs.existsSync(path.join(pageDir, 'audit.png'));
            pageDetails.hasHtml = fs.existsSync(path.join(pageDir, 'audit.html'));

            pages.push(pageDetails);
          }
        }

        let isGitRepo = false;
        try {
          const manifestPath = path.join(absRunDir, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const targetPath = manifest.target;
            if (targetPath) {
              const resolvedTarget = path.resolve(targetPath);
              isGitRepo = fs.existsSync(path.join(resolvedTarget, '.git'));
            }
          } else {
            isGitRepo = fs.existsSync(path.join(absRunDir, '..', '.git')) || fs.existsSync(path.join(process.cwd(), '.git'));
          }
        } catch {
          isGitRepo = fs.existsSync(path.join(process.cwd(), '.git'));
        }

        // Surface brand + scope as read-only artifacts so the SPA can render
        // visual brand and data-contract panels without a separate fetch.
        // (No engine logic change — just additional file reads.)
        let brand: any = null;
        const brandPath = path.join(absRunDir, 'brand.resolved.json');
        if (fs.existsSync(brandPath)) {
          try { brand = JSON.parse(fs.readFileSync(brandPath, 'utf8')); } catch {}
        }
        let scope: any = null;
        const scopePath = path.join(absRunDir, 'scope.json');
        if (fs.existsSync(scopePath)) {
          try { scope = JSON.parse(fs.readFileSync(scopePath, 'utf8')); } catch {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          runDir: absRunDir,
          runDirs: runSet.all,
          isGitRepo,
          state,
          approvals,
          pages,
          brand,
          scope,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 2. POST /api/approvals — Save/update approvals doc
    if (pathname === '/api/approvals' && req.method === 'POST') {
      try {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            const update = JSON.parse(body) as { slug: string; approval: PageApproval };
            if (!update.slug || !update.approval) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing slug or approval payload' }));
              return;
            }

            // Route approval write to the originating run dir for the slug
            // (so each persona run's approvals.json stays authoritative for
            // its own pages and a later --resume --apply-mode pr sees them).
            const targetDir = dirForSlug(update.slug);
            let approvals = loadApprovals(targetDir);
            if (!approvals) {
              approvals = {
                runDir: targetDir,
                approvedAt: new Date().toISOString(),
                pages: {},
              };
            }

            approvals.pages[update.slug] = update.approval;
            approvals.approvedAt = new Date().toISOString();

            saveApprovals(targetDir, approvals);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, approvals }));
          } catch (jsonErr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
          }
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 2.5. GET /api/telemetry — cross-run pattern insights.
    //
    // Scans every sibling run dir in the same `runs/` parent and aggregates
    // per-finding-dimension and per-severity apply/skip decisions. Surfaces
    // patterns the reviewer can act on ("you've skipped 14/17 low-severity
    // a11y findings — hide them by default?") in the review app's Run
    // Overview panel.
    //
    // Bounded: scans at most 50 sibling runs, capped 90 days back, so a
    // long-lived runs/ directory doesn't slow the endpoint to a crawl.
    if (pathname === '/api/telemetry' && req.method === 'GET') {
      try {
        const runsParent = path.dirname(absRunDir);
        const insights = computeTelemetry(runsParent, absRunDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(insights));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 3. GET /api/screenshot/:slug[?breakpoint=mobile|tablet|desktop]
    //    Serves the default audit.png, or a specific breakpoint file when
    //    the optional `breakpoint` query parameter is set.
    if (pathname.startsWith('/api/screenshot/') && req.method === 'GET') {
      const slug = pathname.substring('/api/screenshot/'.length);
      if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
        res.writeHead(400);
        res.end('Malformed page slug parameter');
        return;
      }

      const breakpoint = url.searchParams.get('breakpoint');
      let filename = 'audit.png';
      if (breakpoint) {
        // Strict safelist to prevent path traversal via the query parameter.
        if (!/^[a-z0-9-]{1,32}$/i.test(breakpoint)) {
          res.writeHead(400);
          res.end('Malformed breakpoint name');
          return;
        }
        filename = `audit-${breakpoint}.png`;
      }

      const slugDir = dirForSlug(slug);
      const screenshotPath = path.join(slugDir, 'pages', slug, filename);
      // Fall back to the default audit.png when a breakpoint-specific
      // capture wasn't recorded for this run. Lets the SPA's Phone /
      // Tablet preset tabs show *something* even on runs that didn't
      // exercise multi-breakpoint capture, instead of dead 404s.
      const fallbackPath = path.join(slugDir, 'pages', slug, 'audit.png');
      const servePath = fs.existsSync(screenshotPath) ? screenshotPath
        : (filename !== 'audit.png' && fs.existsSync(fallbackPath)) ? fallbackPath
        : null;
      if (servePath) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(servePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Screenshot not found');
      }
      return;
    }

    // 4. GET /api/html/:slug — Serve individual page HTML snapshot
    if (pathname.startsWith('/api/html/') && req.method === 'GET') {
      const slug = pathname.substring('/api/html/'.length);
      if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
        res.writeHead(400);
        res.end('Malformed page slug parameter');
        return;
      }

      const htmlPath = path.join(dirForSlug(slug), 'pages', slug, 'audit.html');
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data:; style-src * 'unsafe-inline';",
          'X-Frame-Options': 'SAMEORIGIN'
        });
        fs.createReadStream(htmlPath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('HTML snapshot not found');
      }
      return;
    }

    // 4.5. GET /api/patch/:slug — Download standard git patch file
    if (pathname.startsWith('/api/patch/') && req.method === 'GET') {
      const slug = pathname.substring('/api/patch/'.length);
      if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
        res.writeHead(400);
        res.end('Malformed page slug parameter');
        return;
      }

      const diffPath = path.join(dirForSlug(slug), 'pages', slug, 'code.diff');
      if (fs.existsSync(diffPath)) {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Disposition': `attachment; filename="${slug}-refactor.patch"`
        });
        fs.createReadStream(diffPath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Diff patch not found');
      }
      return;
    }

    // 4.6. GET /api/download-prompt/:slug — Download compiled AI refactoring prompt as markdown
    if (pathname.startsWith('/api/download-prompt/') && req.method === 'GET') {
      const slug = pathname.substring('/api/download-prompt/'.length);
      if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
        res.writeHead(400);
        res.end('Malformed page slug parameter');
        return;
      }

      try {
        const slugDir = dirForSlug(slug);
        const pageDir = path.join(slugDir, 'pages', slug);
        if (!fs.existsSync(pageDir)) {
          res.writeHead(404);
          res.end('Page directory not found');
          return;
        }

        // Load audit, design, and approvals
        let audit: any = {};
        const auditPath = path.join(pageDir, 'audit.json');
        if (fs.existsSync(auditPath)) {
          try { audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch {}
        }

        let design: any = {};
        const designPath = path.join(pageDir, 'design.json');
        if (fs.existsSync(designPath)) {
          try { design = JSON.parse(fs.readFileSync(designPath, 'utf8')); } catch {}
        }

        const approvals = loadApprovals(slugDir);
        const pageApproval = approvals?.pages?.[slug];

        // Format gaps
        const approvedGaps = audit?.gaps?.filter((g: any) => pageApproval?.gaps?.[g.id] !== 'skip') || [];
        let gapsSection = '';
        if (approvedGaps.length > 0) {
          gapsSection = approvedGaps.map((g: any) => {
            return `- **[${g.severity.toUpperCase()}] ${g.category.toUpperCase()}**: ${g.description}\n  *Fix Strategy*: ${g.recommendation}`;
          }).join('\n');
        } else {
          gapsSection = '- Review visual specifications and optimize layout for premium responsive aesthetics.';
        }

        const designSpec = design?.spec ? `\n### Brand Visual Tokens & Rules:\n${design.spec}` : '';
        const pmNotes = pageApproval?.note ? `\n### PM Adjustments & Instructions:\n${pageApproval.note}` : '';
        const route = audit?.page || '/' + slug.replace(/-/g, '/');

        const promptMarkdown = `# Reframe AI Refactoring Instruction Set

You are an expert AI software architect. Please apply the following approved visual and functional refactoring upgrades directly to the target source file.

## Workspace Context
- **Screen**: ${slug}
- **Route**: ${route}

## Target Upgrades to Apply:
${gapsSection}
${designSpec}
${pmNotes}

## Execution Checklist:
1. Refactor the code changes inside the target page file to resolve all approved gaps.
2. Maintain brand token guidelines and correct any visual contrast or alignment errors.
3. Keep all existing unrelated comments, hooks, and logic intact.
4. Verify changes compile and serve cleanly.`;

        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${slug}-refactor-prompt.md"`
        });
        res.end(promptMarkdown);
      } catch (err) {
        res.writeHead(500);
        res.end(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // 5. POST /api/apply — Apply approved code refactor via resume command.
    // In multi-run mode, fan out: spawn one `rebuild --resume <dir>` per run
    // so each persona PR's against its own scope. Returns `logFiles[]` plus
    // `logFile` (first) for backward compat with single-run SPAs.
    if (pathname === '/api/apply' && req.method === 'POST') {
      try {
        const { spawn } = await import('node:child_process');
        const cliPath = path.resolve(path.join(__dirname, 'cli.js'));
        const logFiles: string[] = [];
        const errors: string[] = [];

        for (const dir of runSet.all) {
          const manifestPath = path.join(dir, 'manifest.json');
          if (!fs.existsSync(manifestPath)) {
            errors.push(`manifest.json not found in ${dir}`);
            continue;
          }
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const target = manifest.target;
          if (!target) {
            errors.push(`Target path not found in manifest of ${dir}`);
            continue;
          }
          const logFilePath = path.join(dir, 'logs', 'apply-rebuild.log');
          const logsDir = path.dirname(logFilePath);
          if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
          const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
          logStream.write(`\n--- Applying Rebuild at ${new Date().toISOString()} ---\n`);
          logStream.write(`Command: node "${cliPath}" rebuild "${target}" --resume "${dir}" --apply-mode pr\n\n`);
          const cp = spawn('node', [cliPath, 'rebuild', target, '--resume', dir, '--apply-mode', 'pr'], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          cp.stdout?.pipe(logStream);
          cp.stderr?.pipe(logStream);
          cp.on('error', (err) => { logStream.write(`Process spawn error: ${err.message}\n`); });
          cp.unref();
          logFiles.push(logFilePath);
        }

        if (logFiles.length === 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errors.join('; ') || 'No applicable runs' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: isMultiRun
            ? `Rebuild apply triggered across ${logFiles.length} run(s).`
            : 'Rebuild apply process triggered in background.',
          logFile: logFiles[0],
          logFiles,
          errors: errors.length ? errors : undefined,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 6. POST /api/verify — Re-run Agent 5 against the run set.
    //    Mirrors /api/apply: in multi-run mode, spawn one verify per run.
    if (pathname === '/api/verify' && req.method === 'POST') {
      try {
        const { spawn } = await import('node:child_process');
        const cliPath = path.resolve(path.join(__dirname, 'cli.js'));
        const logFiles: string[] = [];

        for (const dir of runSet.all) {
          const logFilePath = path.join(dir, 'logs', 'verify.log');
          const logsDir = path.dirname(logFilePath);
          if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
          const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
          logStream.write(`\n--- Re-verify at ${new Date().toISOString()} ---\n`);
          logStream.write(`Command: node "${cliPath}" verify "${dir}"\n\n`);
          const cp = spawn('node', [cliPath, 'verify', dir], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          cp.stdout?.pipe(logStream);
          cp.stderr?.pipe(logStream);
          cp.on('error', (err) => { logStream.write(`Process spawn error: ${err.message}\n`); });
          cp.unref();
          logFiles.push(logFilePath);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: isMultiRun
            ? `Verify pass triggered across ${logFiles.length} run(s).`
            : 'Verify pass triggered.',
          logFile: logFiles[0],
          logFiles,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 7. GET /api/verify/status — Tail the verify log(s); returns last 4KB
    //    per run (concatenated with run-dir headers in multi-run mode) and
    //    a boolean done-ness derived from each log's final lines.
    if (pathname === '/api/verify/status' && req.method === 'GET') {
      const sections: string[] = [];
      let anyRunning = false;
      for (const dir of runSet.all) {
        const logFilePath = path.join(dir, 'logs', 'verify.log');
        if (!fs.existsSync(logFilePath)) continue;
        const stat = fs.statSync(logFilePath);
        const start = Math.max(0, stat.size - 4096);
        const fd = fs.openSync(logFilePath, 'r');
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const tail = buf.toString('utf8');
        const thisDone = /run complete/.test(tail);
        if (!thisDone) anyRunning = true;
        sections.push(isMultiRun ? `=== ${path.basename(dir)} ===\n${tail}` : tail);
      }
      const log = sections.join('\n\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: anyRunning && sections.length > 0, log }));
      return;
    }

    // ────────────────────────── STATIC ASSET ROUTER ──────────────────────────

    // Resolve file path to static web app
    let safePath = pathname === '/' ? '/index.html' : pathname;
    if (safePath.includes('..')) {
      res.writeHead(400);
      res.end('Access Denied');
      return;
    }

    const filePath = path.join(staticDir, safePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      // Fallback to SPA index.html for modern client-side routing
      const indexPath = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('File Not Found');
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[reframe] review dashboard live at http://localhost:${port}`);
      resolve(server);
    });
  });
}
