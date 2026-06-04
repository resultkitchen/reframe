/**
 * Reframe Review Server REST API endpoints tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startReviewServer } from '../server';
import type { RunState, ApprovalsDoc } from '../types';

test('server API /api/run aggregates state and serves screenshots', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
  const port = 3181; // use separate port to avoid collision

  try {
    // Scaffold minimal state.json
    const state: RunState = {
      runDir: tempDir,
      projectSlug: 'test-project',
      startedAt: new Date().toISOString(),
      stage0: 'done',
      stage0_5: 'done',
      pages: {
        'dashboard-slug': {
          slug: 'dashboard-slug',
          agents: {
            audit: 'done',
            ux: 'pending',
            design: 'pending',
            code: 'pending',
            verify: 'pending',
            compliance: 'pending',
          },
        },
      },
      testScaffold: 'pending',
    };
    fs.writeFileSync(path.join(tempDir, 'state.json'), JSON.stringify(state, null, 2));

    // Create page folders and audit.json
    const pageDir = path.join(tempDir, 'pages', 'dashboard-slug');
    fs.mkdirSync(pageDir, { recursive: true });
    
    const auditData = {
      page: 'dashboard-slug',
      gaps: [{ id: 'g1', category: 'ux', severity: 'high', description: 'Test gap' }],
    };
    fs.writeFileSync(path.join(pageDir, 'audit.json'), JSON.stringify(auditData, null, 2));
    fs.writeFileSync(path.join(pageDir, 'audit.png'), 'dummy-png-bytes');

    // Start server
    const server = await startReviewServer(tempDir, port);

    try {
      // Call /api/run
      const res = await fetch(`http://localhost:${port}/api/run`);
      assert.equal(res.status, 200);

      const json = (await res.json()) as any;
      assert.equal(json.runDir, tempDir);
      assert.equal(json.state.projectSlug, 'test-project');
      assert.equal(json.pages.length, 1);
      assert.equal(json.pages[0].slug, 'dashboard-slug');
      assert.equal(json.pages[0].audit.gaps[0].id, 'g1');
      assert.equal(json.pages[0].hasScreenshot, true);

      // Call /api/screenshot/dashboard-slug
      const imgRes = await fetch(`http://localhost:${port}/api/screenshot/dashboard-slug`);
      assert.equal(imgRes.status, 200);
      assert.equal(imgRes.headers.get('content-type'), 'image/png');
      const text = await imgRes.text();
      assert.equal(text, 'dummy-png-bytes');
    } finally {
      // Close server
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server API POST /api/approvals writes approvals.json atomically', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-post-test-'));
  const port = 3182;

  try {
    const state: RunState = {
      runDir: tempDir,
      projectSlug: 'test-project',
      startedAt: new Date().toISOString(),
      stage0: 'done',
      stage0_5: 'done',
      pages: {},
      testScaffold: 'pending',
    };
    fs.writeFileSync(path.join(tempDir, 'state.json'), JSON.stringify(state, null, 2));

    const server = await startReviewServer(tempDir, port);

    try {
      const approvalPayload = {
        slug: 'home-slug',
        approval: {
          decision: 'apply',
          note: 'Visual layout approved by client',
          comments: ['Make CTA buttons royal blue.'],
        },
      };

      const res = await fetch(`http://localhost:${port}/api/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(approvalPayload),
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.success, true);

      // Verify file was written to disk
      const approvalsPath = path.join(tempDir, 'approvals.json');
      assert.ok(fs.existsSync(approvalsPath), 'approvals.json should exist');
      
      const fileData = JSON.parse(fs.readFileSync(approvalsPath, 'utf8')) as ApprovalsDoc;
      assert.equal(fileData.pages['home-slug'].decision, 'apply');
      assert.equal(fileData.pages['home-slug'].note, 'Visual layout approved by client');
      assert.deepEqual(fileData.pages['home-slug'].comments, ['Make CTA buttons royal blue.']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
