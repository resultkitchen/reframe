/**
 * auth-or-billing-surface signal — ADR-0001 slice 6.
 *
 * Path-based heuristic that tags any finding sitting on a high-risk
 * surface — auth, login, billing, checkout, payment, schema migrations,
 * deploy / infra. These are the surfaces where a wrong fix gets a
 * person locked out or charged twice, so they deserve an extra unit
 * of trust regardless of how loud Agent 1's prose is.
 *
 * Intentionally a free-standing helper instead of a method on PageScope
 * — Agent 6 (compliance) findings carry a `location` independent of
 * the page; the same matcher consumes both `page.filePath` and the
 * compliance finding's `location` so the signal fires consistently
 * across both finding shapes.
 *
 * Pattern-match only — no AST inspection, no LLM, no live request.
 * False positives on this signal are cheap (one extra unit of trust);
 * false negatives are the failure mode we'd notice (a critical
 * checkout-page finding ranked below a brand-voice gap).
 */

/**
 * Lower-cased path substrings that identify a high-risk surface.
 * Ordered roughly by hit-rate in real Reframe runs: auth/login/sign-in
 * are the most common.
 */
const RISK_PATH_NEEDLES: readonly string[] = [
  '/auth/',
  '/auth.',
  '/login',
  '/logout',
  '/sign-in',
  '/signin',
  '/sign-up',
  '/signup',
  '/register',
  '/password',
  '/reset',
  '/billing',
  '/checkout',
  '/payment',
  '/pay/',
  '/subscribe',
  '/subscription',
  '/invoice',
  '/migration',
  '/migrations/',
  '/deploy',
  '/admin/',
];

/**
 * Normalise a path for matching: lower-case, replace backslashes with
 * forward slashes (so Windows `app\auth\page.tsx` matches the same
 * needles as POSIX), and ensure a leading slash so `/auth/` patterns
 * still hit at the root.
 */
function normalisePath(raw: string): string {
  const clean = raw.replace(/\\/g, '/').toLowerCase();
  return clean.startsWith('/') ? clean : '/' + clean;
}

/**
 * Does this path sit on a known risk surface?
 * Accepts any of: page filePath, page route, finding `location`
 * ("file:line" form is fine — the needle match ignores the colon
 * suffix because none of the needles contain a colon).
 */
export function isRiskSurface(path: string | undefined): boolean {
  if (!path) return false;
  const norm = normalisePath(path);
  for (const needle of RISK_PATH_NEEDLES) {
    if (norm.includes(needle)) return true;
  }
  return false;
}
