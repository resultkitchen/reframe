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
 * Signal-count confidence — ADR-0001.
 *
 * Mirrors the runtime enum in `src/findings/signals.ts`. Kept literal here
 * (not imported) for the same self-contained-schema reasons as
 * FindingDimensionSchema above: the runtime check doesn't depend on
 * TS-only types.
 */
export const FindingSignalSchema = z.enum([
  'browser-evidence',
  'broken-contract',
  'multi-persona-agreement',
  'severity-critical',
  'persistent-across-runs',
  'cross-agent-agreement',
  'auth-or-billing-surface',
  'a11y-rule-violation',
  'explicit-user-feedback',
]);

export const ConfidenceTierSchema = z.enum(['low', 'medium', 'high']);

/**
 * Confidence values come back as either floats in [0,1] or numeric strings
 * (sometimes with a trailing "%"). The agent's coerceConfidence handles the
 * unification — the schema just lets either type through.
 */
export const ConfidenceSchema = z
  .union([z.number(), z.string()])
  .optional();

/**
 * ADR-0001 finding-meta extensions. Both fields are .optional() so older
 * fixtures and pre-v0.3 agent outputs still validate. Producers (the
 * orchestrator + per-agent normalisers) populate `signals`; the
 * `confidenceTier` is derived from `signals.length` via `tierFor()` and
 * also written to the finding to keep downstream consumers (review-app,
 * PR-body templating) from re-deriving it every render.
 */
const FindingMetaExtensionFields = {
  signals: z.array(FindingSignalSchema).optional(),
  confidenceTier: ConfidenceTierSchema.optional(),
};

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
  ...FindingMetaExtensionFields,
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
  ...FindingMetaExtensionFields,
});

export const ComplianceOutputSchema = z.object({
  findings: z.array(ComplianceFindingSchema),
});

export type ComplianceOutput = z.infer<typeof ComplianceOutputSchema>;

/* ─────────────────────────── Agent 2 — UX ─────────────────────────── */

export const UxOutputSchema = z.object({
  asciiWireframe: z.string().optional(),
  functionalSpec: z.string().optional(),
  librariesUsed: z.array(z.string()).optional(),
});

export type UxOutput = z.infer<typeof UxOutputSchema>;

/* ─────────────────────────── Agent 3 — Design ─────────────────────────── */

export const DesignOutputSchema = z.object({
  spec: z.string().optional(),
  brandTokensUsed: z.array(z.string()).optional(),
});

export type DesignOutput = z.infer<typeof DesignOutputSchema>;

/* ─────────────────────────── Agent 5 — Verify ─────────────────────────── */

export const VerifyOutputSchema = z.object({
  gapsClosed: z.array(z.string()).optional(),
  gapsOpen: z.array(z.string()).optional(),
  regressions: z.array(z.string()).optional(),
});

export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

/* ─────────────────────────── Stage 0 — Mapper ─────────────────────────── */

/**
 * The mapper's output is large and varied. We validate only the top-level
 * shape (each known section is an array if present) — every nested field
 * stays optional so the model can omit anything it isn't confident about.
 * Stage 0's normalizeScope() handles fallbacks per-field downstream.
 */
export const MapperOutputSchema = z.object({
  productGoal: z.string().optional(),
  pages: z
    .array(
      z.object({
        route: z.string().optional(),
        filePath: z.string().optional(),
        purpose: z.string().optional(),
        userFunction: z.string().optional(),
        libraries: z.array(z.string()).optional(),
        dataDependencies: z
          .array(
            z.object({
              kind: z.string().optional(),
              target: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  dbTables: z
    .array(
      z.object({
        name: z.string().optional(),
        columns: z.array(z.string()).optional(),
        relationships: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  dataCalls: z
    .array(
      z.object({
        page: z.string().optional(),
        kind: z.string().optional(),
        target: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  componentInventory: z.array(z.string()).optional(),
  libraryInventory: z.array(z.string()).optional(),
  brokenContracts: z
    .array(
      z.object({
        kind: z.string().optional(),
        location: z.string().optional(),
        detail: z.string().optional(),
        severity: z.string().optional(),
      }),
    )
    .optional(),
  bootstrappedBrand: z
    .object({
      name: z.string().optional(),
      colors: z.record(z.string()).optional(),
      typeScale: z.record(z.string()).optional(),
      spacing: z.record(z.string()).optional(),
      radii: z.record(z.string()).optional(),
      voice: z.string().optional(),
      componentStyle: z.string().optional(),
    })
    .partial()
    .optional(),
});

export type MapperOutput = z.infer<typeof MapperOutputSchema>;

/**
 * Schema for the focused brand-bootstrap sub-call in stage0-map.ts —
 * smaller surface than MapperOutput, just the brand fields.
 */
export const BrandBootstrapOutputSchema = z
  .object({
    name: z.string().optional(),
    colors: z.record(z.string()).optional(),
    typeScale: z.record(z.string()).optional(),
    spacing: z.record(z.string()).optional(),
    radii: z.record(z.string()).optional(),
    voice: z.string().optional(),
    componentStyle: z.string().optional(),
  })
  .partial();

export type BrandBootstrapOutput = z.infer<typeof BrandBootstrapOutputSchema>;
