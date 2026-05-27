/**
 * Agent 3 — Design.
 *
 * No browser. Takes the page scope, the UX proposal, the audit gap list, and
 * the FULL pinned brand spec, and produces a concrete visual design spec.
 * HARD CONSTRAINT: the visual design must be expressed purely in pinned-brand
 * tokens — the model may not invent colors, sizes, spacing, or radii.
 *
 * The brand spec is an INPUT and is never redefined per-run.
 *
 * Output: ctx.pageDir/design.json + ctx.pageDir/design.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentContext, BrandSpec, DesignSpec } from '../types';
import { DesignOutputSchema } from '../schemas/agent-outputs';

interface DesignModelResponse {
  spec?: string;
  brandTokensUsed?: string[];
}

/** Every legal token name the model is allowed to reference. */
function collectBrandTokens(brand: BrandSpec): string[] {
  const tokens: string[] = [];
  for (const k of Object.keys(brand.colors ?? {})) tokens.push(`colors.${k}`);
  for (const k of Object.keys(brand.typeScale ?? {})) tokens.push(`typeScale.${k}`);
  for (const k of Object.keys(brand.spacing ?? {})) tokens.push(`spacing.${k}`);
  for (const k of Object.keys(brand.radii ?? {})) tokens.push(`radii.${k}`);
  return tokens;
}

/**
 * Keep only tokens that genuinely exist in the brand spec. Enforces the
 * "tokens only, no invented values" constraint. Accepts either the fully
 * namespaced form ("colors.primary") or a bare key ("primary").
 */
function clampTokens(
  proposed: unknown,
  validTokens: string[],
): { used: string[]; rejected: string[] } {
  const valid = new Set(validTokens);
  const bareIndex = new Map<string, string>();
  for (const t of validTokens) {
    const bare = t.includes('.') ? t.slice(t.indexOf('.') + 1) : t;
    if (!bareIndex.has(bare)) bareIndex.set(bare, t);
  }

  const used: string[] = [];
  const rejected: string[] = [];
  if (Array.isArray(proposed)) {
    for (const raw of proposed) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim();
      if (!name) continue;
      if (valid.has(name)) {
        if (!used.includes(name)) used.push(name);
      } else if (bareIndex.has(name)) {
        const resolved = bareIndex.get(name)!;
        if (!used.includes(resolved)) used.push(resolved);
      } else if (!rejected.includes(name)) {
        rejected.push(name);
      }
    }
  }
  return { used, rejected };
}

function renderMd(result: DesignSpec, brand: BrandSpec, rejected: string[]): string {
  const lines: string[] = [];
  lines.push(`# Design Spec — ${result.page}`);
  lines.push('');
  lines.push(`Brand: **${brand.name}** ${brand.pinned ? '(pinned)' : '(bootstrap — not yet pinned)'}`);
  lines.push('');
  lines.push('## Visual Spec');
  lines.push('');
  lines.push(result.spec || '(no design spec produced)');
  lines.push('');
  lines.push('## Brand Tokens Used');
  if (result.brandTokensUsed.length === 0) {
    lines.push('_No brand tokens referenced._');
  } else {
    for (const t of result.brandTokensUsed) lines.push(`- \`${t}\``);
  }
  if (rejected.length > 0) {
    lines.push('');
    lines.push('## Rejected Tokens (not in brand spec — dropped)');
    for (const t of rejected) lines.push(`- \`${t}\``);
  }
  return lines.join('\n');
}

