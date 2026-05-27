/**
 * `reframe show-brand <runDir>` — pretty-print the bootstrapped brand
 * candidate produced by `reframe bootstrap` (or by any run's Stage 0).
 *
 * Reads `<runDir>/brand.candidate.json` if it exists (the file the
 * bootstrap subcommand writes); otherwise falls back to
 * `<runDir>/brand.resolved.json` (what every run writes via resolveBrand).
 * Prints a readable summary plus the next-step instructions to pin it.
 *
 * Exits 0 on success, 1 when neither file exists or is unreadable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrandSpec } from './types';

/** Load the brand from the most-discoverable file in the run dir. */
function loadBrandFromRunDir(runDir: string): { brand: BrandSpec | null; source: string } {
  const candidates = [
    { name: 'brand.candidate.json', path: path.join(runDir, 'brand.candidate.json') },
    { name: 'brand.resolved.json',  path: path.join(runDir, 'brand.resolved.json') },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    try {
      const raw = fs.readFileSync(c.path, 'utf8');
      const parsed = JSON.parse(raw) as BrandSpec;
      return { brand: parsed, source: c.name };
    } catch {
      /* try the next candidate */
    }
  }
  return { brand: null, source: '' };
}

/** Render a colored-ish terminal pretty-print of the brand. */
function renderBrand(brand: BrandSpec, source: string, runDir: string): string {
  const lines: string[] = [];
  const rule = '─────────────────────────────────────────────────────────────────';

  lines.push('');
  lines.push(rule);
  lines.push(`  BRAND CANDIDATE  (${brand.pinned ? 'PINNED ✓' : 'UNPINNED — review before use'})`);
  lines.push(`  Source: ${path.join(runDir, source)}`);
  lines.push(rule);
  lines.push('');
  lines.push(`  Name:           ${brand.name}`);
  lines.push(`  Voice:          ${brand.voice || '(empty)'}`);
  lines.push(`  Component:      ${brand.componentStyle || '(empty)'}`);
  lines.push('');

  const renderTokenMap = (label: string, map: Record<string, string> | undefined): void => {
    const entries = Object.entries(map ?? {});
    if (entries.length === 0) {
      lines.push(`  ${label.padEnd(14)} (none)`);
      return;
    }
    lines.push(`  ${label.padEnd(14)} ${entries.length} token(s)`);
    // Indent the actual tokens under the label.
    for (const [k, v] of entries.slice(0, 24)) {
      lines.push(`    ${k.padEnd(20)} ${v}`);
    }
    if (entries.length > 24) {
      lines.push(`    ...and ${entries.length - 24} more`);
    }
  };

  renderTokenMap('Colors:',    brand.colors);
  renderTokenMap('Type scale:', brand.typeScale);
  renderTokenMap('Spacing:',    brand.spacing);
  renderTokenMap('Radii:',      brand.radii ?? {});

  lines.push('');
  lines.push(rule);
  if (!brand.pinned) {
    lines.push('  TO PIN THIS BRAND:');
    lines.push(`    1. Copy:  cp ${path.join(runDir, source)} config/brand.json`);
    lines.push(`    2. Edit config/brand.json and set  "pinned": true`);
    lines.push(`    3. Re-run with --brand config/brand.json for a deterministic audit.`);
  } else {
    lines.push('  This brand is already pinned. Agent 3 will use it deterministically.');
  }
  lines.push(rule);
  lines.push('');

  return lines.join('\n');
}

export function showBrand(runDir: string): number {
  const absRunDir = path.resolve(runDir);
  if (!fs.existsSync(absRunDir)) {
    console.error(`Error: run directory does not exist: ${absRunDir}`);
    return 1;
  }
  const { brand, source } = loadBrandFromRunDir(absRunDir);
  if (!brand) {
    console.error(
      `Error: no brand file found in ${absRunDir}.\n` +
        `Looked for brand.candidate.json (written by 'reframe bootstrap') and ` +
        `brand.resolved.json (written by every full run). Run one of:\n` +
        `  reframe bootstrap <target>\n` +
        `  reframe rebuild   <target>`,
    );
    return 1;
  }
  console.log(renderBrand(brand, source, absRunDir));
  return 0;
}
