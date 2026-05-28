/**
 * Decorate findings with mechanical signals — ADR-0001 slice 2.
 *
 * Runs after Agents 1 (audit) and 6 (compliance) complete. Each finding
 * gets a `signals: FindingSignal[]` array assembled from concrete,
 * non-LLM evidence — browser stream content, Stage-0 broken-contract
 * matches, cross-agent location overlap, severity threshold. The
 * `confidenceTier` is then derived mechanically via `tierFor()`.
 *
 * Slice 2 wires three of the nine signals:
 *
 *   severity-critical      — gap.severity ∈ {critical, high}
 *   browser-evidence       — page captured a [pageerror] or 5xx response
 *   broken-contract        — a Stage-0 BrokenContract's location matches
 *                            the page's filePath
 *   cross-agent-agreement  — Agent 1 and Agent 6 both flagged the same
 *                            location (file:line)
 *
 * The remaining five (multi-persona-agreement, persistent-across-runs,
 * auth-or-billing-surface, a11y-rule-violation, explicit-user-feedback)
 * each require either a prompt change or a telemetry feed and land in
 * later slices. The decorator is forward-compatible — they all become
 * additional `signals.push(...)` calls in this same module.
 *
 * Decoration is idempotent: calling it twice on the same ctx is a no-op
 * because each producer call de-dupes via the Set in normaliseSignals().
 */

import type {
  AuditResult,
  BrokenContract,
  ComplianceResult,
  Gap,
  PageScope,
} from '../types';
import {
  confidenceFromSignals,
  normaliseSignals,
  tierFor,
  type FindingSignal,
} from './signals';
import { matchA11yRule } from './a11y-rules';

/**
 * One-shot decorator covering the two finding shapes that exist today.
 * Mutates the passed audit/compliance objects in place so all downstream
 * consumers (review-app, PR body, founder digest, Agent 4) see the
 * enriched data without any wiring changes.
 */
export function decorateAllFindings(
  page: PageScope,
  audit: AuditResult | undefined,
  compliance: ComplianceResult | undefined,
  brokenContracts: readonly BrokenContract[],
): void {
  // Snapshot the cross-agent agreement table BEFORE mutating either side
  // so the order Agent 1/Agent 6 happened to finish in doesn't change
  // which signals fire.
  const auditLocations = collectAuditLocations(audit);
  const complianceLocations = collectComplianceLocations(compliance);

  if (audit) {
    decorateAuditGaps(audit, page, brokenContracts, complianceLocations);
  }
  if (compliance) {
    decorateComplianceFindings(compliance, page, brokenContracts, auditLocations);
  }
}

/* ────────────────────────────── audit ────────────────────────────── */

function decorateAuditGaps(
  audit: AuditResult,
  page: PageScope,
  brokenContracts: readonly BrokenContract[],
  complianceLocations: ReadonlySet<string>,
): void {
  const browserEvidencePresent = hasBrowserEvidence(audit.consoleErrors);
  const pageBrokenContracts = brokenContracts.filter((bc) =>
    locationTouchesFile(bc.location, page.filePath),
  );

  for (const gap of audit.gaps ?? []) {
    const signals: FindingSignal[] = [...(gap.signals ?? [])];

    if (isHighSeverity(gap.severity)) signals.push('severity-critical');

    // Browser-evidence only fires for category=functional. UX-only gaps
    // shouldn't borrow trust from an unrelated 500 served by an analytics
    // pixel — the noise/signal ratio collapses otherwise.
    if (browserEvidencePresent && gap.category === 'functional') {
      signals.push('browser-evidence');
    }

    if (pageBrokenContracts.length > 0) signals.push('broken-contract');

    if (gapTouchesAnyLocation(gap, complianceLocations, page.filePath)) {
      signals.push('cross-agent-agreement');
    }

    // a11y-rule-violation — slice 5. Only consider gaps whose dimension is
    // explicitly accessibility; otherwise we'd light up generic "contrast"
    // mentions on a brand-voice gap and erode trust in the signal.
    if (gap.dimension === 'accessibility' && matchA11yRule(gap)) {
      signals.push('a11y-rule-violation');
    }

    applySignals(gap, signals);
  }
}

/* ──────────────────────────── compliance ─────────────────────────── */

