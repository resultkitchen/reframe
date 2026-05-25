/**
 * Stage 0.5 — Boot gate.
 *
 * Provisions and boots the target app so later stages have a live URL to drive:
 *   1. Detect the package manager from the lockfile.
 *   2. Install dependencies in `config.workDir`.
 *   3. Detect external integrations (Supabase, Stripe, Resend, SMTP, GHL,
 *      Twilio, Postgres, …) and write a `.env.local` of SAFE STUB values so
 *      booting + later test-user seeding fires NO real side effects.
 *   4. Find the dev/start script and boot it as a detached background process.
 *   5. Poll common ports over HTTP until one answers (or time out).
 *
 * A failed boot is a NORMAL returned status (`wont-start` / `no-server`) —
 * this function NEVER throws. Writes `runDir/boot.json`.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { BootResult, BootStatus, PipelineConfig } from '../types';

/* ───────────────────────── tuning constants ───────────────────────── */

const INSTALL_TIMEOUT_MS = 8 * 60 * 1000; // 8 min — installs can be slow.
const BOOT_TIMEOUT_MS = 90 * 1000; // 90 s to get an HTTP 200/3xx/4xx.
const PORT_POLL_INTERVAL_MS = 1_500;
const CANDIDATE_PORTS = [3000, 3001, 5173, 8080, 4321, 5000, 8000];

/* ───────────────────────── package manager ───────────────────────── */

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PmInfo {
  pm: Pm;
  installArgs: string[];
  runArgs: (script: string) => string[];
}

function detectPackageManager(workDir: string): PmInfo {
  const has = (f: string): boolean => fs.existsSync(path.join(workDir, f));

  if (has('pnpm-lock.yaml')) {
    return {
      pm: 'pnpm',
      installArgs: ['install', '--frozen-lockfile=false'],
      runArgs: (s) => ['run', s],
    };
  }
  if (has('yarn.lock')) {
    return {
      pm: 'yarn',
      installArgs: ['install'],
      runArgs: (s) => [s],
    };
  }
  if (has('bun.lockb') || has('bun.lock')) {
    return {
      pm: 'bun',
      installArgs: ['install'],
      runArgs: (s) => ['run', s],
    };
  }
  // Default — package-lock.json or nothing.
  return {
    pm: 'npm',
    installArgs: ['install', '--no-audit', '--no-fund'],
    runArgs: (s) => ['run', s],
  };
}

/** On Windows, package-manager binaries are `.cmd` shims — spawn via shell. */
const IS_WINDOWS = process.platform === 'win32';

/* ───────────────────────── integration stubbing ───────────────────────── */

interface IntegrationRule {
  /** Human label recorded into `stubbedIntegrations`. */
  label: string;
  /** Substrings that, if seen in deps or env, mark this integration present. */
  match: RegExp;
  /** Safe stub env vars this integration needs. */
  stubEnv: Record<string, string>;
}

