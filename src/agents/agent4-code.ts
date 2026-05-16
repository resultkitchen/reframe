/**
 * Agent 4 — Code.
 *
 * Implements the page. Takes the current source plus every upstream signal
 * (Agent 1 audit gaps, Agent 2 UX wireframe/spec, Agent 3 design tokens,
 * Agent 6 compliance findings) and asks the model for the COMPLETE rewritten
 * file that closes the gaps, applies the UX + design, and fixes every
 * compliance finding — without changing unrelated behavior.
 *
 * Apply modes:
 *   - 'pr'      → write the new content to the file, compute the real git diff.
 *   - 'propose' → do NOT write; emit a self-computed unified diff only.
 *
 * Output: CodeResult plus `<pageDir>/code.json` + `<pageDir>/code.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentContext, CodeResult } from '../types';
import { getDiff } from '../git';

/** Resolve the absolute path of the page's primary source file. */
function resolveFilePath(ctx: AgentContext): string {
  return path.isAbsolute(ctx.page.filePath)
    ? ctx.page.filePath
    : path.join(ctx.config.workDir, ctx.page.filePath);
}

/** Read a file; returns null when unreadable. */
function readFileSafe(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Strip a leading/trailing markdown code fence the model may have wrapped
 * the file content in (```tsx ... ```), and trim a trailing newline drift.
 */
function unfence(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/;
  const m = text.match(fence);
  if (m) text = m[1];
  return text;
}

/**
 * Minimal unified-diff generator (LCS-based) for 'propose' mode. Produces a
 * single hunk-per-file diff; good enough for human review, not for `git apply`
 * fidelity guarantees.
 */
function unifiedDiff(relPath: string, oldText: string, newText: string): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  // LCS table.
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Backtrack into a line-op list.
  const ops: Array<{ tag: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ tag: '-', line: a[i] });
      i++;
    } else {
      ops.push({ tag: '+', line: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ tag: '-', line: a[i++] });
  while (j < n) ops.push({ tag: '+', line: b[j++] });

  const header =
    `--- a/${relPath}\n` +
    `+++ b/${relPath}\n` +
    `@@ -1,${m} +1,${n} @@\n`;
  const body = ops.map((o) => `${o.tag}${o.line}`).join('\n');
  return header + body + '\n';
}

