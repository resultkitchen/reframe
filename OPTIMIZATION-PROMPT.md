# Optimization prompt — paste into a fresh Claude Code context

Run from `C:\projects\rebuild-pipeline`.

---

Execute the review-output optimization for the rebuild-pipeline. The full
phased plan is already written — **read these first, in order:**

1. `OPTIMIZATION-PLAN.md` — the approved plan (Phases 0–5). This is your spec.
2. `.wolf/cerebrum.md` — Decision Log + Do-Not-Repeat. Respect every entry.
3. `RETROSPECTIVE.md`, `WORKFLOW-MODES.md` — pipeline context.
4. `FIX-MAPPER-PROMPT.md` — the exact Phase 0 task.
5. `.wolf/anatomy.md` — file map; check it before reading any file.

This is an OpenWolf project — follow `.wolf/OPENWOLF.md`: update `anatomy.md`
after file changes, append to `.wolf/memory.md`, log bugs to
`.wolf/buglog.json`, update `cerebrum.md` when you learn something.

## What to build

Implement Phases 0–5 from `OPTIMIZATION-PLAN.md`. Summary:

- **Phase 0** — Fix Stage 0 mapper over-scoping (do exactly what
  `FIX-MAPPER-PROMPT.md` says). ~85% output-size cut.
- **Phase 1** — Split `proposed-changes.md` into a slim approval gate +
  per-page `pages/<slug>/review.md` (progressive disclosure).
- **Phase 2** — Add `runs/<run>/approvals.json` as the real approval contract;
  the apply pass honors per-page / per-gap `apply`|`skip`. Absent file ⇒
  apply-all (backward compatible).
- **Phase 3** — Agent 2 emits a structured `layout` tree; agents 3 & 4 consume
  `layout`, not ASCII; `asciiWireframe` stays human-only. Older run dirs
  without `layout` must still load.
- **Phase 4** — Cheap-model routing (ux/design → GLM-4.7 / Llama-3.3-70B-Groq;
  audit/compliance/verify/code stay capable); trim the repeated library
  inventory; add a `Dockerfile` for the pipeline targeting Cloud Run Jobs.
- **Phase 5** — `rebuild review <runDir>`: a localhost Node server + React +
  Vite + Tailwind SPA over a `ReviewStore` interface (`FilesystemReviewStore`
  now). Approver / Developer / Designer role views. Commit the built bundle.

Phases 0–2 gate the rest. 3–4 can run parallel to 5. The hosted tier is
**Google Cloud only** (Cloud Run Jobs engine, Cloud Run API, Firebase Hosting,
Cloud Storage, Firestore, Firebase Auth) — Phases 0–5 do NOT build it but must
be designed toward it (Dockerfile targets Cloud Run; `ReviewStore` keeps a
`GcsReviewStore` impl viable). See `OPTIMIZATION-PLAN.md` "Hosted tier".

## Verify before claiming done

- Phase 0: `runs/<run>/scope.md` lists ~30–40 pages, no `/api/*`, real `/`.
- Phase 1: a fresh review run's `proposed-changes.md` is a slim gate
  (~hundreds of lines, not ~19k); per-page `review.md` files exist.
- Phase 2: an apply pass with an `approvals.json` that skips a page does NOT
  code that page; absent file still applies all.
- Phase 3: agents 3/4 prompts contain `layout`, not ASCII; a run dir without
  `layout` still loads.
- Phase 5: `node dist/cli.js review <runDir>` opens a working localhost app
  with the three role views; "Apply approved" writes `approvals.json`.

`npm run build` clean after each phase. Commit each phase on `master` and
push (push = deploy). Log any bug fixed to `.wolf/buglog.json`.

Work autonomously end-to-end. Disk discipline: scratch is unique per run and
cleaned on exit. The Bash tool's cwd persists between calls — use absolute
paths or reset cwd.