const INTEGRATION_RULES: IntegrationRule[] = [
  {
    label: 'Supabase (stubbed: localhost URL + fake anon/service keys)',
    match: /supabase/i,
    stubEnv: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key',
      SUPABASE_ANON_KEY: 'stub-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key',
      PRIVATE_SUPABASE_SERVICE_KEY: 'stub-service-role-key',
    },
  },
  {
    label: 'Stripe (stubbed: fake test keys, no live charges)',
    match: /\bstripe\b/i,
    stubEnv: {
      STRIPE_SECRET_KEY: 'sk_test_stub0000000000000000000000',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_stub0000000000000000000000',
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_stub0000000000000000000000',
      STRIPE_WEBHOOK_SECRET: 'whsec_stub0000000000000000000000',
    },
  },
  {
    label: 'Resend (stubbed: fake API key — no email send)',
    match: /resend/i,
    stubEnv: {
      RESEND_API_KEY: 're_stub_0000000000000000000000',
      RESEND_API_KEY_CASESDAILY: 're_stub_0000000000000000000000',
    },
  },
  {
    label: 'SMTP / nodemailer (stubbed: localhost mail sink)',
    match: /nodemailer|smtp/i,
    stubEnv: {
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_USER: 'stub',
      SMTP_PASS: 'stub',
      EMAIL_FROM: 'stub@localhost',
    },
  },
  {
    label: 'GoHighLevel (stubbed: localhost webhook + fake key)',
    match: /gohighlevel|leadconnector|\bghl\b/i,
    stubEnv: {
      GHL_API_KEY: 'stub-ghl-key',
      GHL_WEBHOOK_URL: 'http://localhost:9999/stub-ghl',
      GHL_CALENDAR_URL: 'http://localhost:9999/stub-ghl-calendar',
    },
  },
  {
    label: 'Twilio (stubbed: fake SID/token — no SMS)',
    match: /twilio/i,
    stubEnv: {
      TWILIO_ACCOUNT_SID: 'ACstub00000000000000000000000000',
      TWILIO_AUTH_TOKEN: 'stub-twilio-token',
      TWILIO_FROM_NUMBER: '+15555550100',
    },
  },
  {
    label: 'Postgres (stubbed: localhost connection string)',
    match: /\bpg\b|postgres|node-postgres|drizzle-orm/i,
    stubEnv: {
      DATABASE_URL: 'postgresql://stub:stub@localhost:5432/stub',
      POSTGRES_URL: 'postgresql://stub:stub@localhost:5432/stub',
    },
  },
  {
    label: 'OpenAI / Anthropic / Gemini (stubbed: fake API keys)',
    match: /openai|anthropic|@google\/generative|@google\/genai/i,
    stubEnv: {
      OPENAI_API_KEY: 'sk-stub0000000000000000000000',
      ANTHROPIC_API_KEY: 'sk-ant-stub0000000000000000',
      GOOGLE_API_KEY: 'stub-google-key',
      GEMINI_API_KEY: 'stub-gemini-key',
    },
  },
  {
    label: 'Sentry (stubbed: empty DSN — no error reporting)',
    match: /sentry/i,
    stubEnv: {
      SENTRY_DSN: '',
      NEXT_PUBLIC_SENTRY_DSN: '',
    },
  },
];

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parse `KEY=` names out of a dotenv-style file (.env.example, etc.).
 * Values are ignored — we only want the key names to know what to stub.
 */
function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

interface StubResult {
  stubbedIntegrations: string[];
  envFileWritten: boolean;
}

/**
 * Detect integrations from deps + env templates, then write a `.env.local`
 * full of safe stub values into `workDir`.
 */
function stubIntegrations(workDir: string): StubResult {
  // Gather signal: package.json deps + any .env* template files.
  const pkgRaw = safeRead(path.join(workDir, 'package.json'));
  let depNames = '';
  try {
    const pkg = JSON.parse(pkgRaw || '{}') as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    depNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].join(' ');
  } catch {
    depNames = '';
  }

  const envTemplateFiles = [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env',
    '.env.local.example',
  ];
  let templateKeys: string[] = [];
  let templateBlob = '';
  for (const f of envTemplateFiles) {
    const p = path.join(workDir, f);
    if (fs.existsSync(p)) {
      const content = safeRead(p);
      templateBlob += `\n${content}`;
      templateKeys = templateKeys.concat(parseEnvKeys(content));
    }
  }

  const signal = `${depNames}\n${templateBlob}`;

  const stubbedIntegrations: string[] = [];
  const envVars: Record<string, string> = {
    // Universal flag — app code / seeders can branch on this to no-op
    // outbound side effects.
    PIPELINE_STUBBED: '1',
    NODE_ENV: 'development',
  };

  for (const rule of INTEGRATION_RULES) {
    if (rule.match.test(signal)) {
      stubbedIntegrations.push(rule.label);
      for (const [k, v] of Object.entries(rule.stubEnv)) {
        envVars[k] = v;
      }
    }
  }

  // Any template key we did NOT already cover: stub it with a generic value
  // so the app doesn't crash on a missing required env var.
  for (const key of templateKeys) {
    if (!(key in envVars)) {
      const upper = key.toUpperCase();
      if (upper.includes('URL') || upper.includes('ENDPOINT')) {
        envVars[key] = 'http://localhost:9999/stub';
      } else if (upper.includes('PORT')) {
        envVars[key] = '3000';
      } else {
        envVars[key] = `stub-${key.toLowerCase()}`;
      }
    }
  }

  // Write .env.local — do NOT clobber an existing one the operator may have
  // placed; append/overwrite only our managed block.
  const banner =
    '# === Reframe Stage 0.5 — SAFE STUB ENV (no real side effects) ===';
  const body = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const block = `${banner}\n${body}\n`;

  let envFileWritten = false;
  try {
    fs.writeFileSync(path.join(workDir, '.env.local'), block, 'utf8');
    envFileWritten = true;
  } catch {
    envFileWritten = false;
  }

  return { stubbedIntegrations, envFileWritten };
}

