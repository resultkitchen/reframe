# ADR-0003 — `reframe autoresearch` autonomous loop

**Status:** Proposed — v0.4 candidate
**Date:** 2026-05-28
**Driver:** Methodological review of `withkynam/vibecode-pro-max-kit` `vc-autoresearch` skill (which itself credits Udit Goenka, MIT).

## Context

Today Reframe runs once per invocation. You point it at a repo, it audits, it opens a PR, it exits. There is no built-in mode that says "keep iterating until a measurable metric clears a threshold." Users who want that build it themselves — see the eval-loop prompt we wrote in the v0.2 release notes, which is a hand-rolled version of what should be a first-class subcommand.

The vibecode-pro-max-kit `vc-autoresearch` skill formalizes this as an 8-phase loop with a clean contract:

```
Goal       — human description
Scope      — glob of editable files
Verify     — shell command that outputs ONE number
Guard      — shell command (exit 0 = no regression)
Direction  — higher | lower (which way is better)
Iterations — cap
Noise      — low/medium/high (variance tolerance)
Min-Delta  — smallest change that counts as progress
```

Eight phases per iteration, with rules that we keep re-deriving the hard way: commit BEFORE verify (git is memory, not safety net), one atomic change per iteration (sentence with no "and"), prefer `git revert` over `git reset`, stop after 5 consecutive discards (pivot) or 10 (halt).

Reframe has the perfect host metric for this: `npm run eval` already prints a pass-count line we can extract. Our build/test/check-fixtures green-quad is the natural guard.

## Decision

Ship `reframe autoresearch` as a subcommand in v0.4. It's a thin runtime over the existing engine — Reframe's job isn't to be a generic autoresearch tool, but to expose the audit pipeline as a loop target.

### Two modes

1. **`reframe autoresearch --internal`** — applied to the Reframe repo itself. Goal: increase eval coverage / drive fixture count up / drive eval assertion fail-count to zero. Scope: `tests/fixtures/**`, `src/agents/**`. Verify: `npm run eval | tail -1 | grep -oE '[0-9]+/[0-9]+' | awk -F/ '{print $1}'`. Guard: `npm run build && npm test && npm run check-fixtures`.
2. **`reframe autoresearch --target <repo>`** — applied to a downstream repo. Goal: drive a specific audit-finding count down across iterations. Scope: that repo's source. Verify: `reframe rebuild <repo> --apply-mode propose --json-summary | jq '.audit.criticalCount'`. Guard: `npm test` in the target repo.

### CLI surface

```bash
reframe autoresearch \
  --goal "Drive critical audit findings to zero" \
  --scope "src/**/*.{ts,tsx}" \
  --verify "reframe rebuild . --apply-mode propose --json-summary | jq -r '.audit.criticalCount'" \
  --guard "npm run build && npm test" \
  --direction lower \
  --iterations 15 \
  --min-delta 1 \
  --noise low
```

Configurable via `config/autoresearch.json` for reproducibility:

```json
{
  "goal": "...",
  "scope": ["src/**/*.ts"],
  "verify": "...",
  "guard": "...",
  "direction": "lower",
  "iterations": 15,
  "minDelta": 1,
  "noise": "low",
  "stuckPivotAfter": 5,
  "stuckStopAfter": 10
}
```

### The loop, restated for Reframe

```
Phase 0  Preconditions
  - clean working tree (or --allow-dirty)
  - on a named branch (or --create-branch reframe/autoresearch-<stamp>)
  - dry-run --verify command; exit 0 and parses as number
  - dry-run --guard command; exit 0
  - write baseline to runs/<stamp>/autoresearch.tsv

Phase 1  Review
  - read autoresearch.tsv
  - read last 20 commits
  - feed both into the planner prompt

Phase 2  Ideate (LLM call)
  - planner picks ONE atomic change
  - atomicity check: sentence has no "and"
  - reject if the same file+approach was tried in the last 3 iterations

Phase 3  Modify
  - delegate to Agent 4 (code) constrained to --scope
  - never modify files referenced by --guard (resolved by reading the guard cmd)

Phase 4  Commit
  - git add <changed files>
  - git commit -m "autoresearch(iter-N): <one-line description>"

Phase 5  Verify
  - run --verify; capture stdout last line as number
  - 30s timeout
  - crash matrix:
      exit 0, number     → proceed
      exit 0, no number  → log no-number, revert, fix is a manual issue
      exit non-zero      → log verify-crash, revert, discard
      timeout            → log timeout, abort loop, surface

Phase 5.5  Guard
  - run --guard; exit 0 or revert+rework (max 2 attempts) then discard

Phase 6  Decide
  Direction=higher: KEEP if delta ≥ min-delta && guard passed
  Direction=lower:  KEEP if delta ≤ -min-delta && guard passed
  else: DISCARD (git revert HEAD --no-edit)

Phase 7  Log
  - append TSV: iter \t commit \t metric \t delta \t status \t description
  - update consecutive-discard counter

Phase 8  Decide-next
  - 5 consecutive discards → emit "PIVOT" event, force planner to switch file/approach
  - 10 consecutive discards → STOP with summary
  - iteration ≥ Iterations → STOP with summary
```

