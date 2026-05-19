/**
 * Auth-aware auditing support.
 *
 * - `loadAuthConfig` reads + validates an `--auth <path>` JSON file.
 * - `matchAuthRole` decides which role (if any) a page route should be
 *   audited logged in as.
 *
 * The actual login (form-fill in a real browser) lives in `PageDriver.loginAs`
 * — see `src/browser.ts`. Agents 1 & 5 call `matchAuthRole` then `loginAs`.
 */

import * as fs from 'node:fs';

import type { AuthConfig, AuthRole } from './types';

/* ───────────────────────── load + validate ───────────────────────── */

/** Throw if `value` is not a non-empty string; return it trimmed otherwise. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`auth config: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

/** Parse + validate one role entry. */
function parseRole(raw: unknown, index: number): AuthRole {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`auth config: roles[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const patterns = Array.isArray(r.routePatterns)
    ? r.routePatterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
  if (patterns.length === 0) {
    throw new Error(
      `auth config: roles[${index}].routePatterns must be a non-empty string[]`,
    );
  }
  return {
    role: requireString(r.role, `roles[${index}].role`),
    email: requireString(r.email, `roles[${index}].email`),
    password: requireString(r.password, `roles[${index}].password`),
    routePatterns: patterns.map((p) => p.trim()),
  };
}

/**
 * Load + validate an auth config from `authPath`. Throws a clear error on a
 * missing file or malformed shape — the caller (resolveConfig) surfaces it.
 */
export function loadAuthConfig(authPath: string): AuthConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, 'utf8');
  } catch {
    throw new Error(`auth config: could not read file at ${authPath}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `auth config: ${authPath} is not valid JSON — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) {
    throw new Error(`auth config: "roles" must be a non-empty array`);
  }

  const postLoginWaitMs =
    typeof parsed.postLoginWaitMs === 'number' && parsed.postLoginWaitMs >= 0
      ? parsed.postLoginWaitMs
      : 5000;

  return {
    loginUrl: requireString(parsed.loginUrl, 'loginUrl'),
    emailSelector: requireString(parsed.emailSelector, 'emailSelector'),
    passwordSelector: requireString(parsed.passwordSelector, 'passwordSelector'),
    submitSelector: requireString(parsed.submitSelector, 'submitSelector'),
    postLoginWaitMs,
    roles: parsed.roles.map((r, i) => parseRole(r, i)),
  };
}

/* ───────────────────────── route matching ───────────────────────── */

/**
 * Does `route` match `pattern`? Patterns support `*`:
 *   - no `*`        → exact match
 *   - ends `/*`     → matches the bare prefix and any sub-path
 *                     ('/admin/*' matches '/admin' and '/admin/leads')
 *   - other `*`     → glob, `*` matches any run of non-query chars
 */
function routeMatches(route: string, pattern: string): boolean {
  const r = route.split(/[?#]/)[0];
  const p = pattern.trim();
  if (!p.includes('*')) return r === p;
  if (p.endsWith('/*')) {
    const prefix = p.slice(0, -2);
    return r === prefix || r.startsWith(`${prefix}/`);
  }
  const re = new RegExp(
    `^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^?#]*')}$`,
  );
  return re.test(r);
}

/**
 * The first role whose `routePatterns` match `route`, or `undefined` for a
 * public page (no login needed).
 */
export function matchAuthRole(
  route: string,
  auth: AuthConfig,
): AuthRole | undefined {
  for (const role of auth.roles) {
    if (role.routePatterns.some((pattern) => routeMatches(route, pattern))) {
      return role;
    }
  }
  return undefined;
}
