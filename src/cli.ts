#!/usr/bin/env node
/**
 * CLI entrypoint for Reframe.
 *
 *   reframe rebuild <github-url|local-path> [flags]
 *   reframe init [target-path]
 *   reframe --help
 *
 * Flags (parsed by resolveConfig):
 *   --concurrency <n>        cap on concurrent page-workers (default 8)
 *   --apply-mode <pr|propose|review>  pr = branch + PR, propose = diffs only,
 *                            review = review agents only + proposed-changes.md
 *   --real-env               preserve the target's real .env.local (no stubs)
 *   --read-only              skip destructive browser clicks (implied by --real-env)
 *   --auth <path>            auth config — audit gated routes logged in
 *   --brand <path>           pinned brand spec (else Stage 0 bootstraps one)
 *   --constraints <path>     pinned constraints spec for Agent 6
 *   --scratch <path>         scratch dir for the clone (else os tmp)
 *   --resume <runDir>        resume an existing run directory
 *
 * Exit code: 0 when every processed page passed, 1 otherwise (or on error).
 */

import { resolveConfig } from './config';
import { runPipeline } from './orchestrator';
import { renderManifestMd } from './manifest';
import { runInitScaffold } from './stages/init-scaffold';

const HELP = `
Reframe — portable SaaS architectural refactoring engine (1 mapper + 6-agent fan-out)

USAGE
  reframe rebuild <github-url|local-path> [flags]
  reframe bootstrap <github-url|local-path> [flags]
  reframe verify <run-dir>
  reframe show-brand <run-dir>
  reframe pin <run-dir> [--out <path>] [--force]
  reframe init [target-path]
  reframe review <run-dir> [<run-dir> ...] [--port <number>]
  reframe mcp
  reframe --help

FLAGS
  --concurrency <n>           Max concurrent page-workers        (default: 8)
  --apply-mode <mode>         pr:      per-run branch + PR        (default)
                              propose: write diffs only
                              review:  run audit/ux/design/compliance on every
                                       screen, skip code+verify, emit one
                                       proposed-changes.md for approval. Resume
                                       with --apply-mode pr to apply.
  --max-pages <n>             Cap pages processed in the fan-out (cost/speed control).
  --routes <list>             Comma-separated route/slug filter. Exact routes
                              (/reports), prefixes (/reports/*), or slugs
                              (reports-builder). Runs after role filtering and
                              before --max-pages.
  --quick-scan                Route per-page review agents to the cheap model tier.
  --params <path>             JSON map of dynamic-route sample values, e.g.
                              { "id": "1", "slug": "demo" } — so /leads/[id] is driven.
  --url-query <qs>            Raw query string appended to every navigated
                              route (Agents 1 & 5 + login), e.g. "preview=1".
                              Lets a target branch into a non-persisting
                              preview path so full workflows can be exercised
                              without writing real data. Leading ?/& tolerated.
  --header <Name: value>      Extra HTTP header set on the browser context, so
                              it rides on every request incl. in-page
                              fetch/XHR. Repeatable. Pairs with --url-query: a
                              header like "x-preview-mode: 1" also tags the API
                              calls a workflow fires, so server-side writes
                              can no-op.
  --base-url <url>            Audit an ALREADY-LIVE deployment at <url> instead
                              of booting the target from source (Stage 0.5
                              skipped). Stage 0 still maps the repo for routes +
                              source context. Audit production with real data
                              and real rendering. Pair with --auth (real
                              accounts) + --read-only / preview headers.
  --shard <index>/<total>     Process only pages where pageIndex % total ==
                              index (0-based). Splits one app across N parallel
                              runs/tasks whose union is full coverage. Applied
                              after role/route filters, before --max-pages.
  --scope <path>              Pin the route map: load a saved scope.json
                              instead of the LLM mapper, so every run + shard
                              audits the identical correct routes. Use when
                              mapping varies run-to-run.
  --real-env                  Preserve the target's real .env.local instead of
                              writing safe stubs — point at a live install.
                              Implies --read-only.
  --read-only                 Browser exercise skips destructive clicks
                              (delete/send/pay/submit/…) — no real mutations.
  --auth <path>               Auth config (JSON): { loginUrl, emailSelector,
                              passwordSelector, submitSelector, postLoginWaitMs,
                              roles[] }. Agents 1 & 5 log in before driving any
                              route matching a role's patterns, so gated pages
                              are audited logged in. Implies --real-env. Use
                              dedicated TEST accounts. See config/auth.template.json.
  --brand <path>              Pinned brand spec (JSON). If omitted or not
                              pinned, Stage 0 bootstraps a candidate and the
                              run is non-deterministic — see docs/BRAND_SPEC.md.
  --constraints <path>        Pinned constraints spec for Agent 6 (compliance).
                              Defaults to config/constraints.template.json.
  --scratch <path>            Scratch dir for the clone (deleted on run end).
  --resume <runDir>           Resume an existing run; completed page/agent
                              checkpoints are skipped.
  --diff-only                 Scope the per-page fan-out to source files
                              changed on this branch (vs --diff-base). Stage 0
                              still maps the whole app; agents only run on
                              pages whose source file is in the diff. The
                              power-user flag — kills audit time on big repos.
  --diff-base <ref>           Git ref to diff against when --diff-only is set.
                              Defaults to origin/main → origin/master → main.
  --bootstrap-only            Run Stage 0 only: map the app, derive a brand
                              candidate, write it to <runDir>/brand.candidate.json,
                              and exit. No boot, no agents. Used by the
                              \`reframe bootstrap\` subcommand.
  --post-findings             In --apply-mode pr, also post the top-3
                              plain-English findings as a PR conversation
                              comment after opening the PR. GitHub sends
                              notifications for comments but not for body
                              edits — so this is the wake-up signal that
                              actually reaches subscribed reviewers.
                              Off by default to avoid surprising repos.
  --json-summary              After the human-readable output, print a
                              single-line JSON summary on stdout. The line
                              is always last, so \`tail -n 1 | jq\` works
                              cleanly. Designed for CI pipes — see
                              .github/workflows/reframe-pr-template.yml.

SUBCOMMANDS

  bootstrap <target>          Shortcut for --bootstrap-only. Maps the app and
                              produces a brand candidate you can review + pin
                              before committing to a full audit run. The
                              friction-free first run for any new project.

  show-brand <run-dir>        Pretty-print the bootstrapped brand candidate
                              (or the resolved brand) from a completed run
                              dir. Useful right after \`reframe bootstrap\`
                              to inspect what the engine inferred before
                              firing up the review UI.

  pin <run-dir>               Write the bootstrapped brand from a completed
    [--out <path>] [--force]  run to config/brand.json (or --out <path>)
                              with pinned:true. Non-interactive equivalent
                              of the y/N prompt \`reframe bootstrap\` shows
                              when stdin is a TTY — use this from CI /
                              shell scripts. Refuses to overwrite an
                              existing pinned brand unless --force is set.

  verify <run-dir>            Re-run only Agent 5 (verify) against an
    [--page <slug>]           existing run. Loads the target out of the
                              run's manifest.json, clears verify
                              checkpoint state, and re-runs verify against
                              the on-disk audit results. The tight dev
                              loop: fix a finding by hand, verify in
                              seconds without re-running the full pipeline.
                              With --page, scopes to a single screen
                              (the tightest loop). Always --apply-mode
                              propose (verify is read-only). Exits 0
                              when every targeted page verifies.

  mcp                         Spawns the Model Context Protocol (MCP) server
                              over stdin/stdout. Integrates Reframe directly
                              with AI coding assistants like gemini-cli,
                              Claude Code, or Cursor.

ENV
  GEMINI_API_KEY / GOOGLE_API_KEY   Gemini API key (required for Gemini runs).
  PIPELINE_SCRATCH                  Default scratch dir.

EXAMPLES
  reframe init ./my-new-saas
  reframe bootstrap ./my-new-saas                  # see what Reframe sees, fast
  reframe review ./runs/casesdaily-2026-05-25T15-29-40Z
  reframe rebuild https://github.com/acme/todo-saas
  reframe rebuild https://github.com/acme/todo-saas --max-pages 10 --quick-scan
  reframe rebuild ./project --routes /reports,/reports/builder,/google-ads --apply-mode review
  reframe rebuild ./local/project --apply-mode propose --concurrency 4
  reframe rebuild ./project --resume runs/project-2026-05-15T10-00-00-000Z

  # Per-PR audit: only the screens whose source files this branch touches.
  reframe rebuild ./project --diff-only
  reframe rebuild ./project --diff-only --diff-base origin/develop

  # Two-pass review gate against a live install, gated screens included:
  reframe rebuild ./project --apply-mode review --auth config/myapp-auth.json
  #   ...review runs/project-<stamp>/proposed-changes.md, then:
  reframe rebuild ./project --resume runs/project-<stamp> --apply-mode pr

EXIT CODES
  0  every processed page passed verification
  1  one or more pages failed, or the run errored
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Help — explicit flag, no args, or a bare `help` subcommand.
  if (
    argv.length === 0 ||
    argv.includes('--help') ||
    argv.includes('-h') ||
    argv[0] === 'help'
  ) {
    console.log(HELP);
    return argv.length === 0 ? 1 : 0;
  }

  // --json-summary: any subcommand that consumes it gets a single-line JSON
  // summary printed to stdout at the end, AFTER the human-readable output.
  // CI scripts can `tail -n 1 | jq` it to branch on outcome without parsing
  // markdown. Flag is removed from argv before delegating to the subcommand.
  const wantsJsonSummary = argv.includes('--json-summary');
  const subcommandArgv = wantsJsonSummary
    ? argv.filter((a) => a !== '--json-summary')
    : argv;

  // Handle 'mcp' command.
  if (subcommandArgv[0] === 'mcp') {
    const { startMcpServer } = await import('./mcp');
    await startMcpServer();
    return 0;
  }

  // Handle 'init' command.
  if (subcommandArgv[0] === 'init') {
    await runInitScaffold(subcommandArgv[1]);
    return 0;
  }

  // Handle 'review' command.
  // Accepts one or more positional run-dir args (multi-run mode merges them
  // into a single SPA — page slugs must be disjoint across runs, which is
  // the natural shape when each run was scoped by --only-roles).
  if (subcommandArgv[0] === 'review') {
    let port = 3000;
    const portIndex = subcommandArgv.indexOf('--port');
    if (portIndex !== -1 && subcommandArgv[portIndex + 1]) {
      port = parseInt(subcommandArgv[portIndex + 1], 10) || 3000;
    }
    const runDirs = subcommandArgv.slice(1).filter((tok, i, arr) => {
      if (tok.startsWith('--')) return false;
      if (i > 0 && arr[i - 1] === '--port') return false;
      return true;
    });
    if (runDirs.length === 0) {
      console.error('Error: "review" command requires at least one target run directory.');
      console.error('Usage: reframe review <run-dir> [<run-dir> ...] [--port <number>]');
      return 1;
    }

    const { startReviewServer } = await import('./server');
    await startReviewServer(runDirs, port);
    await new Promise(() => {}); // Keep server running
    return 0;
  }

  // Handle 'show-brand' command — pretty-print the bootstrapped brand
  // candidate from a completed run dir. Useful right after `reframe
  // bootstrap` to inspect what the engine inferred without firing up
  // the review UI.
  if (subcommandArgv[0] === 'show-brand') {
    const runDir = subcommandArgv[1];
    if (!runDir) {
      console.error('Error: "show-brand" command requires a target run directory.');
      console.error('Usage: reframe show-brand <run-dir>');
      return 1;
    }
    const { showBrand } = await import('./show-brand');
    return showBrand(runDir);
  }

  // Handle 'pin' command — non-interactive equivalent of the prompt the
  // `bootstrap` subcommand shows when stdin is a TTY. Same write
  // semantics; works in CI / shell scripts where the interactive path
  // would hang or be silently skipped.
  if (subcommandArgv[0] === 'pin') {
    const { runPin } = await import('./pin');
    return runPin(subcommandArgv.slice(1));
  }

  // Handle 'verify' command — re-run only Agent 5 against an existing
  // run dir. Reads the target out of the run's manifest.json, clears
  // verify checkpoint state so resume picks it back up, then delegates
  // to runPipeline with --verify-only + --apply-mode propose (no
  // commit, no PR — verify is read-only).
  if (subcommandArgv[0] === 'verify') {
    const runDir = subcommandArgv[1];
    if (!runDir) {
      console.error('Error: "verify" command requires a target run directory.');
      console.error('Usage: reframe verify <run-dir>');
      return 1;
    }
    const { runVerifyOnly } = await import('./verify');
    return runVerifyOnly(runDir, subcommandArgv.slice(2));
  }

  // Handle 'bootstrap' command — thin alias for `rebuild <target> --bootstrap-only`.
  // Keeps the verb explicit in the docs and on the user's shell history.
  if (subcommandArgv[0] === 'bootstrap') {
    const target = subcommandArgv[1];
    if (!target) {
      console.error('Error: "bootstrap" command requires a target.');
      console.error('Usage: reframe bootstrap <github-url|local-path> [flags]');
      return 1;
    }
    // Rebuild the argv as if the user had typed `rebuild <target> --bootstrap-only ...`.
    const rebuiltArgs = ['rebuild', target, ...subcommandArgv.slice(2)];
    if (!rebuiltArgs.includes('--bootstrap-only')) rebuiltArgs.push('--bootstrap-only');
    const config = await resolveConfig(rebuiltArgs);
    const manifest = await runPipeline(config);
    if (wantsJsonSummary) {
      printJsonSummary(manifest, 0);
    }
    return 0;
  }

  if (subcommandArgv[0] !== 'rebuild') {
    console.error(`Unknown command: "${subcommandArgv[0]}". Expected "rebuild", "bootstrap", "verify", "pin", "init", "review", or "show-brand".`);
    console.error(`Run "reframe --help" for usage.`);
    return 1;
  }

  // resolveConfig parses the full argv (it expects `rebuild <target> ...`).
  const config = await resolveConfig(subcommandArgv);
  const manifest = await runPipeline(config);

  // Human-readable summary to stdout.
  console.log('\n' + renderManifestMd(manifest));

  // All-pages-pass: a run with zero pages is NOT a pass.
  const allPagesPass =
    manifest.pagesProcessed.length > 0 &&
    manifest.pagesProcessed.every((p) => p.pass);

  const exitCode = allPagesPass ? 0 : 1;
  if (wantsJsonSummary) {
    printJsonSummary(manifest, exitCode);
  }
  return exitCode;
}

