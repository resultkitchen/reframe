/**
 * `reframe verify <runDir>` — re-run only Agent 5 against an existing run.
 *
 * Closes Priya's incremental dev loop: fix a finding by hand in the
 * source repo, then verify just that page (or every page) without
 * re-running audit / ux / design / compliance / code from scratch.
 * The full pipeline takes minutes; verify-only takes seconds.
 *
 * How it works
 *  1. Reads `<runDir>/manifest.json` to recover the original `target`
 *     (the source repo path or URL).
 *  2. Clears every page's `verify` checkpoint to 'pending' in state.json
 *     so the resume path actually re-runs verify instead of treating it
 *     as already done. Also clears stage0_5 since the dev server must
 *     re-boot (scratch is torn down at the end of every run).
 *  3. Delegates to runPipeline with `--verify-only --apply-mode propose
 *     --resume <runDir>`. The orchestrator's --verify-only branch loads
 *     each page's audit.json from disk, skips agents 1-4, runs Agent 5,
 *     and writes a fresh verify.json next to the existing artifacts.
 *
 * Exits 0 when every page passes verify; 1 otherwise (matching `rebuild`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveConfig } from './config';
import { runPipeline } from './orchestrator';
import { loadState, saveState } from './state';
import type { AgentName, StepStatus } from './types';

export async function runVerifyOnly(
  runDirArg: string,
  extraArgs: string[],
): Promise<number> {
  const runDir = path.resolve(runDirArg);
  if (!fs.existsSync(runDir)) {
    console.error(`Error: run directory does not exist: ${runDir}`);
    return 1;
  }

  // Recover the original target from manifest.json — without it we have
  // nothing to point the work-copy materializer at.
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(
      `Error: ${manifestPath} not found.\n` +
        `'reframe verify' requires a completed run with a manifest. Run \`reframe rebuild <target>\` first.`,
    );
    return 1;
  }
  let target: string;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { target?: string };
    if (!manifest.target) throw new Error('manifest.json has no "target" field');
    target = manifest.target;
  } catch (err) {
    console.error(
      `Error: could not read target from ${manifestPath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }

  // Reset verify checkpoint state so resume re-runs Agent 5. Stage 0.5
  // resets implicitly inside runPipeline (scratch was torn down on the
  // prior run's exit), but the page-level agent checkpoints persist —
  // we have to opt verify back in explicitly.
  const state = loadState(runDir);
  if (state) {
    state.stage0_5 = 'pending';
    for (const pageState of Object.values(state.pages)) {
      (pageState.agents as Record<AgentName, StepStatus>).verify = 'pending';
      pageState.pass = undefined;
    }
    try {
      saveState(runDir, state);
    } catch (err) {
      console.error(
        `Warning: could not reset verify checkpoints in state.json: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      // Non-fatal — runPipeline will run verify anyway via the
      // --verify-only branch, just won't get the clean checkpoint trail.
    }
  }

  // Build argv as if the user had typed:
  //   rebuild <target> --resume <runDir> --verify-only --apply-mode propose [extraArgs]
  const rebuiltArgv = [
    'rebuild',
    target,
    '--resume',
    runDir,
    '--verify-only',
    '--apply-mode',
    'propose',
    ...extraArgs,
  ];

  const config = await resolveConfig(rebuiltArgv);
  const manifest = await runPipeline(config);

  const allPass =
    manifest.pagesProcessed.length > 0 &&
    manifest.pagesProcessed.every((p) => p.pass);
  const passCount = manifest.pagesProcessed.filter((p) => p.pass).length;
  console.log(
    `\n[reframe verify] ${passCount}/${manifest.pagesProcessed.length} page(s) verified clean.`,
  );
  return allPass ? 0 : 1;
}
