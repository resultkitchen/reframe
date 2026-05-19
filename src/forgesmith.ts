/**
 * ForgeSmith wrapper.
 *
 * A thin, portable entrypoint so ForgeSmith (or any host process) can invoke
 * the rebuild pipeline in-process — no CLI subprocess, no VPS-only paths.
 *
 * It builds the same argv the CLI would receive, hands it to `resolveConfig`
 * (the single source of truth for config parsing), then calls `runPipeline`
 * directly. The returned `RunManifest` is the full result.
 */

import { resolveConfig } from './config';
import { runPipeline } from './orchestrator';
import type { ApplyMode, RunManifest } from './types';

/** Input accepted by the ForgeSmith wrapper. */
export interface ForgesmithRebuildInput {
  /** GitHub URL or local filesystem path of the target project. */
  target: string;
  /** Max concurrent page-workers. */
  concurrency?: number;
  /** 'pr' = branch + PR, 'propose' = diffs only, 'review' = review agents +
   * proposed-changes.md (no code). */
  applyMode?: ApplyMode;
  /** Path to a pinned brand spec. */
  brand?: string;
  /** Path to a pinned constraints spec. */
  constraints?: string;
  /** Path to an auth config — enables auth-aware auditing (implies realEnv). */
  auth?: string;
  /** Preserve the target's real .env.local instead of stubbing integrations. */
  realEnv?: boolean;
  /** Skip destructive browser clicks (implied by realEnv / auth). */
  readOnly?: boolean;
  /** Scratch dir for the clone. */
  scratch?: string;
  /** Resume an existing run directory. */
  resumeRunDir?: string;
}

/**
 * Run the rebuild pipeline in-process and return its manifest.
 *
 * Equivalent to: `pipeline rebuild <target> [flags]`.
 */
export async function forgesmithRebuild(
  input: ForgesmithRebuildInput,
): Promise<RunManifest> {
  if (!input || !input.target) {
    throw new Error('forgesmithRebuild: `target` is required.');
  }

  // Build the same argv shape the CLI passes to resolveConfig:
  //   rebuild <target> [--flag value ...]
  const argv: string[] = ['rebuild', input.target];

  if (input.concurrency !== undefined) {
    argv.push('--concurrency', String(input.concurrency));
  }
  if (input.applyMode) {
    argv.push('--apply-mode', input.applyMode);
  }
  if (input.brand) {
    argv.push('--brand', input.brand);
  }
  if (input.constraints) {
    argv.push('--constraints', input.constraints);
  }
  if (input.auth) {
    argv.push('--auth', input.auth);
  }
  if (input.realEnv) {
    argv.push('--real-env');
  }
  if (input.readOnly) {
    argv.push('--read-only');
  }
  if (input.scratch) {
    argv.push('--scratch', input.scratch);
  }
  if (input.resumeRunDir) {
    argv.push('--resume', input.resumeRunDir);
  }

  const config = await resolveConfig(argv);
  return runPipeline(config);
}

export default forgesmithRebuild;
