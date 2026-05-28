# Reframe agent fixtures

Hand-curated `(input, expected-output)` pairs for each agent.

The eval harness is **deliberately not built here yet** — that's a v2 concern that needs scale to justify. What lives in this directory is the v1-appropriate version: a **shared fixture format**, a **structural validator** that catches malformed fixtures, and a **few canonical examples per agent** that double as contributor documentation.

When the eval harness lands (v2), it will read these same fixtures, call the real agent against each `input`, and score outputs against the `expected` block. Today, fixtures are reference data and shape tests. That's enough.

## Layout

```
tests/fixtures/
  README.md            ← you are here
  validate.ts          ← `npm run check-fixtures` — structural validator (no LLM calls)
  audit/               ← Agent 1 fixtures
    01-*.json
    02-*.json
    ...
  compliance/          ← Agent 6 fixtures
    01-*.json
    ...
```

One JSON file per fixture. The number prefix is for stable ordering — start new fixtures at the next free number, don't renumber.

## Fixture format

Every fixture is one self-describing JSON document:

```jsonc
{
  "name": "broken-submit-button",
  "agent": "audit",
  "description": "Submit button mounted with a removed handler — clicking does nothing, console logs a TypeError.",

  "input": {
    // The minimum slice of AgentContext the agent reads.
    // For audit: page, snapshot, interactions, consoleErrors, health.
    // For compliance: page, source (line-numbered), matchedRules.
    "page": { "slug": "...", "route": "...", "filePath": "...", "purpose": "...", "userFunction": "...", "dataDependencies": [], "libraries": [] },
    "snapshot": "...",
    "interactions": ["click: Submit", "..."],
    "consoleErrors": ["[console.error] TypeError: ..."],
    "health": { "status": "ok", "healthy": true, "finalUrl": "...", "detail": "..." }
  },

  "expected": {
    // The full agent output if a future eval calls the real LLM and
    // wants something to diff against. NOT a verbatim equality target —
    // some fields will vary (exact wording, ordering). Use `assertions`
    // for hard checks.
    "gaps": [ /* … */ ]
  },

  "assertions": [
    // Loose checks the eval harness will enforce. Each assertion is one
    // of the kinds below. Designed to survive prompt tweaks: don't pin
    // exact wording unless that's what you're testing.
    { "kind": "minFindings", "value": 1 },
    { "kind": "severityAtLeast", "id": "g1", "value": "high" },
    { "kind": "fieldPresent", "id": "g1", "path": "plain" },
    { "kind": "fieldPresent", "id": "g1", "path": "whyItMatters" },
    { "kind": "confidenceAtLeast", "id": "g1", "value": 0.7 },
    { "kind": "dimensionIn", "id": "g1", "values": ["functional", "ux"] }
  ]
}
```

### Assertion kinds

| Kind | Meaning |
| --- | --- |
| `minFindings` / `maxFindings` | Total number of `gaps` / `findings` in the output. |
| `noFindings` | Output array is empty (clean fixtures). |
| `severityAtLeast` | The named finding's severity ≥ the value (critical > high > medium > low). |
| `severityEquals` | Exact severity match. |
| `categoryEquals` | Exact category match (audit only — `functional` or `ux`). |
| `dimensionIn` | The finding's dimension is one of the listed values. |
| `fieldPresent` | The named JSON path on the finding is a non-empty string / number. |
| `confidenceAtLeast` | DEPRECATED — confidence float ≥ the threshold. Prefer `tierAtLeast`. |
| `mentionsAny` | The combined text fields (`description` / `plain` / `whyItMatters` / `recommendation`) contain at least one of the listed substrings (case-insensitive). |
| `signalsInclude` | (ADR-0001) The finding's `signals` array includes every signal id in `values`. Known signals: `severity-critical`, `browser-evidence`, `broken-contract`, `cross-agent-agreement`, `multi-persona-agreement`, `persistent-across-runs`, `a11y-rule-violation`, `auth-or-billing-surface`, `explicit-user-feedback`. |
| `tierAtLeast` | (ADR-0001) The finding's `confidenceTier` ≥ value (`low` < `medium` < `high`). Falls back to bucketing `signals.length` when `confidenceTier` is absent. |

`id` is the agent-emitted id (`g1`, `g2`, …) for audit gaps, or the `ruleId` for compliance findings. Use `"any"` to match any finding.

## Adding a new fixture

1. Pick the agent it tests. Drop a JSON file under `tests/fixtures/<agent>/`.
2. Give it a stable name and the next free number.
3. Write the `input` slice using real data shapes (see existing fixtures).
4. Write the `expected` output as a realistic agent emission. This is the documentation: contributors read it to learn what the agent should produce.
5. Write **assertions you'd actually want to keep** when prompt wording shifts. Don't pin "the description equals this exact string" — pin "the finding mentions the broken submit handler" or "severity is at least high".
6. Run `npm run check-fixtures` to confirm the shape is valid.
7. Commit the fixture alongside the change that motivated it.

Bug reports become fixtures. Every time a user files an issue saying "this finding was wrong" or "this should have been caught and wasn't" — convert it to a fixture in the same PR that fixes the prompt.

## What this is NOT (yet)

- **Not a test harness.** No LLM calls happen here. `validate.ts` only checks shapes.
- **Not a metric.** No precision/recall scoring. v2 territory.
- **Not a CI gate.** Don't block merges on these in v1.

When you have ~25 fixtures across the agents and a usage pattern starts to emerge — that's the right moment to build the harness around them. Until then, the fixtures are docs that travel with the prompts.
