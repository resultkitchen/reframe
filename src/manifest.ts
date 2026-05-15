/**
 * RunManifest read/write.
 *
 * `writeManifest` emits both `manifest.json` (machine) and `manifest.md`
 * (human-readable summary: project, wall-clock, per-page pass/fail, test
 * users, alerts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RunManifest } from './types';

/** Format a millisecond duration as `Hh Mm Ss`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/** Escape pipe characters so cell text never breaks a markdown table. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Render a clean human-readable markdown summary of a run manifest.
 */
export function renderManifestMd(manifest: RunManifest): string {
  const lines: string[] = [];

  lines.push(`# Rebuild Manifest — ${manifest.project}`);
  lines.push('');
  lines.push(`- **Target**: ${manifest.target}`);
  lines.push(`- **Started**: ${manifest.startedAt}`);
  lines.push(`- **Finished**: ${manifest.finishedAt}`);
  lines.push(`- **Wall clock**: ${formatDuration(manifest.wallClockMs)}`);
  lines.push(`- **Boot status**: ${manifest.bootStatus}`);
  lines.push(`- **Apply mode**: ${manifest.applyMode}`);
  if (manifest.prUrl) {
    lines.push(`- **Pull request**: ${manifest.prUrl}`);
  }
  lines.push(
    `- **Scratch cleaned**: ${manifest.scratchCleaned ? 'yes' : 'NO'}`,
  );
  lines.push('');

  // Per-page pass/fail table.
  lines.push('## Pages');
  lines.push('');
  if (manifest.pagesProcessed.length === 0) {
    lines.push('_No pages processed._');
  } else {
    const passCount = manifest.pagesProcessed.filter((p) => p.pass).length;
    lines.push(
      `${passCount} / ${manifest.pagesProcessed.length} pages passed.`,
    );
    lines.push('');
    lines.push(
      '| Page | Route | Result | Agents | Gaps found | Gaps closed | Compliance findings |',
    );
    lines.push(
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const p of manifest.pagesProcessed) {
      lines.push(
        `| ${cell(p.slug)} | ${cell(p.route)} | ${
          p.pass ? 'PASS' : 'FAIL'
        } | ${cell(p.agentsRun.join(', '))} | ${p.gapsFound} | ${
          p.gapsClosed
        } | ${p.complianceFindings} |`,
      );
    }
  }
  lines.push('');

  // Test users.
  lines.push('## Test Users');
  lines.push('');
  if (manifest.testUsers.length === 0) {
    lines.push('_No test users seeded._');
  } else {
    lines.push('| Role | Email | Password | Login URL | Test script |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const u of manifest.testUsers) {
      lines.push(
        `| ${cell(u.role)} | ${cell(u.email)} | ${cell(u.password)} | ${cell(
          u.loginUrl,
        )} | ${cell(u.scriptPath)} |`,
      );
    }
  }
  lines.push('');

  // Alerts.
  lines.push('## Alerts');
  lines.push('');
  if (manifest.alerts.length === 0) {
    lines.push('_No alerts — run completed without timeouts or failures._');
  } else {
    for (const a of manifest.alerts) {
      lines.push(`- ${cell(a)}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Write `runDir/manifest.json` and `runDir/manifest.md`.
 */
export function writeManifest(runDir: string, manifest: RunManifest): void {
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(runDir, 'manifest.md'),
    renderManifestMd(manifest),
    'utf8',
  );
}
