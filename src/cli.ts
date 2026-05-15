#!/usr/bin/env node
/**
 * CLI entrypoint for rebuild-pipeline.
 *
 *   pipeline rebuild <github-url|local-path> [flags]
 *   pipeline --help
 *
 * Flags (parsed by resolveConfig):
 *   --concurrency <n>        cap on concurrent page-workers (default 8)
 *   --apply-mode <pr|propose>  pr = branch + PR, propose = diffs only (default pr)
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

const HELP = `
rebuild-pipeline — portable SaaS rebuild pipeline (1 mapper + 6-agent fan-out)

USAGE
  pipeline rebuild <github-url|local-path> [flags]
  pipeline --help

FLAGS
  --concurrency <n>           Max concurrent page-workers        (default: 8)
  --apply-mode <pr|propose>   pr: per-run branch + PR
                              propose: write diffs only          (default: pr)
  --brand <path>              Pinned brand spec (JSON). If omitted or not
                              pinned, Stage 0 bootstraps a candidate and the
                              run is non-deterministic — see docs/BRAND_SPEC.md.
  --constraints <path>        Pinned constraints spec for Agent 6 (compliance).
                              Defaults to config/constraints.template.json.
  --scratch <path>            Scratch dir for the clone (deleted on run end).
  --resume <runDir>           Resume an existing run; completed page/agent
                              checkpoints are skipped.

ENV
  GEMINI_API_KEY / GOOGLE_API_KEY   Gemini API key (required).
  PIPELINE_SCRATCH                  Default scratch dir.

EXAMPLES
  pipeline rebuild https://github.com/acme/todo-saas
  pipeline rebuild ./local/project --apply-mode propose --concurrency 4
  pipeline rebuild https://github.com/acme/app --brand config/brand.json
  pipeline rebuild ./project --resume runs/project-2026-05-15T10-00-00-000Z

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

  if (argv[0] !== 'rebuild') {
    console.error(`Unknown command: "${argv[0]}". Expected "rebuild".`);
    console.error(`Run "pipeline --help" for usage.`);
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
    console.error('\n[pipeline] FATAL: ' + message);
    process.exit(1);
  });
