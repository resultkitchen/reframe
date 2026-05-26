/**
 * PageDriver — a bulletproof Playwright (headless Chromium) wrapper.
 *
 * `exercise()` clicks every visible button/link and focuses inputs, wrapping
 * each interaction in try/catch so a single failure never aborts the run.
 * Console + page errors are captured throughout.
 */

import type { Browser, ConsoleMessage, Page } from 'playwright';
import type { AuthConfig, AuthRole, PageHealth } from './types';

/**
 * Labels matching this pattern indicate a click that could mutate data, send
 * a message, or charge money. In read-only mode they are skipped, not clicked.
 */
const DESTRUCTIVE_LABEL =
  /\b(delete|remove|destroy|drop|send|submit|pay|payment|purchase|buy|checkout|charge|order|subscribe|unsubscribe|confirm|save|update|publish|deactivate|disable|archive|cancel|approve|reject|decline|invite|sign\s*out|log\s*out|logout)\b/i;

export class PageDriver {
  private readonly browser: Browser;

  private readonly page: Page;

  /** When true, exercise() skips destructive clicks (see DESTRUCTIVE_LABEL). */
  private readonly readOnly: boolean;

  /** Console errors + uncaught page errors collected since launch. */
  private readonly consoleErrors: string[] = [];

  private lastNavStatus: number | undefined;

  private navFailed = false;