function writeOutputs(
  ctx: AgentContext,
  result: DesignSpec,
  brand: BrandSpec,
  rejected: string[],
): void {
  fs.mkdirSync(ctx.pageDir, { recursive: true });
  fs.writeFileSync(
    path.join(ctx.pageDir, 'design.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ctx.pageDir, 'design.md'),
    renderMd(result, brand, rejected),
    'utf8',
  );
}

const SYSTEM_INSTRUCTION = `You are a senior visual designer producing a concrete design spec for ONE web page. You receive the page scope, an approved UX proposal (ASCII wireframe + functional spec), an audit gap list, and a PINNED brand spec.

The brand spec is an immutable INPUT. You must NOT redefine, extend, override, or reinterpret it. Every color, font size, line height, spacing value, and corner radius in your design MUST be referenced as a named brand token (e.g. "colors.primary", "typeScale.h1", "spacing.lg", "radii.md"). You may NOT invent hex codes, pixel values, rem values, or any literal style value — if the brand spec lacks a token you need, choose the closest existing token and say so.

Honor the brand voice and componentStyle. Translate the UX proposal into a precise, build-ready visual spec: layout, type hierarchy, color application per region/state, spacing rhythm, component styling, and interactive/hover/focus states — all in brand tokens.

Return STRICT JSON only — no prose, no markdown fences.`;

function buildPrompt(ctx: AgentContext, brand: BrandSpec, validTokens: string[]): string {
  const gaps = ctx.audit?.gaps ?? [];
  const ux = ctx.ux;
  return `Produce a visual design spec for this page, expressed purely in brand tokens.

PAGE
  slug: ${ctx.page.slug}
  route: ${ctx.page.route}
  purpose: ${ctx.page.purpose}
  userFunction: ${ctx.page.userFunction}

PINNED BRAND SPEC (immutable input — do not redefine)
  name: ${brand.name}
  voice: ${brand.voice}
  componentStyle: ${brand.componentStyle}
  colors:    ${JSON.stringify(brand.colors ?? {})}
  typeScale: ${JSON.stringify(brand.typeScale ?? {})}
  spacing:   ${JSON.stringify(brand.spacing ?? {})}
  radii:     ${JSON.stringify(brand.radii ?? {})}

THE ONLY TOKEN NAMES YOU MAY REFERENCE (${validTokens.length})
${validTokens.length ? validTokens.map((t) => `  - ${t}`).join('\n') : '  (none)'}

UX PROPOSAL TO STYLE
  asciiWireframe:
${ux?.asciiWireframe ?? '(no wireframe available)'}

  functionalSpec:
${ux?.functionalSpec ?? '(no functional spec available)'}

AUDIT GAPS (design should not re-open these) (${gaps.length})
${
  gaps.length
    ? JSON.stringify(
        gaps.map((g) => ({ id: g.id, category: g.category, description: g.description })),
        null,
        2,
      )
    : '(no gaps reported)'
}

Return JSON of EXACTLY this shape:
{
  "spec": "detailed build-ready visual spec: layout regions, type hierarchy, color usage per region and per state, spacing rhythm, component styling, and hover/focus/active/disabled states — EVERY style value named as a brand token, never a literal",
  "brandTokensUsed": ["colors.primary", "typeScale.h1", "spacing.lg", "..."]
}
Every entry in "brandTokensUsed" MUST appear verbatim in the token list above. Do not invent colors, sizes, spacing, or radii.`;
}

export async function runDesign(ctx: AgentContext): Promise<DesignSpec> {
  const pageId = ctx.page.route || ctx.page.slug;
  const brand = ctx.brand;
  const validTokens = collectBrandTokens(brand);

  let result: DesignSpec;
  let rejected: string[] = [];

  try {
    const response = await ctx.gemini.callJsonSchema(DesignOutputSchema, {
      role: 'agent3_design',
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(ctx, brand, validTokens),
      json: true,
    });

    const clamped = clampTokens(response?.brandTokensUsed, validTokens);
    rejected = clamped.rejected;

    result = {
      page: pageId,
      spec:
        typeof response?.spec === 'string' && response.spec.trim()
          ? response.spec
          : '(no design spec produced)',
      brandTokensUsed: clamped.used,
    };
  } catch (err) {
    // Gemini failure — write a minimal valid result rather than crashing.
    result = {
      page: pageId,
      spec: `Design model call failed; no design spec could be generated. ${String(
        err,
      )} Re-run the design agent for this page once the Gemini call succeeds.`,
      brandTokensUsed: [],
    };
  }

  writeOutputs(ctx, result, brand, rejected);
  return result;
}
