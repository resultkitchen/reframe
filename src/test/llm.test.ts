/**
 * LLM Provider Routing and Client tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../gemini';
import type { PipelineConfig } from '../types';

test('llm client routes to Anthropic endpoint and structures visual specs correctly', async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = '';
  let fetchedOptions: any = null;

  // Mock global fetch
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchedUrl = String(url);
    fetchedOptions = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: 'Mocked Anthropic Response' }],
      }),
    } as Response;
  };

  try {
    const config = {
      llmProvider: 'anthropic',
      maxRetries: 0,
      callTimeoutMs: 10000,
      models: {
        agent4_code: 'claude-3-5-sonnet',
      },
    } as unknown as PipelineConfig;

    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const client = new GeminiClient(config);
    const response = await client.call({
      role: 'agent4_code',
      prompt: 'Refactor this page',
      systemInstruction: 'Be strict',
    });

    assert.equal(response, 'Mocked Anthropic Response');
    assert.equal(fetchedUrl, 'https://api.anthropic.com/v1/messages');
    assert.ok(fetchedOptions, 'fetch options should be set');
    assert.equal(fetchedOptions.method, 'POST');
    assert.equal(fetchedOptions.headers['x-api-key'], 'test-anthropic-key');
    assert.equal(fetchedOptions.headers['content-type'], 'application/json');

    const body = JSON.parse(fetchedOptions.body);
    assert.equal(body.model, 'claude-3-5-sonnet');
    assert.equal(body.system, 'Be strict');
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Refactor this page' }] }]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('llm client routes to OpenAI endpoint and sets json response format correctly', async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = '';
  let fetchedOptions: any = null;

  // Mock global fetch
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchedUrl = String(url);
    fetchedOptions = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"status": "ok"}' } }],
      }),
    } as Response;
  };

  try {
    const config = {
      llmProvider: 'openai',
      maxRetries: 0,
      callTimeoutMs: 10000,
      models: {
        agent1_audit: 'gpt-4o',
      },
    } as unknown as PipelineConfig;

    process.env.OPENAI_API_KEY = 'test-openai-key';

    const client = new GeminiClient(config);
    const response = await client.callJson<{ status: string }>({
      role: 'agent1_audit',
      prompt: 'Audit settings page',
      systemInstruction: 'Output JSON',
    });

    assert.deepEqual(response, { status: 'ok' });
    assert.equal(fetchedUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(fetchedOptions.headers['authorization'], 'Bearer test-openai-key');

    const body = JSON.parse(fetchedOptions.body);
    assert.equal(body.model, 'gpt-4o');
    assert.deepEqual(body.response_format, { type: 'json_object' });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test('llm client routes to custom OpenAI-compatible endpoint correctly', async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = '';
  let fetchedOptions: any = null;

  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchedUrl = String(url);
    fetchedOptions = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Local Model Response' } }],
      }),
    } as Response;
  };

  try {
    const config = {
      llmProvider: 'openai-compatible',
      maxRetries: 0,
      callTimeoutMs: 10000,
      models: {
        agent3_design: 'llama3-70b',
      },
    } as unknown as PipelineConfig;

    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1/';
    process.env.OPENAI_API_KEY = 'ollama-secret';

    const client = new GeminiClient(config);
    const response = await client.call({
      role: 'agent3_design',
      prompt: 'Apply style design',
    });

    assert.equal(response, 'Local Model Response');
    assert.equal(fetchedUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(fetchedOptions.headers['authorization'], 'Bearer ollama-secret');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  }
});
