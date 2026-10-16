import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/gateway/server.js';
import { convertOpenAIToCloudCode } from '../src/gateway/adapter.js';
import {
  LiveModelCatalog, resolveDynamicUpstreamModel, resolveFrameworkThinking,
  resolveThinkingConfig, toPublicModelCatalog
} from '../src/gateway/models.js';
import type { AppConfig, GoogleCloudCodePayload } from '../src/types.js';

// Includes internal helpers and old routes exactly as the control plane does.
const catalog: LiveModelCatalog = {
  models: {
    'gemini-3.8-flash-high': { supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'gemini-3.8-flash-medium': { supportsThinking: true },
    'gemini-3.8-flash-low': { supportsThinking: true },
    'gemini-3.8-flash-tiered': { supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'claude-sonnet-4-6': { supportsThinking: true, maxTokens: 250000, maxOutputTokens: 64000 },
    'claude-opus-4-6-thinking': { supportsThinking: true, maxOutputTokens: 64000 },
    'gpt-oss-120b-medium': { supportsThinking: true },
    'gemini-2.5-pro': {},
    'gemini-3-flash-agent': {},
    'gemini-3.5-flash-lite': {},
    'chat_23310': {},
    'tab_flash_lite_preview': {}
  },
  agentModelSorts: [{ groups: [{ modelIds: [
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'
  ] }] }]
};

const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const expectedLevels = ['low', 'low', 'medium', 'high', 'high', 'high'];

async function fixture() {
  let current = catalog;
  let unavailable = false;
  let fetches = 0;
  let captured: GoogleCloudCodePayload | undefined;
  let counted: GoogleCloudCodePayload | undefined;
  const pool = {
    releaseAccount() {}, recordTokenUsage() {}, getStats: () => ({ totalAccounts: 0 })
  };
  const executor = {
    async fetchAvailableModels() {
      fetches++;
      if (unavailable) throw new Error('catalog offline');
      return current;
    },
    async countTokens(payload: GoogleCloudCodePayload) { counted = payload; return { totalTokens: 12 }; },
    async executeWithRetry(payload: GoogleCloudCodePayload) {
      captured = payload;
      return {
        accountUsed: { id: 'memory-only' },
        bodyStream: (async function* () {
          yield Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":1}}}\n\n');
        })()
      };
    }
  };
  const app = await createServer({ apiMasterKey: 'test-key', adminPassword: 'test-admin' } as AppConfig,
    pool as any, {} as any, executor as any);
  const inject = (url: string, payload?: any, auth = true) => app.inject({
    method: payload ? 'POST' : 'GET', url,
    headers: auth ? { authorization: 'Bearer test-key' } : {},
    ...(payload ? { payload } : {})
  });
  return { app, inject, get captured() { return captured; }, get counted() { return counted; },
    get fetches() { return fetches; }, setCatalog(value: LiveModelCatalog) { current = value; },
    offline() { unavailable = true; } };
}

test('the picker excludes internal models and groups thinking presets without fabricating versions', () => {
  assert.deepEqual(toPublicModelCatalog(catalog).map(entry => entry.id), [
    'gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-oss-120b'
  ]);
  assert.equal(resolveDynamicUpstreamModel('gemini-3.8-flash[1M]', catalog).upstreamModel, 'gemini-3.8-flash-tiered');
  assert.equal(resolveDynamicUpstreamModel('claude-opus-4-6', catalog).upstreamModel, 'claude-opus-4-6-thinking');
  assert.throws(() => resolveDynamicUpstreamModel('gpt-4o', catalog), /not available/);
  assert.throws(() => resolveDynamicUpstreamModel('claude-sonnet-4-5', catalog), /not available/);
  assert.deepEqual(toPublicModelCatalog({ ...catalog, agentModelSorts: [] }), []);
});

test('discovery uses the live picker metadata and never serves a static fallback', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.inject('/v1/models', undefined, false)).statusCode, 401);
    assert.equal(f.fetches, 0);
    const first = await f.inject('/v1/models');
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.json().data.length, 4);
    assert.equal(first.json().data[1].context_length, 250000);
    f.setCatalog({ models: { 'gemini-3.1-pro-high': { maxOutputTokens: 65535 } },
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.1-pro-high'] }] }] });
    const second = await f.inject('/models');
    assert.deepEqual(second.json().data.map((m: any) => m.id), ['gemini-3.1-pro']);
    assert.equal(f.fetches, 2);
    f.offline();
    const third = await f.inject('/v1/v1/models');
    assert.equal(third.statusCode, 503, third.body);
    assert.equal(third.json().data, undefined);
    assert.equal(f.fetches, 3);
    assert.equal((await f.inject('/health')).statusCode, 200);
  } finally { await f.app.close(); }
});

