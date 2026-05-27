/**
 * `reframe pin <runDir> [--out <path>]` — write the bootstrapped brand
 * from a completed run to config/brand.json with `pinned: true`, so the
 * next audit run treats it as the deterministic source of truth.
 *
 * Mirrors the interactive prompt `reframe bootstrap` shows when stdin is
 * a TTY — but works in CI, in non-TTY shells, in shell scripts, anywhere
 * the interactive path would hang or be skipped. Same write semantics:
 * creates the parent dir if missing, refuses to overwrite an existing
 * pinned brand unless `--force` is set.
 *
 * Reads brand.candidate.json first (the file `reframe bootstrap` writes),
 * falls back to brand.resolved.json (the file every full run writes via
 * resolveBrand).
 *
 * Exits 0 on success, 1 on any failure (with a printed reason on stderr).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrandSpec } from './types';

interface PinOptions {
  runDir: string;
  /** Destination path for the pinned brand. Default: cwd/config/brand.json. */
  out?: string;
  /** When true, overwrite an existing pinned brand at `out`. */
  force: boolean;
}

/**
 * Parse the args slice after the `pin` subcommand. Accepts:
 *   <runDir> [--out <path>] [--force]
 */
function parsePinArgs(argv: string[]): PinOptions | string {
  const out: Partial<PinOptions> = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--out') {
      const v = argv[i + 1];
      if (!v) return 'Error: --out requires a path argument.';
      out.out = v;
      i++;
    } else if (tok === '--force') {
      out.force = true;
    } else if (tok.startsWith('--')) {
      return `Error: unknown flag "${tok}" for the pin subcommand.`;
    } else if (!out.runDir) {
      out.runDir = tok;
    } else {
      return `Error: unexpected positional argument "${tok}".`;
    }
  }
  if (!out.runDir) return 'Error: "pin" command requires a target run directory.';
  return { runDir: out.runDir, out: out.out, force: out.force ?? false };
}

/**
 * Locate the brand to pin. Returns null when neither candidate file
 * exists or both are unparseable.
 */
function loadBrandFromRunDir(runDir: string): { brand: BrandSpec; source: string } | null {
  const candidates = [
    path.join(runDir, 'brand.candidate.json'),
    path.join(runDir, 'brand.resolved.json'),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as BrandSpec;
      return { brand: parsed, source: filePath };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function runPin(argv: string[]): number {
  const parsed = parsePinArgs(argv);
  if (typeof parsed === 'string') {
    console.error(parsed);
    console.error('Usage: reframe pin <run-dir> [--out <path>] [--force]');
    return 1;
  }

  const absRunDir = path.resolve(parsed.runDir);
  if (!fs.existsSync(absRunDir)) {
    console.error(`Error: run directory does not exist: ${absRunDir}`);
    return 1;
  }

  const loaded = loadBrandFromRunDir(absRunDir);
  if (!loaded) {
    console.error(
      `Error: no brand file found in ${absRunDir}.\n` +
        `Looked for brand.candidate.json (written by 'reframe bootstrap') and ` +
        `brand.resolved.json (written by every full run).`,
    );
    return 1;
  }

  // Default destination: cwd/config/brand.json. The bootstrap subcommand's
  // interactive path also uses this — keeps the two flows in sync.
  const outPath = parsed.out
    ? path.resolve(parsed.out)
    : path.join(process.cwd(), 'config', 'brand.json');

  if (fs.existsSync(outPath) && !parsed.force) {
    try {
      const existingRaw = fs.readFileSync(outPath, 'utf8');
      const existing = JSON.parse(existingRaw) as BrandSpec;
      if (existing.pinned) {
        console.error(
          `Error: ${outPath} already exists with pinned:true.\n` +
            `Pass --force to overwrite, or pin to a different path with --out <path>.`,
        );
        return 1;
      }
    } catch {
      // Existing file is not a valid BrandSpec — treat the same as --force,
      // since we'd be replacing garbage anyway. Print a heads-up.
      console.error(
        `Note: ${outPath} exists but is not valid brand JSON. Overwriting.`,
      );
    }
  }

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const pinned: BrandSpec = { ...loaded.brand, pinned: true };
    fs.writeFileSync(outPath, JSON.stringify(pinned, null, 2), 'utf8');
  } catch (err) {
    console.error(
      `Error: failed to write ${outPath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }

  console.log(`[reframe] ✓ pinned brand from ${loaded.source}`);
  console.log(`[reframe]   → ${outPath}`);
  console.log(`[reframe]   re-run with:  reframe rebuild <target> --brand ${outPath}`);
  return 0;
}
