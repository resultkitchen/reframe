/**
 * Consolidated proposed-changes report for `--apply-mode review`.
 *
 * The review pass runs only the four review agents (audit, ux, design,
 * compliance) on every page and writes NO code. This module aggregates every
 * page's per-agent JSON artifacts into a single `runDir/proposed-changes.md`
 * for human approval — the gate before an apply pass.
 *
 * After approval, the operator runs the apply pass:
 *   rebuild <target> --resume <runDir> --apply-mode pr
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AuditResult,
  ComplianceResult,
  DesignSpec,
  PipelineConfig,
  ScopeDoc,
  Severity,
  UxProposal,
} from './types';

/** Read + parse a JSON artifact; returns null when missing or unparseable. */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Rank used to surface the worst severity present on a page. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

interface PageReview {
  slug: string;
  route: string;
  audit: AuditResult | null;
  ux: UxProposal | null;
  design: DesignSpec | null;
  compliance: ComplianceResult | null;
}

/** Load every review agent's artifact for one page. */
function loadPageReview(runDir: string, slug: string, route: string): PageReview {
  const dir = path.join(runDir, 'pages', slug);
  return {
    slug,
    route,
    audit: readJson<AuditResult>(path.join(dir, 'audit.json')),
    ux: readJson<UxProposal>(path.join(dir, 'ux.json')),
    design: readJson<DesignSpec>(path.join(dir, 'design.json')),
    compliance: readJson<ComplianceResult>(path.join(dir, 'compliance.json')),
  };
}

/** Worst severity across a page's audit gaps + compliance findings. */
function topSeverity(p: PageReview): Severity | '—' {
  let worst = -1;
  for (const g of p.audit?.gaps ?? []) {
    worst = Math.max(worst, SEVERITY_RANK[g.severity]);
  }
  for (const f of p.compliance?.findings ?? []) {
    worst = Math.max(worst, SEVERITY_RANK[f.severity]);
  }
  if (worst < 0) return '—';
  return (
    (Object.keys(SEVERITY_RANK) as Severity[]).find(
      (s) => SEVERITY_RANK[s] === worst,
    ) ?? '—'
  );
}

/** Escape pipe + newlines so cell text never breaks a markdown table. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Build + write `runDir/proposed-changes.md`. Returns the absolute path.
 */
export function writeProposedChanges(
  config: PipelineConfig,
  scope: ScopeDoc,
): string {
  const reviews = scope.pages.map((p) =>
    loadPageReview(config.runDir, p.slug, p.route),
  );

  const totalGaps = reviews.reduce(
    (n, r) => n + (r.audit?.gaps.length ?? 0),
    0,
  );
  const totalCompliance = reviews.reduce(
    (n, r) => n + (r.compliance?.findings.length ?? 0),
    0,
  );

  const lines: string[] = [];

  lines.push(`# Proposed Changes — ${config.projectSlug}`);
  lines.push('');
  lines.push(
    '> **Review pass — no code was applied.** Read and edit this document, ' +
      'then run the apply pass to implement what you approve:',
  );
  lines.push('>');
  lines.push(
    '> ```',
  );
  lines.push(
    `> node dist/cli.js rebuild ${config.target} --resume ${config.runDir} --apply-mode pr`,
  );
  lines.push('> ```');
  lines.push('');
  lines.push(`- **Target:** ${config.target}`);
  lines.push(`- **Screens reviewed:** ${reviews.length}`);
  lines.push(`- **Audit gaps found:** ${totalGaps}`);
  lines.push(`- **Compliance findings:** ${totalCompliance}`);
  lines.push('');

  /* Summary table. */
  lines.push('## Summary');
  lines.push('');
  lines.push('| Screen | Route | Audit gaps | Compliance | Top severity |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of reviews) {
    lines.push(
      `| ${cell(r.slug)} | ${cell(r.route)} | ${r.audit?.gaps.length ?? 0} | ` +
        `${r.compliance?.findings.length ?? 0} | ${topSeverity(r)} |`,
    );
  }
  lines.push('');

  /* Per-screen detail. */
  for (const r of reviews) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${r.slug} — \`${r.route}\``);
    lines.push('');

    /* Audit. */
    const gaps = r.audit?.gaps ?? [];
    lines.push(`### Audit gaps (${gaps.length})`);
    lines.push('');
    if (!r.audit) {
      lines.push('_No audit artifact — the audit agent did not complete._');
    } else if (gaps.length === 0) {
      lines.push('_No functional or UX gaps identified._');
    } else {
      for (const g of gaps) {
        lines.push(`- **[${g.id}]** _${g.category} / ${g.severity}_ — ${g.description}`);
        lines.push(`  - Fix: ${g.recommendation}`);
      }
    }
    if ((r.audit?.consoleErrors.length ?? 0) > 0) {
      lines.push('');
      lines.push('Console errors observed:');
      for (const e of r.audit!.consoleErrors) lines.push(`  - \`${e}\``);
    }
    lines.push('');

    /* UX. */
    lines.push('### UX proposal');
    lines.push('');
    if (!r.ux) {
      lines.push('_No UX artifact._');
    } else {
      if (r.ux.asciiWireframe.trim()) {
        lines.push('```');
        lines.push(r.ux.asciiWireframe);
        lines.push('```');
      }
      if (r.ux.functionalSpec.trim()) {
        lines.push('');
        lines.push(r.ux.functionalSpec);
      }
    }
    lines.push('');

    /* Design. */
    lines.push('### Design spec');
    lines.push('');
    if (!r.design) {
      lines.push('_No design artifact._');
    } else {
      lines.push(r.design.spec.trim() || '_(empty design spec)_');
      if (r.design.brandTokensUsed.length > 0) {
        lines.push('');
        lines.push(`Brand tokens: ${r.design.brandTokensUsed.join(', ')}`);
      }
    }
    lines.push('');

    /* Compliance. */
    const findings = r.compliance?.findings ?? [];
    lines.push(`### Compliance findings (${findings.length})`);
    lines.push('');
    if (!r.compliance) {
      lines.push('_No compliance artifact._');
    } else if (findings.length === 0) {
      lines.push('_No compliance findings._');
    } else {
      for (const f of findings) {
        lines.push(
          `- **[${f.ruleId}]** _${f.domain} / ${f.severity}_ at \`${f.location}\` — ${f.problem}`,
        );
        lines.push(`  - Required fix: ${f.requiredFix}`);
      }
    }
    lines.push('');
  }

  const outPath = path.join(config.runDir, 'proposed-changes.md');
  fs.mkdirSync(config.runDir, { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}