test('six framework efforts reach Gemini through Chat, Responses and Anthropic without switching models', async () => {
  const f = await fixture();
  try {
    for (const [index, effort] of efforts.entries()) {
      const requests = [
        ['/v1/chat/completions', { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: effort }],
        ['/v1/responses', { model: 'gemini-3.8-flash', input: 'Hi', reasoning: { effort } }],
        ['/v1/messages', { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Hi' }],
          thinking: { type: 'adaptive' }, output_config: { effort } }]
      ] as const;
      for (const [url, payload] of requests) {
        const result = await f.inject(url, payload);
        assert.equal(result.statusCode, 200, `${url} ${effort}: ${result.body}`);
        assert.equal(f.captured?.model, 'gemini-3.8-flash-tiered');
        assert.deepEqual(f.captured?.request.generationConfig?.thinkingConfig, { thinkingLevel: expectedLevels[index] });
      }
    }
    assert.equal(f.fetches, 18);
    const noEffort = await f.inject('/v1/chat/completions', {
      model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Hi' }]
    });
    assert.equal(noEffort.statusCode, 200, noEffort.body);
    assert.equal(f.captured?.request.generationConfig?.thinkingConfig, undefined);
    const unknown = await f.inject('/v1/messages', { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(unknown.statusCode, 400, unknown.body);
    assert.equal(unknown.json().error.type, 'invalid_request_error');
    const count = await f.inject('/v1/messages/count_tokens', {
      model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Hi' }]
    });
    assert.equal(count.statusCode, 200, count.body);
    assert.equal(f.counted?.model, 'gemini-3.8-flash-tiered');
  } finally { await f.app.close(); }
});

test('disabled, adaptive, explicit budgets and effort precedence preserve framework intent', () => {
  assert.deepEqual(resolveFrameworkThinking({}), { effort: undefined });
  assert.deepEqual(resolveFrameworkThinking({ thinking: { type: 'adaptive' } }), { effort: 'auto' });
  assert.deepEqual(resolveFrameworkThinking({ thinking: { type: 'disabled' }, output_config: { effort: 'max' } }), { effort: 'none' });
  assert.deepEqual(resolveFrameworkThinking({ thinking: { budget_tokens: 1000 }, output_config: { effort: 'max' } }), { effort: 'max' });
  assert.deepEqual(resolveThinkingConfig('gemini-2.5-flash', 'none'), { thinkingBudget: 0 });
  assert.deepEqual(resolveThinkingConfig('gemini-2.5-flash', 'auto', -1), { thinkingBudget: -1 });
  assert.deepEqual(resolveThinkingConfig('gemini-2.5-pro', 'max'), { thinkingBudget: 32768 });
  assert.deepEqual(resolveThinkingConfig('gemini-2.5-flash', 'max'), { thinkingBudget: 24576 });
  assert.deepEqual(resolveThinkingConfig('claude-opus-4-6-thinking', 'max', undefined, undefined, 8192), { thinkingBudget: 8191 });
  assert.deepEqual(resolveThinkingConfig('gemini-3.1-pro', 'medium'), { thinkingLevel: 'high' });
  assert.throws(() => resolveFrameworkThinking({ reasoning_effort: 'ultra' }), /Unsupported/);
  assert.throws(() => resolveFrameworkThinking({ thinking_budget: -2 }), /budget/);
  const converted = convertOpenAIToCloudCode({ model: 'gemini-3.8-flash-high',
    messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'low' }, catalog);
  assert.equal(converted.payload.model, 'gemini-3.8-flash-tiered');
  assert.deepEqual(converted.payload.request.generationConfig?.thinkingConfig, { thinkingLevel: 'low' });
});

test('nested array tool schemas always contain concrete Google item schemas', () => {
  const converted = convertOpenAIToCloudCode({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'Find it' }],
    tools: [{ type: 'function', function: {
      name: 'search',
      parameters: {
        type: 'object', properties: {
          query: { type: 'object', properties: {
            where: { type: 'array', items: { type: 'array', items: {} } }
          } }
        }
      }
    } }]
  }, catalog);
  const where = converted.payload.request.tools?.[0]?.functionDeclarations?.[0]?.parameters?.properties?.query?.properties?.where;
  assert.deepEqual(where, { type: 'array', items: { type: 'array', items: { type: 'string' } } });
});
