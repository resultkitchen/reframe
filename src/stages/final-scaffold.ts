/**
 * Final stage — Test scaffold.
 *
 * Infers the distinct user roles the app supports (admin / user / guest, …),
 * seeds a real account per role through the app's OWN signup/admin path
 * (external integrations are already stubbed by Stage 0.5, so this is
 * side-effect-free), and writes a numbered, non-technical test script per role.
 *
 * Output:
 *   runDir/test-scaffold/<role>-test-script.md   (one per role)
 *   runDir/test-scaffold/users.json              (the TestUser[] ledger)
 *
 * If the app won't start (`boot.status !== 'running'`) it still emits
 * credential-less script stubs and notes the limitation — never throws.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { GeminiClient } from '../gemini';
import type {
  BootResult,
  PageScope,
  PipelineConfig,
  ScopeDoc,
  TestUser,
} from '../types';

/* ───────────────────────── role inference ───────────────────────── */

interface RoleInfo {
  role: string;
  /** Why this role was inferred (for the script + notes). */
  rationale: string;
}

/** Regexes that, matched against routes/purposes, suggest a role. */
const ROLE_SIGNALS: Array<{ role: string; rationale: string; re: RegExp }> = [
  {
    role: 'admin',
    rationale: 'app exposes an admin/dashboard area',
    re: /\b(admin|backoffice|console|superuser|staff)\b/i,
  },
  {
    role: 'user',
    rationale: 'app has an authenticated user area (dashboard/account)',
    re: /\b(dashboard|account|profile|settings|app|members?)\b/i,
  },
  {
    role: 'attorney',
    rationale: 'app has an attorney-specific area',
    re: /\battorney\b/i,
  },
  {
    role: 'seller',
    rationale: 'app has a seller/vendor/merchant area',
    re: /\b(seller|vendor|merchant|store-owner)\b/i,
  },
];

/** Does the app even have authentication? */
function hasAuthSurface(scope: ScopeDoc): boolean {
  const haystack = scope.pages
    .map((p) => `${p.route} ${p.purpose} ${p.userFunction}`)
    .join(' ')
    .toLowerCase();
  return /(login|signin|sign-in|signup|sign-up|register|auth)/.test(haystack);
}

function inferRoles(scope: ScopeDoc): RoleInfo[] {
  const haystack = scope.pages
    .map((p) => `${p.route} ${p.purpose} ${p.userFunction}`)
    .join(' ');

  const roles: RoleInfo[] = [];
  const seen = new Set<string>();
  for (const sig of ROLE_SIGNALS) {
    if (sig.re.test(haystack) && !seen.has(sig.role)) {
      seen.add(sig.role);
      roles.push({ role: sig.role, rationale: sig.rationale });
    }
  }

  // Every app has a guest/unauthenticated visitor.
  if (!seen.has('guest')) {
    roles.unshift({
      role: 'guest',
      rationale: 'unauthenticated visitor — every app has one',
    });
  }

  // If there is an auth surface but we found no authenticated role, add a
  // generic "user".
  if (hasAuthSurface(scope) && !seen.has('user') && !seen.has('attorney')) {
    roles.push({
      role: 'user',
      rationale: 'app has auth but no specific role detected — generic user',
    });
  }

  return roles;
}

/* ───────────────────────── signup endpoint discovery ───────────────────────── */

interface SignupEndpoint {
  /** Route path (relative to baseUrl) used for account creation. */
  route: string;
  /** The page slug it came from, for traceability. */
  fromSlug: string;
  /** Whether this looked like a real API route (vs. a UI page). */
  isApi: boolean;
}

