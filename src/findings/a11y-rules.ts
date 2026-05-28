/**
 * a11y-rule-violation signal — ADR-0001 slice 5.
 *
 * A small, hand-curated table of WCAG 2.2 / axe-core rule ids paired
 * with the substrings that typically appear in Agent 1's accessibility
 * gap text (description / plain / recommendation / evidence). When a
 * gap with `dimension === 'accessibility'` matches any rule, the
 * orchestrator appends the `a11y-rule-violation` signal — the second
 * concrete signal needed to push an a11y finding from LOW to MEDIUM.
 *
 * This is deliberately small (~12 entries). The bar for adding a rule:
 *   1. It comes up at least 2× in real Reframe runs against client repos.
 *   2. The substring set is unambiguous enough that false positives are
 *      rare. We err toward false negatives — missing a rule is fine, the
 *      gap still ships as LOW; tagging the wrong rule confuses the
 *      reviewer.
 *
 * Source of rule ids: WCAG 2.2 Success Criteria + axe-core's rule names.
 */

export interface A11yRule {
  /** Canonical rule id — WCAG SC number or axe-core rule key. */
  id: string;
  /** Lower-cased substrings; ANY match against the gap text fires. */
  needles: readonly string[];
}

export const A11Y_RULES: readonly A11yRule[] = [
  // WCAG 1.1.1 Non-text Content — images / icons without alt or label.
  { id: 'wcag-1.1.1', needles: ['alt text', 'alt attribute', 'image-alt', 'missing alt'] },
  // WCAG 1.3.1 Info and Relationships — semantic structure / landmark misuse.
  { id: 'wcag-1.3.1', needles: ['heading order', 'heading hierarchy', 'landmark', 'semantic structure'] },
  // WCAG 1.4.3 Contrast (Minimum).
  { id: 'wcag-1.4.3', needles: ['color contrast', 'contrast ratio', 'low contrast'] },
  // WCAG 2.1.1 Keyboard — non-keyboard-reachable controls.
  { id: 'wcag-2.1.1', needles: ['keyboard accessible', 'keyboard reachable', 'not keyboard', 'tab order'] },
  // WCAG 2.4.4 Link Purpose (In Context).
  { id: 'wcag-2.4.4', needles: ['link text', 'link purpose', 'descriptive link', 'link-name'] },
  // WCAG 2.4.7 Focus Visible.
  { id: 'wcag-2.4.7', needles: ['focus visible', 'focus indicator', 'focus ring', 'focus outline'] },
  // WCAG 3.3.2 Labels or Instructions — unlabeled form controls.
  { id: 'wcag-3.3.2', needles: ['no associated label', 'no <label>', 'missing label', 'unlabeled', 'unlabelled', 'label or aria-label', 'label or instruction'] },
  // WCAG 4.1.2 Name, Role, Value — icon-only buttons, custom controls.
  { id: 'wcag-4.1.2', needles: ['no accessible name', 'accessible-name', 'icon-only button', 'button-name', 'aria-label', 'name, role, value'] },
  // WCAG 4.1.3 Status Messages — toasts/alerts not announced.
  { id: 'wcag-4.1.3', needles: ['aria-live', 'status message', 'not announced', 'screen reader'] },
  // axe-core duplicate-id — ids collide on the page.
  { id: 'axe-duplicate-id', needles: ['duplicate id', 'duplicate-id'] },
  // axe-core color-contrast (covered by 1.4.3 substring set, but useful as a direct axe id match).
  { id: 'axe-color-contrast', needles: ['axe color-contrast', 'color-contrast rule'] },
  // axe-core image-alt rule key.
  { id: 'axe-image-alt', needles: ['axe image-alt', 'image-alt rule'] },
];

/**
 * Concatenate every text-bearing field on a gap into one lower-cased
 * string. We check description + plain + recommendation + evidence
 * because the LLM scatters the WCAG-flavoured phrasing differently
 * depending on which persona raised the gap.
 */
function gapText(gap: {
  description?: string;
  plain?: string;
  recommendation?: string;
  evidence?: readonly string[];
}): string {
  const parts: string[] = [];
  if (typeof gap.description === 'string') parts.push(gap.description);
  if (typeof gap.plain === 'string') parts.push(gap.plain);
  if (typeof gap.recommendation === 'string') parts.push(gap.recommendation);
  for (const e of gap.evidence ?? []) {
    if (typeof e === 'string') parts.push(e);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Does this accessibility gap match any known WCAG / axe rule?
 * Returns the first matching rule id (caller only needs to know that
 * ≥1 matched in order to fire the signal). Returns null when nothing
 * matched — the gap stays at its existing trust tier.
 *
 * Non-accessibility gaps short-circuit to null at the call site;
 * this helper does not re-check dimension.
 */
export function matchA11yRule(gap: {
  description?: string;
  plain?: string;
  recommendation?: string;
  evidence?: readonly string[];
}): string | null {
  const text = gapText(gap);
  if (!text) return null;
  for (const rule of A11Y_RULES) {
    for (const needle of rule.needles) {
      if (text.includes(needle)) return rule.id;
    }
  }
  return null;
}
