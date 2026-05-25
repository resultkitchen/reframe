/**
 * Approvals and Comments Ledger tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadApprovals, saveApprovals } from '../state';
import type { ApprovalsDoc } from '../types';

test('approvals ledger round-trip preserves decisions and comments', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-test-'));
  try {
    const approvals: ApprovalsDoc = {
      runDir: tempDir,
      approvedAt: new Date().toISOString(),
      pages: {
        'dashboard': {
          decision: 'apply',
          comments: ['Make sure visual contrast satisfies ADA specs.'],
          note: 'Approved by designer',
          gaps: {
            'g1': 'apply',
            'g2': 'skip',
          },
        },
        'settings': {
          decision: 'skip',
          comments: [],
        },
      },
    };

    saveApprovals(tempDir, approvals);

    const loaded = loadApprovals(tempDir);
    assert.ok(loaded, 'loaded approvals should not be null');
    assert.equal(loaded.pages['dashboard'].decision, 'apply');
    assert.equal(loaded.pages['dashboard'].note, 'Approved by designer');
    assert.deepEqual(loaded.pages['dashboard'].comments, ['Make sure visual contrast satisfies ADA specs.']);
    assert.deepEqual(loaded.pages['dashboard'].gaps, { g1: 'apply', g2: 'skip' });
    
    assert.equal(loaded.pages['settings'].decision, 'skip');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadApprovals returns null when no approvals.json exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-empty-'));
  try {
    assert.equal(loadApprovals(tempDir), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
