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
  reframe init [target-path]
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
  --quick-scan                Route per-page review agents to the cheap model tier.
  --params <path>             JSON map of dynamic-route sample values, e.g.
                              { "id": "1", "slug": "demo" } — so /leads/[id] is driven.
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

ENV
  GEMINI_API_KEY / GOOGLE_API_KEY   Gemini API key (required for Gemini runs).
  PIPELINE_SCRATCH                  Default scratch dir.

EXAMPLES
  reframe init ./my-new-saas
  reframe rebuild https://github.com/acme/todo-saas
  reframe rebuild https://github.com/acme/todo-saas --max-pages 10 --quick-scan
  reframe rebuild ./local/project --apply-mode propose --concurrency 4
  reframe rebuild ./project --resume runs/project-2026-05-15T10-00-00-000Z

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

  // Handle 'init' command.
  if (argv[0] === 'init') {
    await runInitScaffold(argv[1]);
    return 0;
  }

  if (argv[0] !== 'rebuild') {
    console.error(`Unknown command: "${argv[0]}". Expected "rebuild" or "init".`);
    console.error(`Run "reframe --help" for usage.`);
    return 1;
  }

  // resolveConfig parses the full argv (it expects `rebuild <target> ...`).
  const config = await resolveConfig(argv);
  const manifest = await runPipeline(config);

  // Human-readable summary to stdout.
  console.log('\n' + renderManifestMd(manifest));

  // All-pages-pass: a run with zero pages is NOT a pass.
  const allPagesPass =
    manifest.pagesProcessed.length > 0 &&
    manifest.pagesProcessed.every((p) => p.pass);

  return allPagesPass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('\n[reframe] FATAL: ' + message);
    process.exit(1);
  });
