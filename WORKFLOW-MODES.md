# Workflow modes — review gate, real-env, read-only exercise

Added 2026-05-18. Extends the pipeline with an approval-gated, two-pass workflow
and the ability to point at a real, fully-configured installation.

## `--apply-mode review` — the approval gate

A first pass that runs **only the four review agents** (audit, ux, design,
compliance) on **every screen**, skips code+verify, and writes one consolidated
`runs/<run>/proposed-changes.md` aggregating every screen's findings.

```
node dist/cli.js rebuild <target> --apply-mode review
# read + edit runs/<run>/proposed-changes.md, then:
node dist/cli.js rebuild <target> --resume runs/<run> --apply-mode pr
```

The apply pass resumes the same run: audit/ux/design/compliance are already
`done` (their results are reloaded from each page's `*.json`), so only Agent 4
(code) + Agent 5 (verify) run — against exactly the feedback you approved.

## `--real-env` — point at an existing installation

Boot gate preserves the target's real `.env.local` instead of writing safe
stubs. Use when the app must reach real Supabase/data so the audit sees real
content. `--real-env` implies `--read-only`.

## `--read-only` — read-only browser exercise

`PageDriver.exercise()` still focuses inputs and clicks navigation, but skips
any button/link whose label matches a destructive pattern (delete, remove,
send, pay, submit, save, sign out, …) and any `type=submit`. Prevents real
mutations/emails/charges when driving a live backend.

## Implementation notes

- `ApplyMode` gained `'review'`; `PipelineConfig` gained `realEnv` +
  `readOnlyExercise`.
- Resume now reloads each done agent's `*.json` into `AgentContext` (was a bug:
  resumed runs passed `undefined` upstream results to code/verify).
- Boot gate always re-runs on resume — scratch is deleted at run end, so a
  cached `boot.json` baseUrl points at a dead server.

## Not yet built — auth login (`loginAs`)

Auth-gated screens still audit as anonymous. Real-env makes login *possible*;
the `loginAs` form-fill (per `RERUN-CASESDAILY-PROMPT.md`) is the next step.
