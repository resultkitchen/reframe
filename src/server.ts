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

export function startReviewServer(runDir: string, port: number): Promise<http.Server> {
  const absRunDir = path.resolve(runDir);
  const staticDir = resolveStaticDir();

  console.log(`[reframe] starting review server for run: ${absRunDir}`);
  console.log(`[reframe] static web assets directory: ${staticDir}`);

  if (!fs.existsSync(absRunDir)) {
    console.error(`Error: target run directory does not exist: ${absRunDir}`);
    process.exit(1);
  }

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

        // Load approvals
        let approvals = loadApprovals(absRunDir);
        if (!approvals) {
          approvals = {
            runDir: absRunDir,
            approvedAt: new Date().toISOString(),
            pages: {},
          };
        }

        // Aggregate pages details
        const pages: any[] = [];
        const pagesDir = path.join(absRunDir, 'pages');

        if (fs.existsSync(pagesDir)) {
          const slugs = fs.readdirSync(pagesDir);
          for (const slug of slugs) {
            const pageDir = path.join(pagesDir, slug);
            if (!fs.statSync(pageDir).isDirectory()) continue;

            const pageDetails: any = { slug };

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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          runDir: absRunDir,
          isGitRepo,
          state,
          approvals,
          pages,
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

            let approvals = loadApprovals(absRunDir);
            if (!approvals) {
              approvals = {
                runDir: absRunDir,
                approvedAt: new Date().toISOString(),
                pages: {},
              };
            }

            approvals.pages[update.slug] = update.approval;
            approvals.approvedAt = new Date().toISOString();

            saveApprovals(absRunDir, approvals);

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

      const screenshotPath = path.join(absRunDir, 'pages', slug, filename);
      if (fs.existsSync(screenshotPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(screenshotPath).pipe(res);
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

      const htmlPath = path.join(absRunDir, 'pages', slug, 'audit.html');
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

      const diffPath = path.join(absRunDir, 'pages', slug, 'code.diff');
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
        const pageDir = path.join(absRunDir, 'pages', slug);
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

        const approvals = loadApprovals(absRunDir);
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

    // 5. POST /api/apply — Apply approved code refactor via resume command
    if (pathname === '/api/apply' && req.method === 'POST') {
      try {
        const manifestPath = path.join(absRunDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'manifest.json not found in run directory' }));
          return;
        }

        const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw);

        const target = manifest.target;
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Target path not found in manifest' }));
          return;
        }

        // Spawn rebuild in background
        const { spawn } = await import('node:child_process');
        
        // Find CLI path
        const cliPath = path.resolve(path.join(__dirname, 'cli.js'));
        const logFilePath = path.join(absRunDir, 'logs', 'apply-rebuild.log');
        
        // Ensure logs directory exists
        const logsDir = path.dirname(logFilePath);
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }
        
        const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

        logStream.write(`\n--- Applying Rebuild at ${new Date().toISOString()} ---\n`);
        logStream.write(`Command: node "${cliPath}" rebuild "${target}" --resume "${absRunDir}" --apply-mode pr\n\n`);

        const cp = spawn('node', [
          cliPath,
          'rebuild',
          target,
          '--resume',
          absRunDir,
          '--apply-mode',
          'pr'
        ], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        cp.stdout?.pipe(logStream);
        cp.stderr?.pipe(logStream);

        cp.on('error', (err) => {
          logStream.write(`Process spawn error: ${err.message}\n`);
        });

        cp.unref();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Rebuild apply process triggered in background.',
          logFile: logFilePath
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
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
