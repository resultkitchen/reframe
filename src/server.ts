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

            // Verify if screenshots exist
            pageDetails.hasScreenshot = fs.existsSync(path.join(pageDir, 'audit.png'));

            pages.push(pageDetails);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          runDir: absRunDir,
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

    // 3. GET /api/screenshot/:slug — Serve individual screen PNG
    if (pathname.startsWith('/api/screenshot/') && req.method === 'GET') {
      const slug = pathname.substring('/api/screenshot/'.length);
      if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
        res.writeHead(400);
        res.end('Malformed page slug parameter');
        return;
      }

      const screenshotPath = path.join(absRunDir, 'pages', slug, 'audit.png');
      if (fs.existsSync(screenshotPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(screenshotPath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Screenshot not found');
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
