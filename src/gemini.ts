/**
 * GeminiClient — handles swappable LLM engines supporting Gemini (Tier-3 default),
 * Anthropic, OpenAI, and custom OpenAI-compatible endpoints (Ollama/local).
 *
 * Keeps the name GeminiClient for complete backwards compatibility across the pipeline,
 * but implements generalized LLM calling mechanics under the hood.
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
      `LLM Client JSON parse failed; raw output starts: ${s.slice(0, 200)}`,
    );
  }
}
