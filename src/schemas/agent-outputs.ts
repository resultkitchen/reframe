/**
 * Zod schemas for every agent's LLM output.
 *
 * These are passed to `gemini.callJsonSchema(schema, opts)`. The client
 * validates the model's response against the schema; on validation failure
 * it appends the issues to the prompt and asks the model to retry — once.
 * Persistent failure throws and the caller falls back to its own minimal
 * default (the agents already do this — these schemas just catch the case
 * BEFORE bad data flows through normaliseGap and into a finding card).
 *
 * Schemas are deliberately PERMISSIVE: every output field is `.optional()`
 * because the LLM is allowed to omit non-essential fields. The schema's job
 * is to enforce SHAPE (e.g. `gaps` must be an array of objects with known
 * fields), not to ensure every field is filled. The agent's normalize
 * function applies defaults and required-field checks downstream.
 *
 * When adding a new agent: define its schema here, import from the agent
 * file, and swap `callJson` for `callJsonSchema`.
 */

import { z } from 'zod';

/* ─────────────────────────── shared enums ─────────────────────────── */

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

/**
 * Mirror of FindingDimension in src/types.ts. Kept literal here (not
 * imported) so the schema is self-contained and the runtime check
 * doesn't depend on TS-only types.
 */
export const FindingDimensionSchema = z.enum([
  'functional',
  'ux',
  'visual-hierarchy',
  'brand-voice',
  'microcopy',
  'responsive',
  'accessibility',
  'performance',
  'compliance',
  'data-contract',
  'security',
]);

/**
 * Confidence values come back as either floats in [0,1] or numeric strings
 * (sometimes with a trailing "%"). The agent's coerceConfidence handles the
 * unification — the schema just lets either type through.
 */
export const ConfidenceSchema = z
  .union([z.number(), z.string()])
  .optional();

/* ─────────────────────────── Agent 1 — Audit ─────────────────────────── */

export const AuditGapSchema = z.object({
  id: z.string().optional(),
  category: z.enum(['functional', 'ux']).optional(),
  dimension: FindingDimensionSchema.optional(),
  severity: SeveritySchema.optional(),
  confidence: ConfidenceSchema,
  description: z.string().optional(),
  plain: z.string().optional(),
  whyItMatters: z.string().optional(),
  recommendation: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});

export const AuditOutputSchema = z.object({
  gaps: z.array(AuditGapSchema),
});

export type AuditOutput = z.infer<typeof AuditOutputSchema>;

/* ─────────────────────────── Agent 6 — Compliance ─────────────────────────── */

export const ComplianceFindingSchema = z.object({
  ruleId: z.string().optional(),
  domain: z.string().optional(),
  dimension: FindingDimensionSchema.optional(),
  severity: SeveritySchema.optional(),
  confidence: ConfidenceSchema,
  location: z.string().optional(),
  problem: z.string().optional(),
  plain: z.string().optional(),
  whyItMatters: z.string().optional(),
  requiredFix: z.string().optional(),
});

export const ComplianceOutputSchema = z.object({
  findings: z.array(ComplianceFindingSchema),
});

export type ComplianceOutput = z.infer<typeof ComplianceOutputSchema>;
