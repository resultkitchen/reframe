# ADR-0001 — Signal-count confidence

**Status:** Proposed — v0.3 candidate
**Date:** 2026-05-28
**Driver:** Methodological review of `withkynam/vibecode-pro-max-kit` (see CHANGELOG note for v0.2.0).

## Context

Today every JSON-emitting Reframe agent returns a `confidence: number` in [0, 1] on every finding. The model is asked to produce it. Two problems:

1. **It's a hallucination.** A floating-point self-assessment from an LLM doesn't survive provider swaps — the same finding from Gemini vs Claude can come back as 0.87 and 0.45 with no underlying disagreement.
2. **It's not actionable.** The review-app and the founder digest both rank by `severity × confidence`, but no human has a calibrated sense of what 0.71 means vs 0.83. The slider in the UI lets reviewers pick a threshold, but the values are arbitrary.

The vibecode-pro-max-kit codebase converged on a different pattern in three places (drift scoring, complexity scoring, intent clarification): **count concrete signals, bucket the count into LOW / MEDIUM / HIGH.** Auditable, deterministic, robust to model swaps, and a human can read the signal list to see *why* a finding is HIGH.

## Decision

Add a `signals` array and a derived `confidenceTier` to every finding alongside the existing `confidence` float. Treat `signals` as the source of truth; keep `confidence` for one release to avoid breaking the review-app, then deprecate.

```ts
type ConfidenceTier = 'low' | 'medium' | 'high';

type FindingSignal =
  | 'browser-evidence'        // pageerror / 5xx / load-failed observed during drive
  | 'broken-contract'         // matched a Stage-0 BrokenContract by file:line
  | 'multi-persona-agreement' // ≥2 of Arthur/Elena/Marcus/Camille raised the same gap
  | 'severity-critical'       // critical or high severity
  | 'persistent-across-runs'  // present in N≥2 prior runs (telemetry)
  | 'cross-agent-agreement'   // Agent 1 and Agent 6 both flag the same location
  | 'auth-or-billing-surface' // touches risk-class code (see ADR-0002)
  | 'a11y-rule-violation'     // matches an axe-core / WCAG rule id
  | 'explicit-user-feedback'  // tagged from a prior comment/skip pattern
  ;

type FindingMeta = {
  // ...existing fields...
  signals: FindingSignal[];        // 0..N concrete reasons to trust this finding
  confidenceTier: ConfidenceTier;  // derived: 0–1 LOW, 2 MEDIUM, 3+ HIGH
  confidence?: number;             // DEPRECATED — kept one release, removed in v0.4
};
```

Bucketing is mechanical and lives in `src/findings/confidence.ts`:

```ts
export function tierFor(signals: FindingSignal[]): ConfidenceTier {
  if (signals.length >= 3) return 'high';
  if (signals.length === 2) return 'medium';
  return 'low';
}
```

Where the signals come from:

| Signal | Producer |
|---|---|
| `browser-evidence` | `src/orchestrator.ts:detectSmokingGuns()` already computes this — emit as a signal |
| `broken-contract` | Stage 0 mapper — match finding `location` to a `brokenContracts[]` entry |
| `multi-persona-agreement` | Agent 1's 4-persona scan — track which personas raised which `gap.id` |
| `severity-critical` | trivial — `severity === 'critical' \|\| severity === 'high'` |
| `persistent-across-runs` | new — server.ts `/api/telemetry` already aggregates skip patterns; extend to "seen in N runs" |
| `cross-agent-agreement` | new — orchestrator post-processing: match gap.location against compliance-finding.location |
| `auth-or-billing-surface` | new — see ADR-0002 (risk-class tagging) |
| `a11y-rule-violation` | new — Agent 1's accessibility dimension; match rule ids against a small WCAG table |
| `explicit-user-feedback` | new — telemetry's existing pattern-insight feed |

## Consequences

**Positive**
- Cross-LLM stability: the same finding produces the same tier regardless of which provider ran it (assuming the producers above are deterministic, which they are except `multi-persona-agreement`).
- Auditable: the review-app shows the signal chips next to the tier badge. A non-technical reviewer can see "browser-evidence + critical + a11y-rule-violation → HIGH" instead of "0.87 → HIGH".
- The `confidenceAtLeast` fixture assertion stays meaningful — a fixture can say "this gap must show at least 2 signals" rather than "≥ 0.7" (and 0.7 means nothing).

**Negative**
- The `multi-persona-agreement` signal forces Agent 1 to track which persona produced which gap. That's a prompt change — the 4 personas already exist (Arthur QA / Elena UX / Marcus a11y / Camille brand-voice) but their gap attribution is currently collapsed.
- Re-running an old fixture against the new code returns `confidenceTier` only — fixture assertions that pin `confidenceAtLeast: 0.7` break. Mitigation: keep `confidence` populated for one release using `signals.length * 0.25 + 0.25` as a back-fill, then remove.
- The review-app's confidence slider becomes a 3-position toggle instead of a continuous range. Better UX but a visible change.

## Implementation order

1. Add `FindingSignal` enum + `tierFor()` in `src/findings/confidence.ts`. Add `signals: FindingSignal[]` and `confidenceTier: ConfidenceTier` to the Zod schemas in `src/schemas/agent-outputs.ts` (optional fields, additive).
2. Wire the **mechanical** signals first (no prompt changes needed): `severity-critical`, `browser-evidence`, `broken-contract`. Compute them in `orchestrator.ts` after each agent returns, write them onto the finding before persisting.
3. Update `confidence` back-fill so existing review-app code keeps rendering.
4. Update fixture format docs (`tests/fixtures/README.md`) and add `signalsInclude` / `tierAtLeast` assertion kinds. Migrate existing 9 fixtures to declare their expected signals.
5. **Prompt change** for Agent 1: ask each persona to emit its findings tagged with the persona id; orchestrator computes `multi-persona-agreement` from the join.
6. Review-app: replace the confidence slider with three toggle pills. Show signal chips in the finding card.
7. Deprecate `confidence` numeric field in v0.4.

## Rejected alternatives

- **Keep the float, add a calibration step.** Tried in v0.2 sprint planning — too brittle, requires per-provider calibration tables.
- **Drop confidence entirely.** Loses the ranking signal needed for the Founder Digest. The Digest ranks by impact, and impact needs a trust component.
- **Compute confidence from severity + a constant.** Too coarse — a critical with no browser evidence and a critical with five smoking guns should not score the same.

## References

- `src/orchestrator.ts:detectSmokingGuns()` — already produces a signal-like list
- vibecode-pro-max-kit: `process/development-protocols/orchestration.md` (drift scoring)
- vibecode-pro-max-kit: `process/development-protocols/parallel-fan-out.md` (complexity scoring)
