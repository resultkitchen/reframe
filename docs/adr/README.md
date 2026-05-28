# Architecture Decision Records

Short, dated rationales for non-obvious choices. Each ADR captures *why* a decision was made and *what we considered and rejected* — not just what got built. Future-you reads these to understand the load-bearing assumptions.

Format: numbered, kebab-case, `NNNN-title.md`. Status moves `Proposed → Accepted → Superseded`.

## Index

| # | Title | Status | v |
|---|---|---|---|
| [0001](0001-signal-count-confidence.md) | Signal-count confidence | Proposed | v0.3 |
| [0002](0002-agent-status-protocol.md) | Four-state agent status protocol | Proposed | v0.3 |
| [0003](0003-autoresearch-loop.md) | `reframe autoresearch` autonomous loop | Proposed | v0.4 |

## Adding an ADR

1. Pick the next free number.
2. Copy the structure of an existing ADR: Status / Date / Driver, Context, Decision, Consequences (positive + negative), Implementation order, Rejected alternatives, References.
3. Add a row to the index above.
4. Commit with `docs(adr): add ADR-NNNN — <title>`.

ADRs are checked into the repo. They do not get edited in place once `Accepted` — supersede with a new ADR instead.
