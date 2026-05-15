/**
 * GeminiClient — the only path to the Gemini API.
 *
 * - Model id per call is resolved from `config.models[opts.role]`.
 * - Every call is timeout-bounded; timeouts/errors retry up to `maxRetries`.
 * - On FINAL failure the message is pushed to `this.alerts` AND printed to
 *   stderr immediately, so the operator is alerted in-session (not silently
 *   retried forever).
 * - `callJson` requests JSON output and parses it defensively.
 *
 * `@google/genai` is ESM-only; it is loaded via a genuine dynamic `import()`
 * that survives CommonJS down-compilation (the `Function` indirection stops
 * TypeScript from rewriting it to `require()`).
 */

import type {
  GeminiCallOptions,
  IGeminiClient,
  PipelineConfig,
} from './types';

/* A real ESM import() that TS will not down-level to require(). */
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<any>;

class TimeoutError extends Error {}

export class GeminiClient implements IGeminiClient {
  readonly alerts: string[] = [];

  private readonly config: PipelineConfig;

  private aiPromise: Promise<any> | null = null;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /** Lazily construct the GoogleGenAI client (cached). */
  private async ai(): Promise<any> {
    if (!this.aiPromise) {
      this.aiPromise = (async () => {
        const mod = await esmImport('@google/genai');
        const GoogleGenAI = mod.GoogleGenAI ?? mod.default?.GoogleGenAI;
        if (!GoogleGenAI) {
          throw new Error('@google/genai: GoogleGenAI export not found');
        }
        return new GoogleGenAI({ apiKey: this.config.geminiApiKey });
      })();
    }
    return this.aiPromise;
  }

  /** Plain text completion. */
  async call(opts: GeminiCallOptions): Promise<string> {
    return this.run(opts, false);
  }

  /** JSON completion — parsed into T. */
  async callJson<T>(opts: GeminiCallOptions): Promise<T> {
    const raw = await this.run({ ...opts, json: true }, true);
    return parseJson<T>(raw);
  }

  /** Shared call path: build request, race a timeout, retry, alert. */
  private async run(opts: GeminiCallOptions, json: boolean): Promise<string> {
    const model = this.config.models[opts.role];
    if (!model) {
      const msg = `Gemini: no model configured for role "${opts.role}"`;
      this.alert(msg);
      throw new Error(msg);
    }

    const timeoutMs = opts.timeoutMs ?? this.config.callTimeoutMs;
    const parts: any[] = [{ text: opts.prompt }];
    for (const img of opts.images ?? []) {
      parts.push({ inlineData: { mimeType: 'image/png', data: img } });
    }

    const genConfig: Record<string, unknown> = {};
    if (opts.systemInstruction) {
      genConfig.systemInstruction = opts.systemInstruction;
    }
    if (json || opts.json) {
      genConfig.responseMimeType = 'application/json';
    }

    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const ai = await this.ai();
        const text = await withTimeout(
          (async () => {
            const res = await ai.models.generateContent({
              model,
              contents: [{ role: 'user', parts }],
              config: genConfig,
            });
            return extractText(res);
          })(),
          timeoutMs,
          `${opts.role}/${model}`,
        );
        if (!text || !text.trim()) {
          throw new Error('empty response');
        }
        return text;
      } catch (err) {
        lastErr = err;
        const reason = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          console.error(
            `[gemini] ${opts.role} attempt ${attempt}/${maxAttempts} failed ` +
              `(${reason}) — retrying`,
          );
          await sleep(1000 * attempt * attempt);
        }
      }
    }

    const msg =
      `Gemini call FAILED after ${maxAttempts} attempts ` +
      `(role=${opts.role}, model=${model}): ` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr));
    this.alert(msg);
    throw lastErr instanceof Error ? lastErr : new Error(msg);
  }

  /** Record an operator-facing alert (stderr + collected list). */
  private alert(message: string): void {
    console.error(`[ALERT] ${message}`);
    this.alerts.push(message);
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a timeout. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`timed out after ${ms}ms (${label})`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pull the text out of a generateContent response across SDK shapes. */
function extractText(res: any): string {
  if (res == null) return '';
  if (typeof res.text === 'string') return res.text;
  if (typeof res.text === 'function') return String(res.text() ?? '');
  const cand = res.candidates?.[0]?.content?.parts;
  if (Array.isArray(cand)) {
    return cand.map((p: any) => p?.text ?? '').join('');
  }
  return '';
}

/** Parse model JSON output, defensively stripping fences and surrounding prose. */
function parseJson<T>(raw: string): T {
  let s = raw.trim();
  // Strip ```json ... ``` fences.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    // Fall back to the outermost {...} or [...] span.
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    let start = -1;
    let open = '{';
    let close = '}';
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
      start = firstArr;
      open = '[';
      close = ']';
    } else {
      start = firstObj;
    }
    if (start !== -1) {
      const end = s.lastIndexOf(close);
      if (end > start) {
        const span = s.slice(start, end + 1);
        return JSON.parse(span) as T;
      }
    }
    throw new Error(
      `Gemini JSON parse failed; raw output starts: ${s.slice(0, 200)}`,
    );
  }
}
