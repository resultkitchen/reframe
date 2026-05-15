/**
 * Git operations — clone, per-run branch, commit, diff, and PR creation.
 *
 * Clone/branch/commit/diff use `simple-git`. `openPr` shells out to the `gh`
 * CLI; with no GitHub remote it returns ''.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

/** True when `dir` is (inside) a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  try {
    const git = simpleGit(dir);
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/**
 * Clone `url` into `destDir`. The parent of `destDir` is created if needed.
 *
 * Tries `git clone` first; on failure (private repo, proxied network, a
 * transient connectivity blip) falls back to `gh repo clone`, which is
 * authenticated and proxy-aware. A plain `git` failure is retried once.
 */
export async function cloneRepo(url: string, destDir: string): Promise<void> {
  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });

  let gitErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await simpleGit().clone(url, destDir);
      return;
    } catch (err) {
      gitErr = err;
      // Clear a partial clone before retry / fallback.
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // Fallback: gh repo clone (uses the gh token + gh's network stack).
  const gh = await runGh(['repo', 'clone', url, destDir], parent);
  if (gh.code === 0) {
    return;
  }
  throw new Error(
    `clone failed via git (${gitErr instanceof Error ? gitErr.message : String(gitErr)}) ` +
      `and via gh (${gh.stderr.trim() || `exit ${gh.code}`})`,
  );
}

/**
 * Create + checkout a fresh branch in `workDir`. If `workDir` is not a git
 * repo (e.g. a plain local-path target), a baseline repo is bootstrapped
 * first so the run has a base to branch from and to diff against.
 */
export async function createRunBranch(
  workDir: string,
  branch: string,
): Promise<void> {
  const git: SimpleGit = simpleGit(workDir);
  const isRepo = await git.checkIsRepo().catch(() => false);

  if (!isRepo) {
    await git.init();
    // Keep dependency/build dirs out of the baseline snapshot — use the repo's
    // local exclude file so the target's own files are never modified.
    try {
      const exclude = path.join(workDir, '.git', 'info', 'exclude');
      fs.appendFileSync(
        exclude,
        '\nnode_modules/\ndist/\n.next/\nbuild/\n.turbo/\n',
      );
    } catch {
      /* best-effort */
    }
    // A commit needs an identity; set it locally (no global config required).
    await git.addConfig('user.email', 'pipeline@rebuild.local');
    await git.addConfig('user.name', 'rebuild-pipeline');
    await git.add(['-A']);
    await git.commit('chore: rebuild-pipeline baseline snapshot');
  }

  await git.checkoutLocalBranch(branch);
}

/** Stage every change in `workDir` and commit with `message`. */
export async function commitAll(
  workDir: string,
  message: string,
): Promise<void> {
  const git: SimpleGit = simpleGit(workDir);
  await git.add(['-A']);

  // Nothing staged → skip (commit would otherwise fail).
  const status = await git.status();
  if (status.staged.length === 0 && status.created.length === 0) {
    return;
  }

  await git.commit(message);
}

/**
 * Unified diff for `workDir`. With `fromRef`, diffs `fromRef..HEAD` plus the
 * working tree; without it, diffs the working tree (uncommitted changes).
 */
export async function getDiff(
  workDir: string,
  fromRef?: string,
): Promise<string> {
  const git: SimpleGit = simpleGit(workDir);
  if (fromRef) {
    return git.diff([fromRef]);
  }
  // Include staged + unstaged changes.
  return git.diff(['HEAD']);
}

/* ─────────────────────────── PR via gh CLI ─────────────────────────── */

/** Run `gh` with args in `cwd`; resolve { stdout, code }. */
function runGh(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          code,
        });
      },
    );
  });
}

/** True when `workDir` has at least one remote pointing at github.com. */
async function hasGitHubRemote(workDir: string): Promise<boolean> {
  try {
    const git: SimpleGit = simpleGit(workDir);
    const remotes = await git.getRemotes(true);
    return remotes.some((r) => {
      const urls = [r.refs?.fetch, r.refs?.push].filter(Boolean) as string[];
      return urls.some((u) => /github\.com/i.test(u));
    });
  } catch {
    return false;
  }
}

/**
 * Push `branch` and open a PR via the `gh` CLI. Returns the PR URL, or `''`
 * when there is no GitHub remote (PR not possible).
 */
export async function openPr(
  workDir: string,
  branch: string,
  title: string,
  body: string,
): Promise<string> {
  if (!(await hasGitHubRemote(workDir))) {
    return '';
  }

  // Push the branch (best-effort; gh pr create can also push).
  try {
    const git: SimpleGit = simpleGit(workDir);
    await git.push(['-u', 'origin', branch]);
  } catch (err) {
    // Non-fatal — gh pr create may still succeed if the branch is pushed.
    // eslint-disable-next-line no-console
    console.error(
      `[git] push of branch "${branch}" failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const result = await runGh(
    [
      'pr',
      'create',
      '--head',
      branch,
      '--title',
      title,
      '--body',
      body,
    ],
    workDir,
  );

  if (result.code !== 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[git] gh pr create failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
    return '';
  }

  // gh prints the PR URL on stdout.
  const url = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return /^https?:\/\//i.test(url) ? url : '';
}
