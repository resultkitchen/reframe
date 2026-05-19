/**
 * Durable RunState — the resume ledger.
 *
 * `saveState` is called after every checkpoint and writes `state.json`
 * atomically (tmp file + rename) so a crash mid-write never corrupts it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentName,
  PageState,
  PipelineConfig,
  RunState,
  StepStatus,
} from './types';

/** Every agent, all pending — the initial per-page checkpoint state. */
function freshAgentMap(): Record<AgentName, StepStatus> {
  return {
    audit: 'pending',
    ux: 'pending',
    design: 'pending',
    code: 'pending',
    verify: 'pending',
    compliance: 'pending',
  };
}

/**
 * Build a fresh RunState for a new run, with one PageState per slug.
 */
export function newRunState(
  config: PipelineConfig,
  slugs: string[],
): RunState {
  const pages: Record<string, PageState> = {};
  for (const slug of slugs) {
    pages[slug] = {
      slug,
      agents: freshAgentMap(),
    };
  }

  return {
    runDir: config.runDir,
    projectSlug: config.projectSlug,
    startedAt: new Date().toISOString(),
    stage0: 'pending',
    stage0_5: 'pending',
    pages,
    testScaffold: 'pending',
  };
}

/**
 * Load `runDir/state.json`, or null when it does not exist / is unreadable.
 */
export function loadState(runDir: string): RunState | null {
  const statePath = path.join(runDir, 'state.json');
  if (!fs.existsSync(statePath)) return null;

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw) as RunState;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[state] failed to load state.json from "${runDir}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/** Monotonic counter so concurrent saveState calls never collide on a tmp name. */
let stateWriteCounter = 0;

/** Brief synchronous sleep — used only for retry backoff on transient locks. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Error codes that indicate a transient file lock worth retrying. */
const TRANSIENT_FS_ERRORS = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
  'EEXIST',
  'ENOENT',
]);

/**
 * Atomically write `runDir/state.json`: write a uniquely-named tmp file in the
 * same dir, then rename over the target (rename is atomic on the same volume).
 *
 * On Windows a virus scanner / search indexer can briefly lock the target and
 * make `renameSync` throw EPERM/EBUSY — so the write+rename is retried a few
 * times with short backoff. Callers should additionally treat a thrown error
 * as non-fatal (a stale checkpoint must never abort real work).
 */
export function saveState(runDir: string, state: RunState): void {
  fs.mkdirSync(runDir, { recursive: true });

  const target = path.join(runDir, 'state.json');
  const json = `${JSON.stringify(state, null, 2)}\n`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    // Fresh, unique tmp name per attempt (pid + time + monotonic counter).
    const tmp = path.join(
      runDir,
      `.state.${process.pid}.${Date.now()}.${(stateWriteCounter += 1)}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      // Best-effort: never leave a tmp file lingering.
      try {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_FS_ERRORS.has(code)) break;
      sleepSync(4 * 2 ** attempt); // 4, 8, 16, 32, 64, 128 ms
    }
  }
  throw lastErr;
}