  private constructor(browser: Browser, page: Page, readOnly: boolean) {
    this.browser = browser;
    this.page = page;
    this.readOnly = readOnly;

    // Capture console errors.
    this.page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        this.consoleErrors.push(`[console.error] ${msg.text()}`);
      }
    });

    // Capture uncaught exceptions in the page.
    this.page.on('pageerror', (err: Error) => {
      this.consoleErrors.push(`[pageerror] ${err.message}`);
    });
  }

  /**
   * Launch headless Chromium and open a fresh page.
   *
   * `opts.readOnly` makes exercise() skip destructive clicks — set it when
   * driving a live backend so no real mutation/email/charge fires.
   */
  static async launch(opts?: { readOnly?: boolean }): Promise<PageDriver> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    return new PageDriver(browser, page, opts?.readOnly ?? false);
  }

  /** Navigate to `url` and wait for the network to settle. */
  async open(url: string): Promise<void> {
    this.navFailed = false;
    this.lastNavStatus = undefined;
    try {
      const resp = await this.page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      this.lastNavStatus = resp?.status();
    } catch {
      // networkidle can stall on long-polling apps — fall back to domcontentloaded.
      try {
        const resp = await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        this.lastNavStatus = resp?.status();
      } catch (err) {
        this.navFailed = true;
        this.consoleErrors.push(
          `[navigation] failed to open ${url}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  async health(expectedRoute: string, loginPath?: string): Promise<PageHealth> {
    const finalUrl = this.page.url();
    let finalPathname = '';
    try {
      finalPathname = new URL(finalUrl).pathname;
    } catch {
      finalPathname = finalUrl;
    }

    let hasErrorOverlay = false;
    try {
      hasErrorOverlay = await this.page.evaluate(() => {
        const nextPortal = document.querySelector('nextjs-portal');
        if (nextPortal && nextPortal.shadowRoot) {
          const sr = nextPortal.shadowRoot;
          if (
            sr.querySelector('[data-nextjs-dialog]') ||
            sr.querySelector('[data-nextjs-dialog-overlay]') ||
            sr.querySelector('#nextjs__container_errors_label')
          ) {
            return true;
          }
        }
        if (document.querySelector('vite-error-overlay')) {
          return true;
        }
        const text = document.body?.innerText || '';
        return /Unhandled Runtime Error|Build Error|Failed to compile|Application error: a (server|client)-side exception/i.test(
          text,
        );
      });
    } catch {
      // ignore
    }

    const isLoginRegex = /(^|\/)(login|sign-?in|signin|auth)(\/|$)/i;
    const normLoginPath = loginPath
      ? loginPath.startsWith('/')
        ? loginPath
        : `/${loginPath}`
      : undefined;

    let status: PageHealth['status'] = 'ok';
    let detail = 'Page loaded successfully.';

    if (this.navFailed) {
      status = 'navigation-failed';
      detail = 'The browser failed to navigate to the page.';
    } else if (this.lastNavStatus !== undefined && this.lastNavStatus >= 400) {
      status = 'http-error';
      detail = `The page returned an HTTP ${this.lastNavStatus} error status.`;
    } else if (hasErrorOverlay) {
      status = 'error-overlay';
      detail = 'A framework error overlay or unhandled runtime exception was detected.';
    } else if (!isLoginRegex.test(expectedRoute)) {
      const looksLikeLogin =
        (normLoginPath &&
          (finalPathname === normLoginPath || finalPathname.startsWith(normLoginPath))) ||
        isLoginRegex.test(finalPathname);

      if (looksLikeLogin) {
        status = 'auth-redirect';
        detail = 'The page redirected to an authentication or login route.';
      }
    }

    return {
      status,
      healthy: status === 'ok',
      finalUrl,
      httpStatus: this.lastNavStatus,
      detail,
    };
  }

  /**
   * Log in via the app's own login form, in THIS browser context, so the
   * session cookie carries to every page subsequently opened on this driver.
   *
   * This is how auth-gated routes get audited as a real authenticated user
   * instead of a redirect to the public landing page. Deliberate and exempt
   * from read-only mode (read-only only governs `exercise()`).
   *
   * Resilient — never throws; returns `{ ok, detail }` for the caller to log.
   */
  async loginAs(
    baseUrl: string,
    auth: AuthConfig,
    role: AuthRole,
  ): Promise<{ ok: boolean; detail: string }> {
    const errText = (err: unknown): string =>
      err instanceof Error ? err.message : String(err);

    const loginPath = auth.loginUrl.startsWith('/')
      ? auth.loginUrl
      : `/${auth.loginUrl}`;
    const loginUrl = baseUrl.replace(/\/+$/, '') + loginPath;

    try {
      await this.page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (err) {
      return { ok: false, detail: `could not open login page ${loginUrl}: ${errText(err)}` };
    }

    // Fill with real keystrokes (pressSequentially), not page.fill's bulk
    // value-set: many login forms keep the submit button `disabled` until
    // React / react-hook-form validation fires on keystrokes, and validate
    // on blur. A bulk value-set can leave the button stuck disabled.
    try {
      const emailEl = this.page.locator(auth.emailSelector).first();
      await emailEl.fill('', { timeout: 8000 });
      await emailEl.pressSequentially(role.email, { delay: 15 });
      const pwEl = this.page.locator(auth.passwordSelector).first();
      await pwEl.fill('', { timeout: 8000 });
      await pwEl.pressSequentially(role.password, { delay: 15 });
      await pwEl.blur().catch(() => {});
    } catch (err) {
      return {
        ok: false,
        detail:
          `could not fill the login form for role "${role.role}" ` +
          `(selectors: ${auth.emailSelector} / ${auth.passwordSelector}): ${errText(err)}`,
      };
    }

    // Submit. Try the button; if it stays disabled, fall back to pressing
    // Enter in the password field, then to the form's requestSubmit().
    let submitted = false;
    try {
      await this.page
        .locator(auth.submitSelector)
        .first()
        .click({ timeout: 6000 });
      submitted = true;
    } catch {
      /* button likely still disabled — try the fallbacks */
    }
    if (!submitted) {
      try {
        await this.page
          .locator(auth.passwordSelector)
          .first()
          .press('Enter', { timeout: 4000 });
        submitted = true;
      } catch {
        /* fall through to requestSubmit */
      }
    }
    if (!submitted) {
      try {
        await this.page
          .locator(auth.submitSelector)
          .first()
          .evaluate((btn) => {
            const form = (btn as HTMLElement).closest('form');
            if (form) form.requestSubmit();
          });
        submitted = true;
      } catch {
        /* all submit strategies exhausted */
      }
    }
    if (!submitted) {
      return {
        ok: false,
        detail:
          `could not submit the login form for role "${role.role}" — the ` +
          `submit button (${auth.submitSelector}) stayed disabled and the ` +
          `Enter-key and requestSubmit() fallbacks also failed.`,
      };
    }

    // Wait for the post-login redirect AWAY from the login page. A successful
    // login navigates off it; a fixed wait races the redirect under load, so
    // wait on the URL itself with a generous timeout. Still on the login page
    // when it elapses ⇒ login genuinely failed.
    const settleMs = Math.max(auth.postLoginWaitMs || 0, 15000);
    try {
      await this.page.waitForURL((u) => !u.pathname.includes(loginPath), {
        timeout: settleMs,
      });
    } catch {
      return {
        ok: false,
        detail:
          `submitted the login form as "${role.role}" but never left the ` +
          `login page within ${Math.round(settleMs / 1000)}s — login failed ` +
          `(verify the test account exists and the password is correct, the ` +
          `selectors are right, and the app reaches its real auth backend).`,
      };
    }

    return { ok: true, detail: `logged in as "${role.role}" (${role.email})` };
  }

  /**
   * Exercise the page: focus every visible input, then click every visible
   * button/link. Every interaction is isolated in try/catch — a failed
   * interaction is recorded and the driver continues.
   */
  async exercise(): Promise<{
    interactions: string[];
    consoleErrors: string[];
  }> {
    const interactions: string[] = [];

    // 1) Focus visible form inputs.
    try {
      const inputs = this.page.locator(
        'input:visible, textarea:visible, select:visible',
      );
      const inputCount = await inputs.count();
      for (let i = 0; i < inputCount; i++) {
        const el = inputs.nth(i);
        try {
          const name =
            (await el.getAttribute('name').catch(() => null)) ??
            (await el.getAttribute('placeholder').catch(() => null)) ??
            (await el.getAttribute('aria-label').catch(() => null)) ??
            `input#${i}`;
          await el.focus({ timeout: 2000 });
          interactions.push(`focus: ${name}`);
        } catch (err) {
          interactions.push(
            `focus FAILED (input#${i}): ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } catch (err) {
      interactions.push(
        `input enumeration FAILED: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    // 2) Click visible buttons + links.
    try {
      const clickables = this.page.locator(
        'button:visible, a:visible, [role="button"]:visible',
      );
      const clickCount = await clickables.count();
      // Cap to keep exercise bounded on large pages.
      const limit = Math.min(clickCount, 60);
      for (let i = 0; i < limit; i++) {
        const el = clickables.nth(i);
        let label = `clickable#${i}`;
        try {
          const text = (await el.innerText().catch(() => '')) || '';
          const aria = await el.getAttribute('aria-label').catch(() => null);
          label = (text.trim() || aria || `clickable#${i}`).slice(0, 80);

          // Read-only mode: never click anything that could mutate data, send
          // a message, charge money, or end the session. Record the skip so
          // the audit still knows the element exists.
          if (this.readOnly) {
            const type = (
              await el.getAttribute('type').catch(() => null)
            )?.toLowerCase();
            if (type === 'submit' || DESTRUCTIVE_LABEL.test(label)) {
              interactions.push(`skipped (read-only): ${label}`);
              continue;
            }
          }

          // Skip elements that navigate away destructively where possible:
          // still click, but trial-click with a short timeout + no-wait so a
          // navigation doesn't hang the loop.
          await el.click({ timeout: 2000, trial: false, noWaitAfter: true });
          interactions.push(`click: ${label}`);

          // If a click navigated away, the remaining locators are stale —
          // stop exercising further interactions.
          if (this.page.isClosed()) break;
        } catch (err) {
          interactions.push(
            `click FAILED (${label}): ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } catch (err) {
      interactions.push(
        `clickable enumeration FAILED: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    return {
      interactions,
      consoleErrors: [...this.consoleErrors],
    };
  }


  /** Full-page screenshot as a base64 PNG string (no `data:` prefix). */
  async screenshot(): Promise<string> {
    try {
      const buf = await promiseWithTimeout<Buffer | null>(
        this.page.screenshot({
          fullPage: true,
          type: 'png',
        }),
        15000,
        null,
      );
      if (!buf) {
        throw new Error('Screenshot timed out after 15000ms');
      }
      return buf.toString('base64');
    } catch (err) {
      this.consoleErrors.push(
        `[screenshot] failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return '';
    }
  }

  /**
   * Text snapshot of the page: the ARIA accessibility snapshot, falling
   * back to `body.innerText` when it is unavailable.
   */
  async snapshot(): Promise<string> {
    try {
      const aria = await promiseWithTimeout<string>(
        this.page.locator('body').ariaSnapshot(),
        10000,
        '',
      );
      if (aria && aria.trim()) {
        return aria;
      }
    } catch {
      // Fall through to innerText.
    }

    try {
      return await promiseWithTimeout<string>(
        this.page.evaluate(() => document.body?.innerText ?? ''),
        5000,
        '',
      );
    } catch (err) {
      this.consoleErrors.push(
        `[snapshot] failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return '';
    }
  }

  /** Close the page + browser. Safe to call multiple times. */
  async close(): Promise<void> {
    try {
      await this.browser.close();
    } catch {
      // Already closed / crashed — nothing to do.
    }
  }
}

/** Safe promise race timeout helper to prevent headless hangs under heavy load. */
function promiseWithTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).then((res) => {
    clearTimeout(timer);
    return res;
  });
}