/** Find the most signup-like page/route in the scope. */
function findSignupEndpoint(scope: ScopeDoc): SignupEndpoint | null {
  // Prefer API routes (POST-able) over UI pages.
  const score = (p: PageScope): number => {
    const r = `${p.route} ${p.purpose} ${p.userFunction}`.toLowerCase();
    let s = 0;
    if (/\b(signup|sign-up|register|create-account)\b/.test(r)) s += 10;
    if (/\bcreate\b/.test(r) && /\b(user|account|attorney)\b/.test(r)) s += 8;
    if (/\/api\//.test(p.route)) s += 5;
    if (/\b(admin)\b/.test(r) && /\bcreate\b/.test(r)) s += 6;
    return s;
  };

  let best: PageScope | null = null;
  let bestScore = 0;
  for (const p of scope.pages) {
    const s = score(p);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  if (!best || bestScore === 0) return null;
  return {
    route: best.route,
    fromSlug: best.slug,
    isApi: /\/api\//.test(best.route),
  };
}

/* ───────────────────────── credential generation ───────────────────────── */

function makeCredentials(role: string): { email: string; password: string } {
  // Deterministic-ish but unique per run via a short random suffix.
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    email: `pipeline-${role}-${suffix}@example.test`,
    // Meets common complexity rules: upper, lower, digit, symbol, 12+ chars.
    password: `Test-${role.charAt(0).toUpperCase()}${role.slice(1)}-${suffix}9!`,
  };
}

/* ───────────────────────── HTTP seeding ───────────────────────── */

interface SeedOutcome {
  seeded: boolean;
  /** Note explaining the outcome (success detail or why it fell back). */
  note: string;
}

/**
 * POST a JSON signup payload to `baseUrl + route`. Integrations are stubbed,
 * so this fires no real emails/webhooks. Resolves with the HTTP status; never
 * throws.
 */
function postSignup(
  baseUrl: string,
  route: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let urlPath: string;
    try {
      urlPath = new URL(route, baseUrl).pathname;
    } catch {
      urlPath = route.startsWith('/') ? route : `/${route}`;
    }
    const data = JSON.stringify(payload);
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      resolve(null);
      return;
    }
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port || 80,
        path: urlPath,
        method: 'POST',
        timeout: 15_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          // Signal to app code that this is a stubbed pipeline request.
          'x-pipeline-stubbed': '1',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 2_000),
          });
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

/**
 * Attempt to seed one account. Tries an HTTP POST to the signup endpoint;
 * if that isn't possible (UI-only signup, no endpoint, app down) it returns
 * a note that the account must be created manually / via Playwright.
 */
async function seedAccount(
  boot: BootResult,
  signup: SignupEndpoint | null,
  role: string,
  creds: { email: string; password: string },
): Promise<SeedOutcome> {
  if (boot.status !== 'running' || !boot.baseUrl) {
    return {
      seeded: false,
      note: 'app not running — account not seeded; create it manually once the app boots.',
    };
  }
  if (!signup) {
    return {
      seeded: false,
      note: 'no signup/admin-create route detected in scope — seed this account manually through the UI.',
    };
  }
  if (!signup.isApi) {
    return {
      seeded: false,
      note: `signup is a UI page (\`${signup.route}\`), not a POST-able API — seed via Playwright by filling that form.`,
    };
  }

  // Best-effort: try a few common field-name conventions in one payload.
  const payload: Record<string, unknown> = {
    email: creds.email,
    password: creds.password,
    name: `Pipeline ${role}`,
    fullName: `Pipeline ${role}`,
    role,
    firmName: `Pipeline Test ${role}`,
    phone: '+15555550100',
    confirmPassword: creds.password,
  };

  const res = await postSignup(boot.baseUrl, signup.route, payload);
  if (!res) {
    return {
      seeded: false,
      note: `POST ${signup.route} failed to connect — seed this account manually.`,
    };
  }
  if (res.status >= 200 && res.status < 300) {
    return {
      seeded: true,
      note: `seeded via POST ${signup.route} (HTTP ${res.status}); integrations stubbed so no real emails/webhooks fired.`,
    };
  }
  if (res.status === 409 || /exists|duplicate/i.test(res.body)) {
    return {
      seeded: true,
      note: `account already exists for ${signup.route} (HTTP ${res.status}) — credentials reusable.`,
    };
  }
  return {
    seeded: false,
    note: `POST ${signup.route} returned HTTP ${res.status} — seed manually. Response: ${res.body.slice(0, 200)}`,
  };
}

