/**
 * Signal-count confidence — ADR-0001.
 *
 * Replaces the LLM-hallucinated `confidence: number` with an auditable,
 * deterministic count of *concrete reasons to trust the finding*. Each
 * producer (orchestrator step, agent normaliser, telemetry layer) appends
 * the signals it can vouch for. The tier is derived mechanically from the
 * count — 0–1 LOW, 2 MEDIUM, 3+ HIGH — and never invented by the model.
 *
 * Pattern adapted from vibecode-pro-max-kit's drift / complexity scoring,
 * which itself counts 0–4 signals and buckets into LOW/MEDIUM/HIGH.
 *
 * Slice 1 (this file): primitives only. Producer wiring lands in slice 2;
 * existing agent code continues to write `confidence: number` and that
 * field is still honoured by the review-app until v0.4 removes it.
 */

/**
 * Discrete reasons to trust a finding. Every signal corresponds to a
 * mechanical check by a known producer — none of these come from the LLM
 * grading itself.
 */
export type FindingSignal =
  /** A `[pageerror]`, console.error, or 5xx fetch was observed during drive. */
  | 'browser-evidence'
  /** The finding's location matches a Stage-0 BrokenContract by file:line. */
  | 'broken-contract'
  /** ≥2 of Agent 1's personas (Arthur/Elena/Marcus/Camille) raised the same gap. */
  | 'multi-persona-agreement'
  /** severity is 'critical' or 'high'. */
  | 'severity-critical'
  /** The same finding was present in ≥2 prior runs of this project (telemetry). */
  | 'persistent-across-runs'
  /** Agent 1 and Agent 6 both flagged the same location. */
  | 'cross-agent-agreement'
  /** Touches a high-risk surface (auth, billing, schema migration, deploy) — ADR-0002. */
  | 'auth-or-billing-surface'
  /** Matches a known WCAG / axe-core rule id. */
  | 'a11y-rule-violation'
  /** The same finding was approved or commented on in a prior run (telemetry). */
  | 'explicit-user-feedback';

export const KNOWN_SIGNALS: readonly FindingSignal[] = [
  'browser-evidence',
  'broken-contract',
  'multi-persona-agreement',
  'severity-critical',
  'persistent-across-runs',
  'cross-agent-agreement',
  'auth-or-billing-surface',
  'a11y-rule-violation',
  'explicit-user-feedback',
] as const;

export type ConfidenceTier = 'low' | 'medium' | 'high';

/**
 * Mechanical bucketing: 0–1 signals → LOW, 2 → MEDIUM, 3+ → HIGH.
 * Deterministic and identical across LLM providers. The thresholds are
 * lifted from vc-autoresearch's drift-scoring tiering verbatim; if we
 * change them, change them here once.
 */
export function tierFor(signals: readonly FindingSignal[]): ConfidenceTier {
  const n = signals.length;
  if (n >= 3) return 'high';
  if (n === 2) return 'medium';
  return 'low';
}

/**
 * Back-fill for the legacy `confidence: number` field. ADR-0001's
 * deprecation plan keeps the float around for one release so the
 * review-app's existing slider keeps working while the new chips
 * roll out. Maps the tier to a representative point in [0, 1]:
 *
 *   low (0–1 signals)   → 0.35
 *   medium (2)          → 0.65
 *   high (3+)           → 0.90
 *
 * Producers that genuinely need a higher-fidelity float can pass
 * the underlying signal count to `confidenceFromCount()` directly.
 */
export function confidenceFromSignals(signals: readonly FindingSignal[]): number {
  return confidenceFromCount(signals.length);
}

export function confidenceFromCount(count: number): number {
  if (count >= 5) return 0.95;
  if (count >= 3) return 0.9;
  if (count === 2) return 0.65;
  if (count === 1) return 0.5;
  return 0.35;
}

/**
 * De-duplicate while preserving insertion order. Producers append
 * naively; this is the canonical step before persisting / sending
 * the finding downstream.
 */
export function normaliseSignals(input: readonly unknown[] | undefined): FindingSignal[] {
  if (!Array.isArray(input)) return [];
  const known = new Set<FindingSignal>(KNOWN_SIGNALS);
  const out: FindingSignal[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    if (!known.has(raw as FindingSignal)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw as FindingSignal);
  }
  return out;
}
