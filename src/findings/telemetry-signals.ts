/**
 * Telemetry-fed signals — ADR-0001 slice 4.
 *
 * Loads prior runs from the same `runs/` parent and computes two
 * cross-run signals per finding fingerprint:
 *
 *   persistent-across-runs — the same fingerprint appeared in N>=2
 *                            prior runs of this project. A finding
 *                            that keeps showing up is more likely
 *                            real than a one-off LLM hiccup.
 *   explicit-user-feedback — the same fingerprint was approved,
 *                            skipped, or commented on in a prior
 *                            run. A reviewer paid attention to it
 *                            before — that's a separate trust signal
 *                            on top of mere recurrence.
 *
 * Fingerprint shape:
 *   audit gap:        page.slug::dim::lower(description-or-plain)
 *                     trimmed to 80 chars to absorb LLM rewordings
 *   compliance:       page.slug::ruleId::location
 *
 * The cap matches `src/server.ts` — same 50-run / 90-day window the
 * /api/telemetry pattern-insights endpoint already uses, so the
 * signal fires on the same data the reviewer sees in the UI.
 *
 * Reads disk every orchestrator run, but only ONCE per run (the
 * orchestrator caches the result and passes it into every per-page
 * decoration call). Cheap enough — JSON parse over ~50 small files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalsDoc } from '../types';

const TELEMETRY_RUN_CAP = 50;
const TELEMETRY_AGE_DAYS_CAP = 90;

/** Threshold for `persistent-across-runs` — appears in ≥ this many priors. */
export const PERSISTENT_RUN_THRESHOLD = 2;

export interface TelemetrySignals {
  /** fingerprint → number of prior runs containing it (excludes current run). */
  occurrenceCount: Map<string, number>;
  /** fingerprint → true if any prior run had a user decision/comment on it. */
  hadFeedback: Set<string>;
}

const EMPTY: TelemetrySignals = {
  occurrenceCount: new Map(),
  hadFeedback: new Set(),
};

/** Empty signals — used by callers that don't have a runs/ parent (eval mode, tests). */
export function emptyTelemetrySignals(): TelemetrySignals {
  return EMPTY;
}

/* ─────────────────────────── fingerprinting ─────────────────────────── */

/**
 * Normalise the descriptive text of an audit gap into a stable
 * fingerprint chunk. Lower-cases, strips runs of whitespace, and
 * truncates to 80 chars so a slightly-reworded gap ("button doesn't
 * work" vs "button does not work") still collides — the trade-off is
 * a small false-positive rate on the signal in exchange for tolerance
 * to LLM nondeterminism.
 */
function normaliseDescriptionChunk(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

export function gapFingerprint(
  pageSlug: string,
  gap: {
    dimension?: string;
    category?: string;
    description?: string;
    plain?: string;
  },
): string {
  const dim = gap.dimension ?? gap.category ?? 'unknown';
  // Prefer `description` over `plain` — the latter is rewritten more often.
  const text = normaliseDescriptionChunk(gap.description ?? gap.plain);
  return `${pageSlug}::${dim}::${text}`;
}

export function complianceFingerprint(
  pageSlug: string,
  finding: { ruleId?: string; location?: string },
): string {
  return `${pageSlug}::${finding.ruleId ?? 'unknown'}::${finding.location ?? ''}`;
}

/* ─────────────────────────── prior-run scan ─────────────────────────── */

function listEligibleRunDirs(runsParent: string, excludeRunDir: string): string[] {
  if (!fs.existsSync(runsParent) || !fs.statSync(runsParent).isDirectory()) {
    return [];
  }
  const cutoffMs = Date.now() - TELEMETRY_AGE_DAYS_CAP * 24 * 60 * 60 * 1000;
  const absoluteExclude = path.resolve(excludeRunDir);

  return fs.readdirSync(runsParent)
    .map((name) => path.join(runsParent, name))
    .filter((abs) => {
      if (path.resolve(abs) === absoluteExclude) return false;
      try {
        const stat = fs.statSync(abs);
        return stat.isDirectory() && stat.mtimeMs >= cutoffMs;
      } catch {
        return false;
      }
    })
    .sort()
    .slice(-TELEMETRY_RUN_CAP);
}

function readJsonSafe<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Did a reviewer leave any explicit signal on this page approval object? */
function hadExplicitFeedback(
  pageApproval: ApprovalsDoc['pages'][string] | undefined,
  gapId: string | undefined,
  complianceKey: string | undefined,
): boolean {
  if (!pageApproval) return false;
  if (Array.isArray(pageApproval.comments) && pageApproval.comments.length > 0) {
    return true;
  }
  // Per-finding decisions on this fingerprint count as feedback.
  if (gapId && pageApproval.gaps?.[gapId]) return true;
  if (complianceKey && pageApproval.complianceFindings?.[complianceKey]) return true;
  // A page-level skip on a page that had this finding also counts — the
  // reviewer chose to bypass everything on that page, which is feedback.
  if (pageApproval.decision === 'skip') return true;
  return false;
}

/**
 * Walk N prior runs in `runsParent` (excluding the current run) and
 * tally how many of them contain each fingerprint, plus whether any
 * of them had explicit reviewer feedback on that fingerprint.
 */
export function loadTelemetrySignals(
  runsParent: string,
  currentRunDir: string,
): TelemetrySignals {
  const occurrenceCount = new Map<string, number>();
  const hadFeedback = new Set<string>();

  const priorRuns = listEligibleRunDirs(runsParent, currentRunDir);
  if (priorRuns.length === 0) return { occurrenceCount, hadFeedback };

  for (const runDir of priorRuns) {
    const pagesDir = path.join(runDir, 'pages');
    if (!fs.existsSync(pagesDir)) continue;

    const approvals = readJsonSafe<ApprovalsDoc>(path.join(runDir, 'approvals.json'));

    let slugs: string[];
    try {
      slugs = fs.readdirSync(pagesDir).filter((s) => {
        try { return fs.statSync(path.join(pagesDir, s)).isDirectory(); } catch { return false; }
      });
    } catch {
      continue;
    }

    // Within a single run, a fingerprint is counted once — re-occurrence
    // is about runs, not pages-within-a-run.
    const seenInThisRun = new Set<string>();

    for (const slug of slugs) {
      const pageApproval = approvals?.pages?.[slug];
      const pageDir = path.join(pagesDir, slug);

      const audit = readJsonSafe<{ gaps?: unknown[] }>(path.join(pageDir, 'audit.json'));
      for (const raw of audit?.gaps ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        const gap = raw as {
          id?: string;
          dimension?: string;
          category?: string;
          description?: string;
          plain?: string;
        };
        const fp = gapFingerprint(slug, gap);
        seenInThisRun.add(fp);
        if (hadExplicitFeedback(pageApproval, gap.id, undefined)) {
          hadFeedback.add(fp);
        }
      }

      const compliance = readJsonSafe<{ findings?: unknown[] }>(
        path.join(pageDir, 'compliance.json'),
      );
      for (const raw of compliance?.findings ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        const f = raw as { ruleId?: string; location?: string };
        const fp = complianceFingerprint(slug, f);
        seenInThisRun.add(fp);
        const key = `${f.ruleId}::${f.location}`;
        if (hadExplicitFeedback(pageApproval, undefined, key)) {
          hadFeedback.add(fp);
        }
      }
    }

    for (const fp of seenInThisRun) {
      occurrenceCount.set(fp, (occurrenceCount.get(fp) ?? 0) + 1);
    }
  }

  return { occurrenceCount, hadFeedback };
}