/* ───────────────────────── login URL discovery ───────────────────────── */

function findLoginRoute(scope: ScopeDoc): string {
  const candidates = scope.pages.filter((p) =>
    /(login|signin|sign-in|auth\/login)/i.test(`${p.route} ${p.purpose}`),
  );
  if (candidates.length > 0) {
    // Prefer a UI page over an API route.
    const ui = candidates.find((c) => !/\/api\//.test(c.route));
    return (ui ?? candidates[0]).route;
  }
  return '/login';
}

/* ───────────────────────── test-script generation ───────────────────────── */

/**
 * Ask the model for a numbered, non-technical test script. Falls back to a
 * deterministic template if the model call fails.
 */
async function generateTestScript(
  gemini: GeminiClient,
  config: PipelineConfig,
  scope: ScopeDoc,
  boot: BootResult,
  role: string,
  rationale: string,
  loginUrl: string,
  creds: { email: string; password: string } | null,
  seedNote: string,
): Promise<string> {
  const baseUrl = boot.baseUrl ?? '(app not running — start it first)';
  const relevantPages = scope.pages
    .slice(0, 40)
    .map((p) => `- ${p.route}: ${p.purpose || p.userFunction || p.slug}`)
    .join('\n');

  const credLine = creds
    ? `Email: ${creds.email}\nPassword: ${creds.password}`
    : 'No credentials — account could not be seeded automatically.';

  const prompt = [
    `Write a numbered, plain-English manual test script for the "${role}" role`,
    `of the app "${scope.productGoal}".`,
    `Role rationale: ${rationale}`,
    '',
    `Base URL: ${baseUrl}`,
    `Login page: ${loginUrl}`,
    `Credentials:\n${credLine}`,
    `Seeding status: ${seedNote}`,
    '',
    'Pages available:',
    relevantPages,
    '',
    'Requirements:',
    '- Audience: a non-technical QA tester. No code, no jargon.',
    '- Strict numbered steps: "1. Go to <url>. 2. Log in with <email>/<password>. 3. Click X. 4. Confirm Y."',
    '- Cover the core happy path THIS role would actually do.',
    '- End with a short "Expected result" line.',
    creds
      ? '- Use the exact email/password given above in the login step.'
      : '- Note in step 2 that the tester must create an account first (no credentials available).',
    '- Output plain markdown only. No preamble.',
  ].join('\n');

  try {
    const text = await gemini.call({
      role: 'mechanical',
      prompt,
      systemInstruction:
        'You write clear, numbered, non-technical QA test scripts. ' +
        'Output only the script in markdown.',
    });
    if (text && text.trim()) return text.trim();
  } catch (err) {
    console.error(
      `[final-scaffold] test-script generation failed for role "${role}": ${
        (err as Error).message
      }`,
    );
  }

  // Deterministic fallback template.
  return fallbackScript(role, rationale, baseUrl, loginUrl, creds, seedNote, scope);
}

function fallbackScript(
  role: string,
  rationale: string,
  baseUrl: string,
  loginUrl: string,
  creds: { email: string; password: string } | null,
  seedNote: string,
  scope: ScopeDoc,
): string {
  const lines: string[] = [];
  lines.push(`# ${role} — manual test script`);
  lines.push('');
  lines.push(`_Role: ${rationale}_`);
  lines.push(`_Seeding: ${seedNote}_`);
  lines.push('');
  lines.push('## Steps');
  let n = 1;
  lines.push(`${n++}. Open a web browser and go to \`${baseUrl}\`.`);
  if (role === 'guest') {
    lines.push(
      `${n++}. Browse the public pages without logging in. Confirm the home page loads.`,
    );
    const firstPublic = scope.pages.find((p) => !/\/api\//.test(p.route));
    if (firstPublic) {
      lines.push(
        `${n++}. Visit \`${baseUrl}${firstPublic.route}\`. Confirm the page renders with no error.`,
      );
    }
  } else {
    lines.push(`${n++}. Go to the login page: \`${baseUrl}${loginUrl}\`.`);
    if (creds) {
      lines.push(
        `${n++}. Log in with email \`${creds.email}\` and password \`${creds.password}\`.`,
      );
    } else {
      lines.push(
        `${n++}. Create an account first (no credentials were seeded), then log in with it.`,
      );
    }
    lines.push(`${n++}. Confirm you land on the ${role} dashboard / home area.`);
    lines.push(
      `${n++}. Click through the main navigation items and confirm each page loads without an error.`,
    );
  }
  lines.push('');
  lines.push('## Expected result');
  lines.push(
    `The ${role} can complete the flow above with no broken pages, console errors, or dead buttons.`,
  );
  lines.push('');
  return lines.join('\n');
}

/* ───────────────────────── main ───────────────────────── */

export async function runTestScaffold(
  config: PipelineConfig,
  scope: ScopeDoc,
  boot: BootResult,
  gemini: GeminiClient,
): Promise<TestUser[]> {
  const scaffoldDir = path.join(config.runDir, 'test-scaffold');
  fs.mkdirSync(scaffoldDir, { recursive: true });

  const roles = inferRoles(scope);
  const signup = findSignupEndpoint(scope);
  const loginRoute = findLoginRoute(scope);
  const baseUrl = boot.baseUrl ?? '';

  const users: TestUser[] = [];

  for (const { role, rationale } of roles) {
    // Guests never have credentials.
    const isGuest = role === 'guest';
    const creds = isGuest ? null : makeCredentials(role);

    // Seed the account (no-op for guests).
    let seedNote = 'guest role — no account needed.';
    if (!isGuest && creds) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await seedAccount(boot, signup, role, creds);
      seedNote = outcome.note;
    }

    // Generate the script.
    const scriptPath = path.join(scaffoldDir, `${role}-test-script.md`);
    // eslint-disable-next-line no-await-in-loop
    const script = await generateTestScript(
      gemini,
      config,
      scope,
      boot,
      role,
      rationale,
      loginRoute,
      creds,
      seedNote,
    );
    try {
      fs.writeFileSync(scriptPath, script, 'utf8');
    } catch (err) {
      console.error(
        `[final-scaffold] failed to write ${scriptPath}: ${
          (err as Error).message
        }`,
      );
    }

    users.push({
      role,
      email: creds?.email ?? '',
      password: creds?.password ?? '',
      loginUrl: baseUrl ? `${baseUrl}${loginRoute}` : loginRoute,
      scriptPath,
    });
  }

  // Persist the users ledger.
  try {
    fs.writeFileSync(
      path.join(scaffoldDir, 'users.json'),
      JSON.stringify(users, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error(
      `[final-scaffold] failed to write users.json: ${(err as Error).message}`,
    );
  }

  // If the app is down, leave a clear note alongside the stubs.
  if (boot.status !== 'running') {
    try {
      fs.writeFileSync(
        path.join(scaffoldDir, 'README.md'),
        [
          '# Test scaffold — LIMITED',
          '',
          `The app did not boot (boot status: \`${boot.status}\`${
            boot.reason ? ` — ${boot.reason}` : ''
          }).`,
          '',
          'Credential-less script stubs were generated for each role. Once the',
          'app boots, seed each account through its signup/admin path and fill',
          'in the credentials in `users.json` and each script.',
        ].join('\n'),
        'utf8',
      );
    } catch {
      /* best-effort */
    }
  }

  return users;
}
