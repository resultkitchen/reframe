# ADR-0002 — Four-state agent status protocol

**Status:** Proposed — v0.3 candidate
**Date:** 2026-05-28
**Driver:** Methodological review of `withkynam/vibecode-pro-max-kit` orchestration protocol.

## Context

Today Reframe's per-page outcome is computed by `orchestrator.ts:deriveOutcome()` and reduces to one of: `boot-failed`, `drive-failed`, `audited`, `verified`. The PASS/FAIL gate (`runPipeline` near line 690) then collapses these further to a single `pass: boolean`.

This is a two-state machine pretending to be a verifier. It conflates four distinct situations:

| Real situation | Today's outcome | What the orchestrator should do |
|---|---|---|
| Agent ran clean, no gaps, browser drive ok | `pass: true` | move on |
| Agent ran clean, gaps were found but a review-mode pass is in progress | `pass: true` (no smoking guns) | move on, emit findings |
| Agent ran but produced output the next agent can't act on (e.g. UX libs empty when audit demanded them) | `pass: true` silently | retry once with the missing context fed back |
| Agent could not run at all (rate-limited / missing input / target unreachable) | `pass: false`, run aborts | surface to user, do not retry the same thing |

The vibecode-pro-max-kit orchestration protocol nails this:

```
DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
```

With explicit controller rules: never ignore BLOCKED/NEEDS_CONTEXT, never retry the same blocked approach 3×, treat correctness concerns as action items.

## Decision

Every Reframe agent (Stage 0 mapper, Stage 0.5 boot, Agents 1–6, Final scaffold) returns an `AgentStatus` discriminated union:

```ts
type AgentStatus =
  | { kind: 'done' }
  | { kind: 'done-with-concerns'; concerns: AgentConcern[] }
  | { kind: 'blocked'; reason: BlockReason; retryable: boolean }
  | { kind: 'needs-context'; missing: string[] };

type AgentConcern = {
  severity: 'low' | 'medium' | 'high';
  message: string;
  // If the next agent can still proceed, set actionable=false.
  // If the next agent should refuse to start, set actionable=true.
  actionable: boolean;
};

type BlockReason =
  | 'rate-limited'      // LLM quota exhausted; retryable after delay
  | 'auth-expired'      // login cookies stale; not retryable without --auth re-run
  | 'target-unreachable' // dev server crashed mid-run; retryable
  | 'invalid-config'    // bad brand pin or constraints schema; not retryable
  | 'budget-exceeded';  // run hit --max-pages or --cost-cap; not retryable
```

The orchestrator's per-agent status feeds a small state machine:

```
done                  → next agent
done-with-concerns    → next agent, log concerns to manifest, surface in PR body
blocked + retryable   → backoff + retry once; if still blocked, propagate to user
blocked + !retryable  → abort that page only (not the pool); record reason; user-facing
needs-context         → orchestrator tries to fill (e.g. re-run upstream agent); if can't, propagate
```

Stop-rules:

- **3-strike rule**: the same agent on the same page may not return the same `blocked` reason 3× in a single run. If it does, the page is recorded as `aborted: blocked-loop` and excluded from PASS counts.
- **Concern budget**: a page accumulating ≥ 5 `done-with-concerns` results across its agents is escalated to `needs-human-review` regardless of individual outcomes.
- **NEEDS_CONTEXT bounce**: if Agent N declares `needs-context` for a field that Agent M < N already produced, the orchestrator re-runs Agent M with an enriched prompt; if Agent M re-runs and still doesn't fill the field, the page is `aborted: context-loop`.

## Consequences

**Positive**
- The current "silent PASS with garbage UX proposal because library inventory was empty" failure mode disappears — Agent 2 declares `needs-context: ['libraryInventory']` and the orchestrator handles it.
- The PR body can now distinguish "audited cleanly" from "audited with concerns" from "couldn't audit, here's why" — three things that look identical in v0.2.
- Rate-limit recovery becomes a first-class feature instead of a thrown exception bubbling up from `gemini.ts`.
- The review-app gains a fourth column on the Run Overview: outcome class (clean / concerns / blocked / no-context) instead of a binary check.

**Negative**
- Every agent file changes signature. Today they return `Promise<Gap[]>` or `Promise<UxProposal>` etc. Now they return `Promise<{ result: T; status: AgentStatus }>`. That's invasive.
- `RunState` checkpoint format gets a new field per agent. Existing run dirs are forward-compatible (the new field is optional in the schema) but resume-loading older runs treats missing status as `done`.
- Fixture format change: every fixture must declare an `expectedStatus` so the assertion harness can check the status path, not just the output shape.

## Implementation order

1. **Types first.** Add `AgentStatus`, `AgentConcern`, `BlockReason` to `src/types.ts`. Don't wire them yet.
2. **Status helpers.** `src/agents/status.ts` with `done()`, `concerns(...)`, `blocked(reason, retryable)`, `needsContext(missing)` constructors. Plus a `mergeStatus()` for combining multi-step agent runs.
3. **One agent at a time.** Start with Agent 5 (Verify) — its existing `pass: boolean` return maps cleanly to `done` (pass) vs `done-with-concerns` (regressions present) vs `blocked` (couldn't drive page). Each subsequent agent gets converted in its own commit.
4. **Orchestrator state machine.** Replace the `pass: boolean` gate at `runPipeline` line ~690 with the matrix above. Keep `pass` derivable from status for one release.
5. **RunState schema bump.** Add `agentStatus: Record<AgentName, AgentStatus>` to the per-page state. Bump `stateVersion` and add a one-shot loader for v1 → v2.
6. **Fixture spec.** Add `expectedStatus: AgentStatus` to fixture format; extend `validate.ts` and `eval/run.ts` to assert it. Migrate the 9 existing fixtures (all become `expectedStatus: { kind: 'done' }`).
7. **Review-app: outcome column** on Run Overview; status badges in finding cards.
8. **PR body language.** `proposed-changes.md` and the PR body sections gain a "Pages with concerns" subsection. The Founder Digest only counts `done` and `done-with-concerns:actionable=false` toward the headline.

## Rejected alternatives

- **Keep `pass: boolean`, add a `concerns` side-channel.** Tried mentally — concerns get ignored at the boundary. The point of the four states is that the orchestrator can't accidentally treat BLOCKED as PASS.
- **Use exit codes only.** Loses the `concerns` content. The orchestrator needs both shape (which state) and payload (what to do about it).
- **Use error types (throw).** Convolutes the happy path. Errors should remain for `gemini.callJsonSchema` failures *inside* an agent; the status return is the agent's deliberate report.

## References

- `src/orchestrator.ts:deriveOutcome()` — the current 4-value enum (different concept; outcome describes the page, status describes the agent run)
- `src/orchestrator.ts:detectSmokingGuns()` — already produces the kind of evidence the new `concerns` field carries
- vibecode-pro-max-kit: `process/development-protocols/orchestration.md` § Subagent Status Protocol
- Depends on ADR-0001 only loosely — the two can ship in either order; together they're stronger.
