/**
 * GeminiClient — handles swappable LLM engines supporting Gemini (Tier-3 default),
 * Anthropic, OpenAI, and custom OpenAI-compatible endpoints (Ollama/local).
 *
 * Keeps the name GeminiClient for complete backwards compatibility across the pipeline,
 * but implements generalized LLM calling mechanics under the hood.
 */

import type { ZodError, ZodIssue, ZodTypeAny, infer as ZodInfer } from 'zod';
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

  /** JSON completion — parsed into T. No schema validation. */
  async callJson<T>(opts: GeminiCallOptions): Promise<T> {
    const raw = await this.run({ ...opts, json: true }, true);
    return parseJson<T>(raw);
  }

  /**
   * JSON completion validated against a Zod schema.
   *
   * On a validation failure on the first call, the issues are appended to
   * the prompt and the model is asked to retry — once. Persistent failure
   * throws, recording an alert so the caller can surface it cleanly and
   * fall back to its own minimal default.
   *
   * Use this for any new agent. `callJson<T>` remains the unvalidated
   * legacy form for older callers that handle their own normalization.
   */
  async callJsonSchema<S extends ZodTypeAny>(
    schema: S,
    opts: GeminiCallOptions,
  ): Promise<ZodInfer<S>> {
    let attemptOpts = { ...opts, json: true };
    let lastError: ZodError | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await this.run(attemptOpts, true);
      const parsedRaw = parseJson<unknown>(raw);
      const result = schema.safeParse(parsedRaw);
      if (result.success) return result.data as ZodInfer<S>;
      lastError = result.error;

      if (attempt === 1) {
        // Compose a focused retry: tell the model what it got wrong and
        // give it the original prompt verbatim so the second attempt sees
        // the full task again, not just the validation feedback.
        const feedback = formatZodIssues(result.error);
        attemptOpts = {
          ...opts,
          json: true,
          prompt:
            opts.prompt +
            `\n\nIMPORTANT: Your previous response did not match the required JSON schema.\n` +
            `Validation issues:\n${feedback}\n\n` +
            `Return a single JSON object that matches the schema exactly. No prose, no markdown fences.`,
        };
        this.alert(
          `LLM Provider: schema validation failed for "${opts.role}" on attempt 1 — retrying with feedback.`,
        );
      }
    }

    const summary = lastError ? formatZodIssues(lastError) : 'unknown error';
    const msg = `LLM Provider: schema validation failed for "${opts.role}" after retry. Issues:\n${summary}`;
    this.alert(msg);
    throw new Error(msg);
  }

  /** Shared call path: build request, race a timeout, retry, alert. */
  private async run(opts: GeminiCallOptions, json: boolean): Promise<string> {
    const model = this.config.models[opts.role];
    if (!model) {
      const msg = `LLM Provider: no model configured for role "${opts.role}"`;
      this.alert(msg);
      throw new Error(msg);
    }

    const timeoutMs = opts.timeoutMs ?? this.config.callTimeoutMs;
    const provider = this.config.llmProvider;

    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const text = await withTimeout(
          (async () => {
            if (provider === 'gemini') {
              return await this.callGemini(opts, model, json);
            } else if (provider === 'anthropic') {
              return await this.callAnthropic(opts, model, json);
            } else if (provider === 'openai') {
              return await this.callOpenAI(opts, model, json);
            } else if (provider === 'openai-compatible') {
              return await this.callOpenAICompatible(opts, model, json);
            } else {
              throw new Error(`Unsupported LLM provider: ${provider}`);
            }
          })(),
          timeoutMs,
          `${opts.role}/${model} (${provider})`,
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
            `[llm-client] ${opts.role} (${provider}) attempt ${attempt}/${maxAttempts} failed ` +
              `(${reason}) — retrying`,
          );
          await sleep(1000 * attempt * attempt);
        }
      }
    }

    const msg =
      `LLM Provider (${provider}) call FAILED after ${maxAttempts} attempts ` +
      `(role=${opts.role}, model=${model}): ` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr));
    this.alert(msg);
    throw lastErr instanceof Error ? lastErr : new Error(msg);
  }

  /** Call Google Gemini using the official SDK. */
  private async callGemini(opts: GeminiCallOptions, model: string, json: boolean): Promise<string> {
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

    const ai = await this.ai();
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: genConfig,
    });
    return extractText(res);
  }

  /** Call Anthropic Messages API using native global fetch. */
  private async callAnthropic(opts: GeminiCallOptions, model: string, json: boolean): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set in environment.');
    }

    const contentParts: any[] = [{ type: 'text', text: opts.prompt }];
    for (const img of opts.images ?? []) {
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: img,
        },
      });
    }

    const payload: any = {
      model,
      messages: [{ role: 'user', content: contentParts }],
      max_tokens: 4000,
    };
    if (opts.systemInstruction) {
      payload.system = opts.systemInstruction;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API returned HTTP ${response.status}: ${errText}`);
    }

    const resJson = (await response.json()) as any;
    return resJson.content?.[0]?.text || '';
  }

  /** Call OpenAI Chat Completions API using native global fetch. */
  private async callOpenAI(opts: GeminiCallOptions, model: string, json: boolean): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set in environment.');
    }

    const contentParts: any[] = [{ type: 'text', text: opts.prompt }];
    for (const img of opts.images ?? []) {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${img}`,
        },
      });
    }

    const messages: any[] = [];
    if (opts.systemInstruction) {
      messages.push({ role: 'system', content: opts.systemInstruction });
    }
    messages.push({ role: 'user', content: contentParts });

    const payload: any = {
      model,
      messages,
    };

    if (json || opts.json) {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API returned HTTP ${response.status}: ${errText}`);
    }

    const resJson = (await response.json()) as any;
    return resJson.choices?.[0]?.message?.content || '';
  }

  /** Call custom OpenAI-compatible endpoint (Ollama/local) using native global fetch. */
  private async callOpenAICompatible(opts: GeminiCallOptions, model: string, json: boolean): Promise<string> {
    const baseUrl = process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1';
    const apiKey = process.env.OPENAI_API_KEY || 'ollama';

    const contentParts: any[] = [{ type: 'text', text: opts.prompt }];
    for (const img of opts.images ?? []) {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${img}`,
        },
      });
    }

    const messages: any[] = [];
    if (opts.systemInstruction) {
      messages.push({ role: 'system', content: opts.systemInstruction });
    }
    messages.push({ role: 'user', content: contentParts });

    const payload: any = {
      model,
      messages,
    };

    if (json || opts.json) {
      payload.response_format = { type: 'json_object' };
    }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI-compatible API (${endpoint}) returned HTTP ${response.status}: ${errText}`);
    }

    const resJson = (await response.json()) as any;
    return resJson.choices?.[0]?.message?.content || '';
  }

  /** Record an operator-facing alert (stderr + collected list). */
  private alert(message: string): void {
    console.error(`[ALERT] ${message}`);
    this.alerts.push(message);
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

/**
 * Compact, model-friendly rendering of a Zod validation error.
 *
 * Capped at the first 6 issues so the retry prompt stays bounded — the
 * model only needs a few representative problems to course-correct, and
 * larger payloads risk pushing context limits with no real signal gain.
 */
function formatZodIssues(error: ZodError): string {
  const issues = error.issues.slice(0, 6) as ZodIssue[];
  const lines = issues.map((i) => {
    const where = i.path.length > 0 ? i.path.join('.') : '(root)';
    return `  - ${where}: ${i.message}`;
  });
  if (error.issues.length > issues.length) {
    lines.push(`  - ...and ${error.issues.length - issues.length} more issue(s)`);
  }
  return lines.join('\n');
}

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
    // Plain parse failed — Gemini sometimes appends commentary, two
    // adjacent JSON objects, or trailing fences. Walk braces/brackets
    // to find the first balanced span and parse just that. Much more
    // reliable than lastIndexOf('}'), which lands inside a second
    // appended object and produces invalid concatenated JSON.
    const span = extractBalancedJson(s);
    if (span !== null) {
      try {
        return JSON.parse(span) as T;
      } catch {
        /* fall through to error */
      }
    }
    throw new Error(
      `LLM Client JSON parse failed; raw output starts: ${s.slice(0, 200)}`,
    );
  }
}

/**
 * Scan a string for the first balanced `{...}` or `[...]` span, respecting
 * string literals + escape sequences. Returns null if no balanced span is
 * found. Used by parseJson() to recover when the model trails extra prose
 * or accidentally emits two adjacent JSON objects.
 */
function extractBalancedJson(s: string): string | null {
  let start = -1;
  let depth = 0;
  let opener: '{' | '[' | '' = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') {
      if (start === -1) {
        start = i;
        opener = c;
      }
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        const expectedClose = opener === '{' ? '}' : ']';
        if (c === expectedClose) return s.slice(start, i + 1);
        return null;
      }
      if (depth < 0) return null;
    }
  }
  return null;
}