/** Render the human-readable code report. */
function renderMd(ctx: AgentContext, result: CodeResult, modelUsedFallback: boolean): string {
  const lines: string[] = [];
  lines.push(`# Code — ${result.page}`);
  lines.push('');
  lines.push(`**Apply mode:** ${ctx.config.applyMode}`);
  lines.push(`**Applied:** ${result.applied ? 'yes' : 'no'}`);
  lines.push(`**Files changed:** ${result.filesChanged.length || 'none'}`);
  if (result.filesChanged.length > 0) {
    for (const f of result.filesChanged) lines.push(`- \`${f}\``);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push(result.notes || '(none)');
  if (modelUsedFallback) {
    lines.push('');
    lines.push('> Model output was empty or invalid — no changes were produced.');
  }
  lines.push('');
  lines.push('## Diff');
  lines.push('```diff');
  lines.push(result.diff.trim() === '' ? '(no diff)' : result.diff);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/** Persist code.json + code.md (+ code.diff) into the page's run dir. */
function writeArtifacts(ctx: AgentContext, result: CodeResult, fallback: boolean): void {
  try {
    fs.mkdirSync(ctx.pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.pageDir, 'code.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ctx.pageDir, 'code.md'),
      renderMd(ctx, result, fallback),
      'utf8',
    );
    fs.writeFileSync(path.join(ctx.pageDir, 'code.diff'), result.diff, 'utf8');
  } catch (err) {
    console.error(`[agent4-code] failed to write artifacts: ${String(err)}`);
  }
}

export async function runCode(ctx: AgentContext): Promise<CodeResult> {
  const pageId = ctx.page.route || ctx.page.slug;
  const absPath = resolveFilePath(ctx);
  const relPath = ctx.page.filePath;

  const currentSource = readFileSafe(absPath);
  if (currentSource === null) {
    const result: CodeResult = {
      page: pageId,
      filesChanged: [],
      diff: '',
      applied: false,
      notes: `Could not read source file at ${absPath}; no changes made.`,
    };
    writeArtifacts(ctx, result, true);
    console.error(`[agent4-code] unreadable source: ${absPath}`);
    return result;
  }

  // Assemble upstream signals.
  const gaps = ctx.audit?.gaps ?? [];
  const gapsBlock =
    gaps.length > 0
      ? gaps
          .map(
            (g) =>
              `- [${g.id}] (${g.category}/${g.severity}) ${g.description}\n  Recommendation: ${g.recommendation}`,
          )
          .join('\n')
      : '(no audit gaps reported)';

  const uxBlock = ctx.ux
    ? [
        'ASCII wireframe:',
        ctx.ux.asciiWireframe,
        '',
        'Functional spec:',
        ctx.ux.functionalSpec,
      ].join('\n')
    : '(no UX proposal available)';

  const designBlock = ctx.design
    ? [
        'Visual spec (expressed in pinned brand tokens):',
        ctx.design.spec,
        '',
        `Brand tokens to use: ${ctx.design.brandTokensUsed.join(', ') || '(none listed)'}`,
      ].join('\n')
    : '(no design spec available)';

  const complianceFindings = ctx.compliance?.findings ?? [];
  const complianceBlock =
    complianceFindings.length > 0
      ? complianceFindings
          .map(
            (f) =>
              `- [${f.ruleId}] (${f.domain}/${f.severity}) at ${f.location}\n  Problem: ${f.problem}\n  Required fix: ${f.requiredFix}`,
          )
          .join('\n')
      : '(no compliance findings)';

  const availableLibs = (ctx.page.libraries ?? []).concat(
    ctx.scope?.libraryInventory ?? [],
  );
  const libsBlock =
    Array.from(new Set(availableLibs)).join(', ') || '(no library inventory)';

  const systemInstruction =
    'You are a senior engineer rewriting a single source file of an existing ' +
    'web application. Produce the COMPLETE, final content of the file — ready ' +
    'to write to disk verbatim. Rules: fix ONLY the identified gaps, apply the ' +
    'given UX and design specs, and fix EVERY compliance finding. Do NOT change ' +
    'unrelated behavior. Use ONLY libraries that are already imported in the ' +
    'file or present in the supplied library inventory — introduce no new ' +
    'dependencies. Preserve the file\'s existing module format, imports style, ' +
    'and exports. Output ONLY the file content — no explanation, no markdown ' +
    'fences, no commentary.';

  const prompt = [
    `Target file: ${relPath}`,
    `Page: ${pageId}  —  ${ctx.page.purpose}`,
    `User function: ${ctx.page.userFunction}`,
    `Available libraries (use only these): ${libsBlock}`,
    '',
    '=== CURRENT FILE CONTENT ===',
    currentSource,
    '=== END CURRENT FILE CONTENT ===',
    '',
    '=== AUDIT GAPS TO CLOSE ===',
    gapsBlock,
    '',
    '=== UX PROPOSAL TO APPLY ===',
    uxBlock,
    '',
    '=== DESIGN SPEC TO APPLY ===',
    designBlock,
    '',
    '=== COMPLIANCE FINDINGS TO FIX (all must be resolved) ===',
    complianceBlock,
    '',
    'Now output the complete rewritten content of the file, and nothing else.',
  ].join('\n');

  let newContent = '';
  try {
    const raw = await ctx.gemini.call({
      role: 'agent4_code',
      systemInstruction,
      prompt,
      // The code agent rewrites whole files; on large pages the pro model
      // routinely needs more than the default per-call timeout. Give it 5 min.
      timeoutMs: 300_000,
    });
    newContent = unfence(raw ?? '');
  } catch (err) {
    console.error(`[agent4-code] Gemini call failed for ${pageId}: ${String(err)}`);
    const result: CodeResult = {
      page: pageId,
      filesChanged: [],
      diff: '',
      applied: false,
      notes: `Gemini code generation failed: ${String(err)}. No changes made.`,
    };
    writeArtifacts(ctx, result, true);
    return result;
  }

  // Guard: empty or unchanged output → no-op result.
  if (newContent.trim() === '') {
    const result: CodeResult = {
      page: pageId,
      filesChanged: [],
      diff: '',
      applied: false,
      notes: 'Model returned empty content; no changes made.',
    };
    writeArtifacts(ctx, result, true);
    return result;
  }
  if (newContent === currentSource) {
    const result: CodeResult = {
      page: pageId,
      filesChanged: [],
      diff: '',
      applied: false,
      notes:
        'Model output is identical to the current file; no gaps required code changes.',
    };
    writeArtifacts(ctx, result, false);
    return result;
  }

  const notesParts: string[] = [];
  notesParts.push(
    `Rewrote ${relPath}: ${gaps.length} audit gap(s), ` +
      `${complianceFindings.length} compliance finding(s) targeted.`,
  );

  let diff = '';
  let applied = false;

  if (ctx.config.applyMode === 'pr') {
    // Write the new content, then compute the real git diff of the work tree.
    try {
      fs.writeFileSync(absPath, newContent, 'utf8');
      applied = true;
    } catch (err) {
      console.error(`[agent4-code] failed to write ${absPath}: ${String(err)}`);
      const result: CodeResult = {
        page: pageId,
        filesChanged: [],
        diff: '',
        applied: false,
        notes: `Failed to write file ${absPath}: ${String(err)}.`,
      };
      writeArtifacts(ctx, result, true);
      return result;
    }
    try {
      diff = await getDiff(ctx.config.workDir);
    } catch (err) {
      // The write succeeded — fall back to a self-computed diff so the result
      // is still reviewable, but keep applied:true.
      console.error(`[agent4-code] getDiff failed: ${String(err)}`);
      diff = unifiedDiff(relPath, currentSource, newContent);
      notesParts.push('git diff unavailable; diff is a self-computed approximation.');
    }
  } else {
    // 'propose' mode — do not touch the working tree.
    diff = unifiedDiff(relPath, currentSource, newContent);
    applied = false;
    notesParts.push('propose mode: file not modified; diff is a proposal only.');
  }

  const result: CodeResult = {
    page: pageId,
    filesChanged: [relPath],
    diff,
    applied,
    notes: notesParts.join(' '),
  };
  writeArtifacts(ctx, result, false);
  return result;
}
