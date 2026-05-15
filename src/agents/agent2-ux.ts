/**
 * Agent 2 — UX proposal.
 *
 * No browser. Takes the page scope + Agent 1's gap list + the project's
 * library inventory and proposes improved UX as an ASCII wireframe plus a
 * functional spec. HARD CONSTRAINT: it may only use libraries already present
 * in the project — no new dependencies.
 *
 * Output: ctx.pageDir/ux.json + ctx.pageDir/ux.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentContext, UxProposal } from '../types';

interface UxModelResponse {
  asciiWireframe?: string;
  functionalSpec?: string;
  librariesUsed?: string[];
}

/**
 * Keep only libraries that genuinely exist in the inventory. Enforces the
 * "no new dependencies" constraint regardless of what the model returns.
 */
function clampLibraries(
  proposed: unknown,
  inventory: string[],
): { used: string[]; rejected: string[] } {
  const allowed = new Set(inventory);
  const used: string[] = [];
  const rejected: string[] = [];
  if (Array.isArray(proposed)) {
    for (const lib of proposed) {
      if (typeof lib !== 'string') continue;
      const name = lib.trim();
      if (!name) continue;
      if (allowed.has(name)) {
        if (!used.includes(name)) used.push(name);
      } else if (!rejected.includes(name)) {
        rejected.push(name);
      }
    }
  }
  return { used, rejected };
}

function renderMd(result: UxProposal, rejected: string[]): string {
  const lines: string[] = [];
  lines.push(`# UX Proposal — ${result.page}`);
  lines.push('');
  lines.push('## ASCII Wireframe');
  lines.push('');
  lines.push('```');
  lines.push(result.asciiWireframe || '(no wireframe produced)');
  lines.push('```');
  lines.push('');
  lines.push('## Functional Spec');
  lines.push('');
  lines.push(result.functionalSpec || '(no functional spec produced)');
  lines.push('');
  lines.push('## Libraries Used');
  if (result.librariesUsed.length === 0) {
    lines.push('_No project libraries required._');
  } else {
    for (const lib of result.librariesUsed) lines.push(`- ${lib}`);
  }
  if (rejected.length > 0) {
    lines.push('');
    lines.push('## Rejected Libraries (not in inventory — dropped)');
    for (const lib of rejected) lines.push(`- ${lib}`);
  }
  return lines.join('\n');
}

function writeOutputs(ctx: AgentContext, result: UxProposal, rejected: string[]): void {
  fs.mkdirSync(ctx.pageDir, { recursive: true });
  fs.writeFileSync(
    path.join(ctx.pageDir, 'ux.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(ctx.pageDir, 'ux.md'), renderMd(result, rejected), 'utf8');
}

const SYSTEM_INSTRUCTION = `You are a senior UX designer redesigning ONE web page. You receive the page's scope, an audit gap list, and the EXACT set of libraries already installed in the project.

Produce an improved UX: an ASCII wireframe of the new layout and a precise functional spec describing structure, components, states, interactions, and how each audited gap is addressed.

ABSOLUTE CONSTRAINT: you may ONLY use libraries from the provided library inventory. You may NOT introduce, suggest, or assume any new dependency, package, or component library. If the inventory lacks something, solve it with the libraries that ARE available (or plain HTML/CSS). "librariesUsed" MUST be a strict subset of the provided inventory — never list anything not in it.

Preserve the page's existing user function; improve it, do not replace it. Return STRICT JSON only — no prose, no markdown fences.`;

function buildPrompt(ctx: AgentContext): string {
  const inventory = ctx.scope.libraryInventory ?? [];
  const gaps = ctx.audit?.gaps ?? [];
  return `Propose an improved UX for this page.

PAGE
  slug: ${ctx.page.slug}
  route: ${ctx.page.route}
  purpose: ${ctx.page.purpose}
  userFunction: ${ctx.page.userFunction}
  sourceFile: ${ctx.page.filePath}

DATA DEPENDENCIES
${JSON.stringify(ctx.page.dataDependencies, null, 2)}

AUDIT GAPS TO ADDRESS (${gaps.length})
${
  gaps.length
    ? JSON.stringify(
        gaps.map((g) => ({
          id: g.id,
          category: g.category,
          severity: g.severity,
          description: g.description,
          recommendation: g.recommendation,
        })),
        null,
        2,
      )
    : '(no gaps reported)'
}

ALLOWED LIBRARY INVENTORY — the ONLY libraries you may use (${inventory.length})
${inventory.length ? inventory.map((l) => `  - ${l}`).join('\n') : '  (none — use plain HTML/CSS only)'}

Return JSON of EXACTLY this shape:
{
  "asciiWireframe": "multi-line ASCII art of the new layout, top to bottom",
  "functionalSpec": "detailed prose: sections, components, states (loading/empty/error/success), interactions, and which gap id each change closes",
  "librariesUsed": ["only-names", "from-the-inventory-above"]
}
Every entry in "librariesUsed" MUST appear verbatim in the allowed library inventory. Do not invent dependencies.`;
}

export async function runUx(ctx: AgentContext): Promise<UxProposal> {
  const pageId = ctx.page.route || ctx.page.slug;
  const inventory = ctx.scope.libraryInventory ?? [];

  let result: UxProposal;
  let rejected: string[] = [];

  try {
    const response = await ctx.gemini.callJson<UxModelResponse>({
      role: 'agent2_ux',
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(ctx),
      json: true,
    });

    const clamped = clampLibraries(response?.librariesUsed, inventory);
    rejected = clamped.rejected;

    result = {
      page: pageId,
      asciiWireframe:
        typeof response?.asciiWireframe === 'string' && response.asciiWireframe.trim()
          ? response.asciiWireframe
          : '(no wireframe produced)',
      functionalSpec:
        typeof response?.functionalSpec === 'string' && response.functionalSpec.trim()
          ? response.functionalSpec
          : '(no functional spec produced)',
      librariesUsed: clamped.used,
    };
  } catch (err) {
    // Gemini failure — write a minimal valid result rather than crashing.
    result = {
      page: pageId,
      asciiWireframe: '(UX proposal unavailable)',
      functionalSpec: `UX model call failed; no proposal could be generated. ${String(
        err,
      )} Re-run the UX agent for this page once the Gemini call succeeds.`,
      librariesUsed: [],
    };
  }

  writeOutputs(ctx, result, rejected);
  return result;
}
