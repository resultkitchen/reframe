/**
 * PageDriver — a bulletproof Playwright (headless Chromium) wrapper.
 *
 * `exercise()` clicks every visible button/link and focuses inputs, wrapping
 * each interaction in try/catch so a single failure never aborts the run.
 * Console + page errors are captured throughout.
 */

import type { Browser, ConsoleMessage, Page } from 'playwright';

export class PageDriver {
  private readonly browser: Browser;

  private readonly page: Page;

  /** Console errors + uncaught page errors collected since launch. */
  private readonly consoleErrors: string[] = [];

  private constructor(browser: Browser, page: Page) {
    this.browser = browser;
    this.page = page;

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

  /** Launch headless Chromium and open a fresh page. */
  static async launch(): Promise<PageDriver> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    return new PageDriver(browser, page);
  }

  /** Navigate to `url` and wait for the network to settle. */
  async open(url: string): Promise<void> {
    try {
      await this.page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    } catch {
      // networkidle can stall on long-polling apps — fall back to domcontentloaded.
      try {
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (err) {
        this.consoleErrors.push(
          `[navigation] failed to open ${url}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
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
      const buf = await this.page.screenshot({
        fullPage: true,
        type: 'png',
      });
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
      const aria = await this.page.locator('body').ariaSnapshot();
      if (aria && aria.trim()) {
        return aria;
      }
    } catch {
      // Fall through to innerText.
    }

    try {
      return await this.page.evaluate(
        () => document.body?.innerText ?? '',
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