/**
 * `--real-env` path: do NOT stub. The target's real `.env.local` (copied into
 * the work dir by the orchestrator for local-path targets) is left untouched
 * so the booted app reaches its real backend. Caller is responsible for the
 * safety side — read-only browser exercise — see PipelineConfig.readOnlyExercise.
 */
function preserveRealEnv(workDir: string): StubResult {
  const hasEnv = fs.existsSync(path.join(workDir, '.env.local'));
  if (!hasEnv) {
    console.error(
      '[stage0.5] warning: --real-env set but no .env.local found in the ' +
        'work dir — the app will boot with whatever env it ships with.',
    );
  }
  return {
    stubbedIntegrations: [
      hasEnv
        ? 'NONE — real .env.local preserved (--real-env): app reaches its real backend'
        : 'NONE — --real-env set but no .env.local found in the work dir',
    ],
    // We did not write a file; the real one (if any) is already in place.
    envFileWritten: hasEnv,
  };
}

/* ───────────────────────── dev script discovery ───────────────────────── */

interface DevScript {
  /** The npm-script name to run. */
  name: string;
}

function findDevScript(workDir: string): DevScript | null {
  const pkgRaw = safeRead(path.join(workDir, 'package.json'));
  if (!pkgRaw) return null;
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return null;
  }
  // Preference order.
  for (const candidate of ['dev', 'start', 'serve', 'develop']) {
    if (typeof scripts[candidate] === 'string' && scripts[candidate].trim()) {
      return { name: candidate };
    }
  }
  return null;
}

/* ───────────────────────── HTTP port polling ───────────────────────── */

/**
 * Resolve true if the port answers with any HTTP response. Probes both IPv4
 * (127.0.0.1) and IPv6 (::1): dev servers bind `localhost`, which resolves to
 * `::1` first on Windows — an IPv4-only probe would miss them.
 */