### Output

`runs/<stamp>/autoresearch.tsv` — append-only, machine-parseable:

```
0  a1b2c3d  7   -      baseline  baseline
1  e4f5a6b  6   -1     keep      add browser-evidence signal to agent1 normaliser
2  -        7   +1     discard   extracted helper; metric flipped (revert clean)
3  f1e2d3c  5   -1     keep      remove duplicate finding when broken-contract present
...
```

Plus `runs/<stamp>/autoresearch.json` — final summary, used by the PR body when the loop terminates on a green delta.

## Consequences

**Positive**
- Reframe gains an explicit "self-tuning" mode without forking the engine. Every existing flag still works inside the loop.
- The release loop ("ship the green-quad on every commit") becomes a literal autoresearch run: `--metric build-test-eval-passes --direction higher`.
- We can finally answer "did the v0.3 prompts make Agent 1 *better*?" with a TSV instead of vibes.
- The MIT-credited adapted protocol gives us a clear lineage and avoids reinventing.

**Negative**
- Adds a code-generating loop to a verification engine. The product positioning needs care: Reframe still *outputs PRs*, but in autoresearch mode it also *makes commits during the loop*. Users must consent (`--allow-commits`).
- Cost discipline: each iteration is a full audit run. A 15-iteration loop on a 30-page app is 15× the LLM cost of a single audit. Mitigate with `--quick-scan` default in autoresearch mode, plus `--max-cost-usd` cap.
- Stuck detection is correct in spirit but the "5 discards → pivot" trigger relies on the planner LLM actually pivoting. If the planner is stupid, this regresses to "10 discards → halt." Acceptable.

## Implementation order

1. **`src/autoresearch/loop.ts`** — the 8-phase state machine, agnostic of Reframe specifics. Takes a config object, runs the loop, emits TSV. ~300 lines.
2. **`src/autoresearch/preconditions.ts`** — Phase 0 checks (clean tree, named branch, dry-runs).
3. **`src/autoresearch/planner.ts`** — Phase 2 planner. Reuses the existing `GeminiClient.callJsonSchema()`. Schema: `{ description: string, targetFile: string, approach: string }`. Asks the model to honour the no-repeat-same-(file,approach) rule.
4. **`src/cli.ts`** — add the `autoresearch` subcommand. Reuse the existing argv parser.
5. **`config/autoresearch.template.json`** — default config for the `--internal` mode.
6. **`tests/fixtures/autoresearch/`** — fixtures for the planner's pivot behaviour. Three: clean baseline, 5-discard streak forces pivot, 10-discard streak halts.
7. **Docs:** `docs/AUTORESEARCH.md` with the contract + worked example. README link.

Depends on **ADR-0002** (agent status protocol): the loop's Phase 3 delegates to Agent 4, and the loop needs to read its `AgentStatus` to know whether to commit or skip. Without ADR-0002 the loop must rely on exit codes only, which is workable but coarser.

Doesn't depend on **ADR-0001** (signal-count confidence) but pairs well — autoresearch can use the signal count as a verify metric (`--verify "reframe rebuild . --json-summary | jq '.findings | map(select(.confidenceTier==\"high\")) | length'"`).

## Rejected alternatives

- **Ship as a separate package (`@resultkitchen/reframe-autoresearch`).** Splits the doc surface. The loop is small enough to keep in-tree.
- **Use a generic autoresearch runner externally (e.g. just embed `vc-autoresearch`).** Loses integration with Reframe's status protocol, run-dir conventions, telemetry, and resume ledger.
- **Skip the planner LLM, just shuffle a fixed list of mutations.** Doesn't generalise to user-provided goals.

## References

- vibecode-pro-max-kit: `.claude/skills/vc-autoresearch/SKILL.md` + 4 references files (MIT, credit: Udit Goenka)
- `src/orchestrator.ts` — the existing run loop, target for delegation in Phase 3
- `src/gemini.ts:callJsonSchema()` — reused for the planner
- ADR-0002 — provides the `AgentStatus` contract the loop reads