function decorateComplianceFindings(
  compliance: ComplianceResult,
  page: PageScope,
  brokenContracts: readonly BrokenContract[],
  auditLocations: ReadonlySet<string>,
): void {
  const pageBrokenContracts = brokenContracts.filter((bc) =>
    locationTouchesFile(bc.location, page.filePath),
  );

  for (const finding of compliance.findings ?? []) {
    const signals: FindingSignal[] = [...(finding.signals ?? [])];

    if (isHighSeverity(finding.severity)) signals.push('severity-critical');

    if (pageBrokenContracts.length > 0) signals.push('broken-contract');

    if (
      finding.location &&
      (auditLocations.has(normaliseLocation(finding.location)) ||
        locationTouchesFile(finding.location, page.filePath))
    ) {
      // Compliance findings always carry a `location` (the rule says where
      // the violation lives); if Agent 1 also flagged that same file or
      // file:line, it's cross-agent agreement.
      if (auditLocations.has(normaliseLocation(finding.location))) {
        signals.push('cross-agent-agreement');
      }
    }

    applySignals(finding, signals);
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function isHighSeverity(severity: unknown): boolean {
  return severity === 'critical' || severity === 'high';
}

/**
 * The smoking-guns rule (orchestrator.ts:detectSmokingGuns) factored
 * out — we want the SAME definition of "the browser had something to
 * say" so the pass/fail gate and the trust signal stay in lockstep.
 */
function hasBrowserEvidence(consoleErrors: readonly string[] | undefined): boolean {
  if (!consoleErrors || consoleErrors.length === 0) return false;
  for (const line of consoleErrors) {
    if (line.startsWith('[pageerror]')) return true;
    if (/status of 5\d\d/i.test(line)) return true;
  }
  return false;
}

/**
 * Normalise a "file:line" string to just "file" for cross-agent matching.
 * Agent 1 emits gap evidence with whatever the LLM saw; Agent 6's
 * `location` is canonically "file:line". For the cross-agent signal we
 * match at file granularity — line-level matching would miss legitimate
 * agreement when each agent picks a slightly different anchor.
 */
function normaliseLocation(raw: string): string {
  const trimmed = raw.trim();
  // Strip the line/column suffix if present (file:42:5 → file).
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  // Keep paths whose first colon is a Windows drive marker ("C:\…").
  if (colon === 1 && /[a-z]/i.test(trimmed[0] ?? '')) {
    const second = trimmed.indexOf(':', 2);
    return second === -1 ? trimmed : trimmed.slice(0, second);
  }
  return trimmed.slice(0, colon);
}

function collectAuditLocations(audit: AuditResult | undefined): Set<string> {
  const out = new Set<string>();
  for (const gap of audit?.gaps ?? []) {
    for (const e of gap.evidence ?? []) {
      // Audit gaps emit evidence strings like "intake.tsx:42" or just a
      // console line. We only index entries that look like a file path.
      if (/[./\\][a-z0-9_\-]+\.(?:t|j)sx?/i.test(e)) {
        out.add(normaliseLocation(e));
      }
    }
  }
  return out;
}

function collectComplianceLocations(
  compliance: ComplianceResult | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const f of compliance?.findings ?? []) {
    if (f.location) out.add(normaliseLocation(f.location));
  }
  return out;
}

function locationTouchesFile(location: string, filePath: string): boolean {
  if (!location || !filePath) return false;
  const loc = normaliseLocation(location);
  // Case-insensitive substring match in both directions: the LLM may
  // emit `intake/new/page.tsx` while filePath is `app/intake/new/page.tsx`.
  const a = loc.toLowerCase();
  const b = filePath.toLowerCase();
  return a.includes(b) || b.includes(a);
}

function gapTouchesAnyLocation(
  gap: Gap,
  locations: ReadonlySet<string>,
  pageFilePath: string,
): boolean {
  if (locations.size === 0) return false;
  for (const e of gap.evidence ?? []) {
    if (locations.has(normaliseLocation(e))) return true;
  }
  // Fallback: if the page's file path is in the compliance set, treat
  // every gap on this page as touching it. Per-line matching here is
  // too aggressive — Agent 1's gap rarely cites file:line precisely.
  return locations.has(normaliseLocation(pageFilePath));
}

/**
 * Persist the resolved signal list, the derived tier, and the back-filled
 * legacy confidence number onto the finding. `normaliseSignals()` also
 * de-dupes so re-running decoration is harmless.
 */
function applySignals(
  finding: { signals?: FindingSignal[]; confidenceTier?: string; confidence?: number },
  signals: readonly FindingSignal[],
): void {
  const normalised = normaliseSignals(signals);
  finding.signals = normalised;
  finding.confidenceTier = tierFor(normalised);

  // Back-fill the legacy float ONLY when the agent didn't emit one. If
  // the model already produced a calibrated value (some custom providers
  // do), respect it — the deprecation plan keeps that field readable for
  // one full release before v0.4 removes it.
  if (typeof finding.confidence !== 'number') {
    finding.confidence = confidenceFromSignals(normalised);
  }
}