function probePort(port: number): Promise<boolean> {
  const hosts = ['127.0.0.1', '::1'];
  return new Promise((resolve) => {
    let remaining = hosts.length;
    let settled = false;
    const finish = (up: boolean): void => {
      if (settled) return;
      if (up) {
        settled = true;
        resolve(true);
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        settled = true;
        resolve(false);
      }
    };
    for (const host of hosts) {
      const req = http.get(
        { host, port, path: '/', timeout: 4_000 },
        (res) => {
          // Any HTTP status (even 404/500) means a server is listening.
          res.resume();
          finish(true);
        },
      );
      req.on('error', () => finish(false));
      req.on('timeout', () => {
        req.destroy();
        finish(false);
      });
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract the localhost port a dev server announced on stdout — e.g. Vite's
 * "Local:   http://localhost:5177/" or Next's "- Local: http://localhost:3000".
 * This is authoritative: it identifies OUR server, not a stale one another
 * project left listening on a guessed port.
 */
function extractPortFromLog(log: string): number | undefined {
  let last: number | undefined;
  // Dev servers colorize their output — the port digits are often wrapped in
  // ANSI escape codes (Vite bolds the port). Strip ANSI before matching.
  const clean = log.replace(/\[[0-9;]*[A-Za-z]/g, '');
  const re = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const p = Number(m[1]);
    if (p > 0 && p < 65536) last = p;
  }
  return last;
}

/** Grace period to wait for a stdout URL announcement before guessing ports. */
const CANDIDATE_GRACE_MS = 20_000;

/* ───────────────────────── install ───────────────────────── */

interface InstallOutcome {
  ok: boolean;
  log: string;
}

function runInstall(workDir: string, pm: PmInfo): InstallOutcome {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(pm.pm, pm.installArgs, {
      cwd: workDir,
      encoding: 'utf8',
      timeout: INSTALL_TIMEOUT_MS,
      shell: IS_WINDOWS, // .cmd shims on Windows
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (err) {
    return {
      ok: false,
      log: `install spawn failed: ${(err as Error).message}`,
    };
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const log = [
    `$ ${pm.pm} ${pm.installArgs.join(' ')}`,
    stdout,
    stderr,
  ].join('\n');

  if (result.error) {
    return {
      ok: false,
      log: `${log}\n[install error: ${result.error.message}]`,
    };
  }
  if (result.status !== 0) {
    return { ok: false, log: `${log}\n[install exit code: ${result.status}]` };
  }
  return { ok: true, log };
}

/* ───────────────────────── boot ───────────────────────── */

interface SpawnedServer {
  pid?: number;
  startCommand: string;
  bootLog: string;
  baseUrl?: string;
}

/**
 * Spawn the dev server detached, poll the candidate ports until one answers
 * or `BOOT_TIMEOUT_MS` elapses.
 */
async function bootServer(
  workDir: string,
  pm: PmInfo,
  dev: DevScript,
): Promise<SpawnedServer> {
  const args = pm.runArgs(dev.name);
  const startCommand = `${pm.pm} ${args.join(' ')}`;

  let logBuf = `$ ${startCommand}\n`;

  // Do NOT pin PORT. A dev server should pick a free port and announce it on
  // stdout (extractPortFromLog catches it). Pinning PORT makes Next.js
  // hard-fail with EADDRINUSE when that port is already taken by another
  // process; unsetting it lets Next/Vite/etc. auto-select a free port.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER: 'none', // suppress auto-open
    CI: '1',
  };
  delete childEnv.PORT;

  let child;
  try {
    child = spawn(pm.pm, args, {
      cwd: workDir,
      shell: IS_WINDOWS,
      detached: !IS_WINDOWS, // own process group on POSIX for clean teardown
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
  } catch (err) {
    return {
      startCommand,
      bootLog: `${logBuf}[spawn failed: ${(err as Error).message}]`,
    };
  }

  const captureCap = 64 * 1024;
  const append = (chunk: Buffer): void => {
    if (logBuf.length < captureCap) {
      logBuf += chunk.toString('utf8');
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  let exitedEarly = false;
  let exitInfo = '';
  child.on('exit', (code, signal) => {
    exitedEarly = true;
    exitInfo = `dev server process exited early (code=${code}, signal=${signal})`;
  });

  // Poll for a live HTTP port. Prefer the port the dev server ANNOUNCED on
  // stdout (authoritative — it is our process); only fall back to guessing
  // fixed ports after a grace period, to avoid latching onto a foreign dev
  // server another project left running.
  const start = Date.now();
  const deadline = start + BOOT_TIMEOUT_MS;
  let baseUrl: string | undefined;
  while (Date.now() < deadline) {
    if (exitedEarly) break;
    const announced = extractPortFromLog(logBuf);
    if (announced !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      if (await probePort(announced)) {
        baseUrl = `http://localhost:${announced}`;
        break;
      }
    } else if (Date.now() - start > CANDIDATE_GRACE_MS) {
      for (const port of CANDIDATE_PORTS) {
        // eslint-disable-next-line no-await-in-loop
        const up = await probePort(port);
        if (up) {
          baseUrl = `http://localhost:${port}`;
          break;
        }
      }
      if (baseUrl) break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(PORT_POLL_INTERVAL_MS);
  }

  if (baseUrl) {
    // Detach our event listeners; leave the server running for later stages.
    child.stdout?.removeAllListeners('data');
    child.stderr?.removeAllListeners('data');
    if (!IS_WINDOWS) child.unref();
    return {
      pid: child.pid,
      startCommand,
      bootLog: logBuf,
      baseUrl,
    };
  }

  // No port came up — kill the (possibly zombie) child and report failure.
  try {
    if (child.pid && !exitedEarly) {
      if (!IS_WINDOWS) {
        process.kill(-child.pid, 'SIGTERM');
      } else {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: true,
        });
      }
    }
  } catch {
    /* best-effort teardown */
  }

  const reason = exitedEarly
    ? exitInfo
    : `dev server did not answer on any of ${CANDIDATE_PORTS.join(', ')} within ${
        BOOT_TIMEOUT_MS / 1000
      }s`;
  return {
    startCommand,
    bootLog: `${logBuf}\n[${reason}]`,
  };
}

/* ───────────────────────── persistence ───────────────────────── */

function writeBootJson(runDir: string, result: BootResult): void {
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'boot.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error(`[stage0.5] failed to write boot.json: ${(err as Error).message}`);
  }
}

/* ───────────────────────── main ───────────────────────── */

export async function runBootGate(
  config: PipelineConfig,
): Promise<BootResult> {
  // Helper to build + persist + return a result in one place.
  const finish = (
    status: BootStatus,
    fields: Partial<BootResult> & { installLog: string; bootLog: string },
  ): BootResult => {
    const result: BootResult = {
      status,
      installLog: fields.installLog,
      bootLog: fields.bootLog,
      stubbedIntegrations: fields.stubbedIntegrations ?? [],
      ...(fields.baseUrl ? { baseUrl: fields.baseUrl } : {}),
      ...(fields.startCommand ? { startCommand: fields.startCommand } : {}),
      ...(fields.pid !== undefined ? { pid: fields.pid } : {}),
      ...(fields.reason ? { reason: fields.reason } : {}),
    };
    writeBootJson(config.runDir, result);
    return result;
  };

  try {
    // 1. Detect package manager.
    const pm = detectPackageManager(config.workDir);

    // 2. Env: stub all integrations BEFORE install/boot so the app never sees
    //    real credentials — UNLESS --real-env, which preserves the real
    //    .env.local so the app reaches its real backend (paired with
    //    read-only browser exercise for safety).
    const stub = config.realEnv
      ? preserveRealEnv(config.workDir)
      : stubIntegrations(config.workDir);
    if (!config.realEnv && !stub.envFileWritten) {
      console.error('[stage0.5] warning: could not write .env.local stub file');
    }
    if (config.realEnv) {
      console.log('[stage0.5] --real-env: real .env.local preserved (NOT stubbed).');
    }

    // 3. Install dependencies.
    const install = runInstall(config.workDir, pm);
    if (!install.ok) {
      return finish('wont-start', {
        installLog: install.log,
        bootLog: '',
        stubbedIntegrations: stub.stubbedIntegrations,
        reason: `dependency install failed (${pm.pm})`,
      });
    }

    // 4. Find the dev/start script.
    const dev = findDevScript(config.workDir);
    if (!dev) {
      return finish('no-server', {
        installLog: install.log,
        bootLog: '',
        stubbedIntegrations: stub.stubbedIntegrations,
        reason:
          'no dev/start/serve script found in package.json — app is not a ' +
          'bootable web server',
      });
    }

    // 5. Boot + poll.
    const server = await bootServer(config.workDir, pm, dev);
    if (server.baseUrl) {
      return finish('running', {
        installLog: install.log,
        bootLog: server.bootLog,
        stubbedIntegrations: stub.stubbedIntegrations,
        baseUrl: server.baseUrl,
        startCommand: server.startCommand,
        ...(server.pid !== undefined ? { pid: server.pid } : {}),
      });
    }

    return finish('wont-start', {
      installLog: install.log,
      bootLog: server.bootLog,
      stubbedIntegrations: stub.stubbedIntegrations,
      startCommand: server.startCommand,
      reason:
        'dev server started but never served HTTP on a known port within ' +
        `${BOOT_TIMEOUT_MS / 1000}s`,
    });
  } catch (err) {
    // Absolute backstop — a boot gate must NEVER throw.
    return finish('wont-start', {
      installLog: '',
      bootLog: `[stage0.5] unexpected error: ${(err as Error).message}`,
      reason: `unexpected boot-gate failure: ${(err as Error).message}`,
    });
  }
}