/**
 * Print a single-line JSON summary to stdout — the CI-friendly form.
 *
 * Always the LAST line printed so `tail -n 1` works without parsing the
 * rest of the output. Fields are deliberately stable (don't reorder /
 * remove without a major-version bump) so downstream scripts can rely
 * on the contract.
 */
function printJsonSummary(
  manifest: Awaited<ReturnType<typeof runPipeline>>,
  exitCode: number,
): void {
  const summary = {
    schemaVersion: 1,
    project: manifest.project,
    target: manifest.target,
    runDir: manifest.project, // included by callers; project slug here for reference
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    wallClockMs: manifest.wallClockMs,
    bootStatus: manifest.bootStatus,
    applyMode: manifest.applyMode,
    prUrl: manifest.prUrl,
    pagesProcessed: manifest.pagesProcessed.length,
    pagesPassing: manifest.pagesProcessed.filter((p) => p.pass).length,
    gapsFound: manifest.pagesProcessed.reduce((n, p) => n + p.gapsFound, 0),
    gapsClosed: manifest.pagesProcessed.reduce((n, p) => n + p.gapsClosed, 0),
    complianceFindings: manifest.pagesProcessed.reduce((n, p) => n + p.complianceFindings, 0),
    alertCount: manifest.alerts.length,
    scratchCleaned: manifest.scratchCleaned,
    exitCode,
  };
  // process.stdout.write avoids the trailing newline console.log adds, so
  // `tail -n 1` always lands on this exact line even if the previous
  // output didn't end with one.
  process.stdout.write('\n' + JSON.stringify(summary) + '\n');
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('\n[reframe] FATAL: ' + message);
    process.exit(1);
  });
