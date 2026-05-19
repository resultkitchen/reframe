/**
 * Scratch directory lifecycle + disk guard.
 *
 * The scratch dir holds the working copy (a clone, or a COPY of a local-path
 * target so the original is never mutated). It is deleted on run end — success
 * or failure — and `cleanupScratch` is safe to call from any failure path.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cloneRepo } from './git';
import type { PipelineConfig } from './types';

/** Directory names never copied from a local-path target. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.cache',
  'coverage',
  '.vercel',
  '.netlify',
]);

/** Recursively copy `src` → `dest`, skipping heavy/derived directories. */
function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      try {
        const linkTarget = fs.readlinkSync(srcPath);
        fs.symlinkSync(linkTarget, destPath);
      } catch {
        // Ignore unreproducible symlinks.
      }
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Best-effort delete of leftover scratch dirs from earlier runs of this
 * project (`rebuild-<slug>` and `rebuild-<slug>-<stamp>` siblings). A run that
 * could not clean up — a Windows file lock the dev server left behind —
 * leaves one behind; it has usually freed up by the next run. Never throws,
 * never touches the current run's own scratch dir.
 *
 * Skipped entirely when scratchDir is not a default run-scoped path (i.e. the
 * operator passed an explicit --scratch / PIPELINE_SCRATCH).
 */
function sweepStaleScratch(config: PipelineConfig): void {
  try {
    const parent = path.dirname(config.scratchDir);
    const self = path.basename(config.scratchDir);
    const exact = `rebuild-${config.projectSlug}`;
    const prefix = `${exact}-`;
    // Only sweep when our own scratch is a default run-scoped dir.
    if (!self.startsWith(prefix)) return;

    for (const name of fs.readdirSync(parent)) {
      if (name === self) continue;
      if (name !== exact && !name.startsWith(prefix)) continue;
      try {
        fs.rmSync(path.join(parent, name), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 300,
        });
      } catch {
        // Still locked — leave it; a later run will retry. Not fatal.
      }
    }
  } catch {
    // readdir failed (parent missing, etc.) — nothing to sweep.
  }
}

/**
 * Prepare the scratch directory + working copy.
 *
 * - Local-path target → copy the project into `config.workDir`.
 * - Remote target     → clone the repo into `config.workDir`.
 *
 * Throws if disk space is insufficient.
 */
export async function prepareScratch(config: PipelineConfig): Promise<void> {
  fs.mkdirSync(config.scratchDir, { recursive: true });

  const disk = await checkDisk(config.scratchDir);
  if (!disk.ok) {
    throw new Error(
      `Insufficient disk space in scratch dir "${config.scratchDir}": ` +
        `${disk.freeMb} MB free (need > 2000 MB)`,
    );
  }

  // Clear leftover scratch dirs from prior runs (best-effort).
  sweepStaleScratch(config);

  // Fresh working copy. With a unique-per-run scratch dir workDir normally
  // does not exist; tolerate (retry, then fail with a clear message) a locked
  // leftover rather than crashing with a raw EPERM.
  if (fs.existsSync(config.workDir)) {
    try {
      fs.rmSync(config.workDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300,
      });
    } catch (err) {
      throw new Error(
        `scratch work dir "${config.workDir}" exists and could not be ` +
          `cleared (locked): ${err instanceof Error ? err.message : String(err)}. ` +
          `Pass --scratch <fresh-path> or remove it manually.`,
      );
    }
  }

  if (config.isLocalPath) {
    const original = path.resolve(config.target);
    copyTree(original, config.workDir);
  } else {
    await cloneRepo(config.target, config.workDir);
  }
}

/**
 * Remove the scratch directory. Returns true on success. Safe to call from
 * failure paths. NEVER removes a local-path target — it only ever deletes
 * `config.scratchDir`.
 */
export async function cleanupScratch(
  config: PipelineConfig,
): Promise<boolean> {
  try {
    // Defensive: even for a local target, the original lives OUTSIDE
    // scratchDir, so removing scratchDir can never touch it. Still, guard
    // against a misconfigured scratchDir that equals/contains the original.
    if (config.isLocalPath) {
      const original = path.resolve(config.target);
      const scratch = path.resolve(config.scratchDir);
      const rel = path.relative(scratch, original);
      const originalInsideScratch =
        rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (originalInsideScratch) {
        // eslint-disable-next-line no-console
        console.error(
          `[scratch] refusing cleanup: original target "${original}" is ` +
            `inside scratch dir "${scratch}"`,
        );
        return false;
      }
    }

    // Windows releases file handles asynchronously after a process exits, so
    // a freshly-killed dev server can briefly keep the dir locked. Retry.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        if (fs.existsSync(config.scratchDir)) {
          fs.rmSync(config.scratchDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 400,
          });
        }
        return true;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    throw lastErr;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[scratch] cleanup of "${config.scratchDir}" failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}

/* ─────────────────────────── disk guard ─────────────────────────── */

/** Run a command, resolve stdout (empty string on failure). */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout?.toString() ?? ''));
    });
  });
}

/**
 * Report free space (MB) for the volume containing `scratchDir`.
 * `ok` is true when freeMb > 2000.
 *
 * Strategy: prefer node:fs `statfs` (Node 18.15+); fall back to platform
 * tooling (`wmic` on Windows, `df` on POSIX).
 */
export async function checkDisk(
  scratchDir: string,
): Promise<{ freeMb: number; ok: boolean }> {
  // Ensure the path exists so statfs/df can resolve its volume.
  const probe = fs.existsSync(scratchDir)
    ? scratchDir
    : path.dirname(scratchDir);

  // 1) node:fs statfs (cross-platform, Node 18.15+).
  const statfs = (
    fs as unknown as {
      statfs?: (
        p: string,
        cb: (
          err: NodeJS.ErrnoException | null,
          stats?: { bavail: bigint | number; bsize: bigint | number },
        ) => void,
      ) => void;
    }
  ).statfs;

  if (typeof statfs === 'function') {
    const viaStatfs = await new Promise<number | null>((resolve) => {
      statfs(probe, (err, stats) => {
        if (err || !stats) {
          resolve(null);
          return;
        }
        const bavail = Number(stats.bavail);
        const bsize = Number(stats.bsize);
        if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) {
          resolve(null);
          return;
        }
        resolve((bavail * bsize) / (1024 * 1024));
      });
    });
    if (viaStatfs !== null) {
      const freeMb = Math.floor(viaStatfs);
      return { freeMb, ok: freeMb > 2000 };
    }
  }

  // 2) Platform fallback.
  let freeMb = 0;
  if (process.platform === 'win32') {
    // Determine the drive letter for the probe path.
    const drive = (path.parse(path.resolve(probe)).root || 'C:\\')
      .replace(/\\$/, '')
      .toUpperCase();
    const out = await run('wmic', [
      'logicaldisk',
      'where',
      `DeviceID='${drive}'`,
      'get',
      'FreeSpace',
      '/value',
    ]);
    const match = out.match(/FreeSpace=(\d+)/i);
    if (match) {
      freeMb = Math.floor(Number(match[1]) / (1024 * 1024));
    }
  } else {
    // `df -k` reports 1K blocks; column 4 is available.
    const out = await run('df', ['-k', probe]);
    const lines = out.trim().split(/\r?\n/);
    if (lines.length >= 2) {
      const cols = lines[lines.length - 1].trim().split(/\s+/);
      const availKb = Number(cols[3]);
      if (Number.isFinite(availKb)) {
        freeMb = Math.floor(availKb / 1024);
      }
    }
  }

  return { freeMb, ok: freeMb > 2000 };
}
