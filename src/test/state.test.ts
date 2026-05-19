/**
 * Resume-ledger round-trip tests (P3).
 *
 * The review→apply two-pass workflow depends on `state.json` faithfully
 * surviving a save/load cycle — a `done` agent must still read as `done` so
 * the apply pass skips it. These tests pin that core resume guarantee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { newRunState, saveState, loadState } from '../state';
import type { PipelineConfig } from '../types';

test('resume ledger round-trip preserves a done checkpoint', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  try {
    const config = {
      runDir: tempDir,
      projectSlug: 'demo',
    } as unknown as PipelineConfig;

    const slugs = ['page-1', 'page-2'];
    const state = newRunState(config, slugs);
    saveState(tempDir, state);

    const loaded = loadState(tempDir);
    assert.ok(loaded, 'loaded state should not be null');
    assert.equal(loaded.projectSlug, 'demo');
    assert.deepEqual(Object.keys(loaded.pages).sort(), [...slugs].sort());
    assert.equal(loaded.pages['page-1'].agents.audit, 'pending');

    // Flip one agent to 'done' and confirm it survives a second round-trip —
    // this is exactly what lets a resumed run skip completed work.
    state.pages['page-1'].agents.audit = 'done';
    saveState(tempDir, state);

    const reloaded = loadState(tempDir);
    assert.ok(reloaded, 'reloaded state should not be null');
    assert.equal(
      reloaded.pages['page-1'].agents.audit,
      'done',
      "'done' status must persist across save/load",
    );
    assert.equal(
      reloaded.pages['page-2'].agents.audit,
      'pending',
      'untouched pages stay pending',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadState returns null for a directory with no state.json', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-empty-'));
  try {
    assert.equal(loadState(tempDir), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
