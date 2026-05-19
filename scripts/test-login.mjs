#!/usr/bin/env node
/**
 * Login smoke test — the lasting guard that auth-aware Playwright login works.
 *
 * For each role in an auth config, it drives the app's real login form (via
 * PageDriver.loginAs) and asserts the login actually succeeded — i.e. the
 * post-login redirect left the login page. A failed login is a FAIL, not a
 * silent pass.
 *
 * The target app must already be running. Usage:
 *   npm run build
 *   node scripts/test-login.mjs --auth config/casesdaily-auth.json --base-url http://localhost:3001
 *
 * Exit code 0 = every role logged in; 1 = at least one role failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const browserPath = path.join(here, '../dist/browser.js');
const authPath = path.join(here, '../dist/auth.js');

if (!fs.existsSync(browserPath) || !fs.existsSync(authPath)) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const { PageDriver } = await import(url.pathToFileURL(browserPath).href);
const { loadAuthConfig } = await import(url.pathToFileURL(authPath).href);

const { values } = parseArgs({
  options: {
    auth: { type: 'string' },
    'base-url': { type: 'string' },
  },
  strict: false,
});

if (!values.auth || !values['base-url']) {
  console.error('Usage: node scripts/test-login.mjs --auth <path> --base-url <url>');
  process.exit(1);
}

const baseUrl = values['base-url'];
const authConfig = loadAuthConfig(path.resolve(values.auth));
const roles = Array.isArray(authConfig.roles) ? authConfig.roles : [];

if (roles.length === 0) {
  console.error(`Auth config "${values.auth}" has no roles.`);
  process.exit(1);
}

console.log(`[test:login] ${roles.length} role(s) against ${baseUrl}\n`);

let allPassed = true;

for (const role of roles) {
  const driver = await PageDriver.launch({ readOnly: true });
  // loginAs never throws — it returns { ok, detail }. The try/catch only
  // guards against an unexpected driver-level crash.
  let result = { ok: false, detail: 'login did not run' };
  try {
    result = await driver.loginAs(baseUrl, authConfig, role);
  } catch (err) {
    result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await driver.close();
  }

  if (!result.ok) allPassed = false;
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'} [${role.role}] — ${result.detail}`);
}

console.log(`\n[test:login] ${allPassed ? 'all roles logged in' : 'one or more roles FAILED'}`);
process.exit(allPassed ? 0 : 1);
