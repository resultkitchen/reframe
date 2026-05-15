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

/**
 * Atomically write `runDir/state.json`: write a tmp file in the same dir,
 * then rename over the target (rename is atomic on the same volume).
 */
export function saveState(runDir: string, state: RunState): void {
  fs.mkdirSync(runDir, { recursive: true });

  const target = path.join(runDir, 'state.json');
  const tmp = path.join(
    runDir,
    `.state.${process.pid}.${Date.now()}.tmp`,
  );

  const json = `${JSON.stringify(state, null, 2)}\n`;

  try {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // Clean up the tmp file on failure so it never lingers.
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {
      // Ignore — best-effort cleanup.
    }
    throw err;
  }
}
