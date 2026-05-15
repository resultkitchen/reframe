# BRAND_SPEC — pinning a brand so Agent 3 is deterministic

Agent 3 (design) turns each page's UX proposal into a concrete **visual**
spec. For that output to be reproducible across runs, Agent 3 must design
against a **fixed set of brand tokens** — not tokens it re-derives or
invents every time. That fixed set is the **pinned brand spec**.

This document explains the `BrandSpec` shape, the bootstrap → pin workflow,
and why pinning matters.

---

## The `BrandSpec` shape

Defined in `src/types.ts`. Templated in `config/brand.template.json`.

```ts
interface BrandSpec {
  name: string;
  colors: Record<string, string>;     // token -> hex
  typeScale: Record<string, string>;  // token -> "size/lineheight"
  spacing: Record<string, string>;    // token -> value
  radii?: Record<string, string>;     // token -> value (optional)
  voice: string;                      // brand voice / tone description
  componentStyle: string;             // component-level visual rules
  pinned: boolean;                    // true once an operator has reviewed it
}
```

### Field-by-field

| Field | Purpose | Example |
| ----- | ------- | ------- |
| `name` | Human label for the brand. | `"Acme SaaS"` |
| `colors` | Named color tokens → hex. Agent 3 may use **only** these names; it never picks raw hex. Include semantic tokens (`primary`, `surface`, `text`, `border`, `success`, `danger`) plus any hover/state variants. | `{ "primary": "#2563eb", "surface": "#ffffff" }` |
| `typeScale` | Named type steps → `"size/line-height"`. Covers display down to caption. Agent 3 sizes text only from these steps. | `{ "h1": "1.875rem/2.25rem", "body": "1rem/1.5rem" }` |
| `spacing` | Named spacing scale → values. All padding/margin/gap come from here. | `{ "sm": "0.5rem", "md": "1rem", "lg": "1.5rem" }` |
| `radii` | Named corner-radius tokens. Optional — omit for square-corner brands. | `{ "md": "0.5rem", "full": "9999px" }` |
| `voice` | Tone/voice description. Drives microcopy decisions (headings, button labels, empty states). | `"Clear, confident, plain-spoken. No hype."` |
| `componentStyle` | Component-level visual rules — surface treatment, shadow depth, density, how the accent color is used. | `"Flat surfaces, generous padding, one subtle shadow level."` |
| `pinned` | **The gate.** `false` = a raw bootstrap candidate. `true` = an operator has reviewed and frozen it. | `true` |

**Token-only rule.** Agent 3's `DesignSpec.brandTokensUsed` is the list of
token names it consumed. Every visual decision references a token from the
pinned brand — never a raw value. This is what makes a design diff-able and a
re-run reproducible.

---

## The bootstrap → pin workflow

A brand is an **input**, not something the pipeline invents per run. But the
very first time you point the pipeline at a repo, you do not yet have one.
That gap is closed by a two-step workflow.

### Step 1 — Stage 0 bootstraps a candidate

During mapping, Stage 0 inspects the target repo's design surface — Tailwind
config, CSS custom properties, design-token files, and representative
components — and derives a **candidate** `BrandSpec`. It is returned on the
scope doc as `ScopeDoc.bootstrappedBrand` and always has `pinned: false`.

If you start a run **without** a pinned brand, the orchestrator:

1. Writes that candidate to `runs/<run>/brand.resolved.json`.
2. Uses it for the run so the pipeline can still finish.
3. Prints a loud notice and records an **alert** in the manifest:
   the run is **non-deterministic** because the brand was bootstrapped, not
   pinned.

The run is valid — but a second run could derive slightly different tokens,
so Agent 3 output could drift.

### Step 2 — operator reviews and pins

To make the brand authoritative:

1. Open `runs/<run>/brand.resolved.json`.
2. Review every token — fix anything Stage 0 guessed wrong (off colors,
   missing states, an incomplete type scale). Tighten `voice` and
   `componentStyle` to how the brand should *actually* read.
3. Set `"pinned": true`.
4. Save it as a stable file — recommended `config/brand.json`.
5. Re-run with `--brand config/brand.json`.

On that run the orchestrator detects a pinned brand (`brandPath` exists and
`pinned: true`), uses it verbatim, copies it into `brand.resolved.json`, and
prints `brand: PINNED` — **no** non-determinism alert.

```bash
# First run — bootstraps, warns
pipeline rebuild https://github.com/acme/app

# Review runs/acme-app-<stamp>/brand.resolved.json,
# set "pinned": true, save as config/brand.json

# Every run after — deterministic
pipeline rebuild https://github.com/acme/app --brand config/brand.json
```

A pinned brand only changes when an operator deliberately edits it. It is
otherwise frozen.

---

## Why a pinned brand makes Agent 3 deterministic

Agent 3 is an LLM call. Its visual decisions are reproducible **only when its
inputs are fixed**. The page's UX proposal (from Agent 2) is derived from the
page itself, so it is stable. The brand is the other input — and if it is
re-derived every run, it becomes a moving input.

| | Unpinned (bootstrap) | Pinned brand |
| --- | --- | --- |
| Token source | Re-derived by Stage 0 each run | Frozen file, identical every run |
| Agent 3 input | Varies run to run | Constant |
| Design output | May drift (different shades, spacing) | Stable, diff-able |
| Code diffs (Agent 4) | Noisy — visual churn unrelated to gaps | Limited to real fixes |
| Manifest | Carries a non-determinism alert | Clean |

Pinning collapses one whole axis of variation. With the brand frozen:

- **Re-runs are comparable.** Two runs of the same repo produce the same
  design spec, so verify/regression results mean something.
- **Diffs stay honest.** Agent 4 changes reflect closed gaps, not a brand
  token that shifted by a few percent.
- **The brand is reviewable once.** A human signs off on the tokens a single
  time; every subsequent run inherits that decision.

> **Rule of thumb:** treat the first run as *brand discovery*. Pin the brand
> from its output, then treat every later run as a real rebuild.

---

## Related

- `config/brand.template.json` — copy-and-edit starting point.
- `src/types.ts` — the authoritative `BrandSpec` definition.
- `docs/MODULE-API.md` — `loadBrand()` and the Agent 3 contract.
- `README.md` — brand/constraints pinning overview.
