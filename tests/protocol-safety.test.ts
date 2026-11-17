import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAdminRoutes } from '../src/admin/routes.js';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';
import { classifyUpstreamError, retryAfterMs } from '../src/pool/error-policy.js';
import { resolveDynamicUpstreamModel } from '../src/gateway/models.js';
import { config, fixture } from './fixtures.js';

test('retry delay uses the longest header or protobuf hint', () => {
  const body = JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: { seconds: '5', nanos: 500000000 } }
  ] } });
  assert.equal(retryAfterMs({ 'retry-after': ['1', '2'] }, body, 0), 5500);
  assert.equal(retryAfterMs({}, '{"error":{"details":[{"retryDelay":"1.5s"}]}}', 0), 1500);
  assert.equal(retryAfterMs({}, '{"error":{"details":[{"retryDelay":"1m30s"}]}}', 0), 90000);
  assert.equal(retryAfterMs({}, '{"error":{"details":[{"retryDelay":"broken"}]}}', 12000), 12000);
  assert.equal(retryAfterMs({ 'Retry-After': '172800' }), 172800000);
  const future = new Date(Date.now() + 60000).toUTCString();
  assert.ok(retryAfterMs({ 'retry-after': future }) >= 59000);
});

test('generic RESOURCE_EXHAUSTED is not proof of balance exhaustion', () => {
  assert.equal(classifyUpstreamError(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Resource has been exhausted (e.g. check quota)."}}').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(429, '{"error":{"details":[{"@type":"google.rpc.QuotaFailure","violations":[{"description":"RPM"}]}]}}').kind, 'rate_limit');
});

test('only Google HTTPS verification links can reach the account UI', () => {
  for (const url of ['javascript:alert(1)', 'https://google.com.evil.invalid', 'http://accounts.google.com']) {
    const body = JSON.stringify({ error: { details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: url } }] } });
    assert.equal(classifyUpstreamError(403, body).validationUrl, undefined);
  }
  assert.equal(classifyUpstreamError(403, '{"error":{"details":[{"reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/check"}}]}}').validationUrl, 'https://accounts.google.com/check');
});

test('model selection cannot choose a hidden preset outside the live picker', () => {
  const model = resolveDynamicUpstreamModel('gemini-3.8-flash[1M]', {
    models: { 'gemini-3.8-flash-high': {}, 'gemini-3.8-flash-medium': {} },
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-medium'] }] }]
  });
  assert.equal(model.upstreamModel, 'gemini-3.8-flash-medium');
  assert.throws(() => resolveDynamicUpstreamModel({} as any), /model must be/);
});

test('Gemini 3.8 Flash follows the live picker preset matching requested thinking effort', () => {
  const catalog = {
    models: {
      'gemini-3.8-flash-high': { supportedThinkingLevels: ['low', 'medium', 'high'] },
      'gemini-3.8-flash-medium': { supportedThinkingLevels: ['low', 'medium', 'high'] },
      'gemini-3.8-flash-low': { supportedThinkingLevels: ['low', 'medium', 'high'] }
    },
    agentModelSorts: [{ groups: [{ modelIds: [
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'
    ] }] }]
  };
  assert.equal(resolveDynamicUpstreamModel('gemini-3.8-flash', catalog, 'low').upstreamModel, 'gemini-3.8-flash-low');
  assert.equal(resolveDynamicUpstreamModel('gemini-3.8-flash', catalog, 'medium').upstreamModel, 'gemini-3.8-flash-medium');
  assert.equal(resolveDynamicUpstreamModel('gemini-3.8-flash', catalog, 'high').upstreamModel, 'gemini-3.8-flash-high');
  assert.equal(resolveDynamicUpstreamModel('gemini-3.8-flash', catalog).upstreamModel, 'gemini-3.8-flash-medium');
});

test('account list and mutation endpoints never return OAuth credentials', async t => {
  const { pool, accounts } = fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  registerAdminRoutes(app, pool, { refreshSingleAccount: async () => true } as any, config,
    { fetchQuotaForAccount: async () => ({ gemini5hFraction: 1 }) } as any);
  const headers = { 'x-admin-password': config.adminPassword };
  const routes: any[] = [
    { method: 'GET', url: '/api/admin/accounts' },
    { method: 'POST', url: '/api/admin/accounts', payload: { email: 'new@example.invalid', refreshToken: 'secret-new-refresh', accessToken: 'secret-new-access' } },
    { method: 'PUT', url: '/api/admin/accounts/' + accounts[0].id, payload: { maxConcurrency: 2 } },
    { method: 'POST', url: '/api/admin/accounts/' + accounts[0].id + '/refresh' },
    { method: 'POST', url: '/api/admin/accounts/' + accounts[0].id + '/reset' },
    { method: 'PUT', url: '/api/admin/accounts/' + accounts[0].id + '/status', payload: { status: 'active' } },
    { method: 'POST', url: '/api/admin/accounts/' + accounts[0].id + '/quota' }
  ];
  for (const route of routes) {
    const response = await app.inject({ ...route, headers });
    assert.equal(response.statusCode, 200, route.url);
    assert.doesNotMatch(response.body, /secret-/);
    const body = response.json();
    for (const account of body.accounts || [body.account]) {
      assert.equal(account.refreshToken, undefined);
      assert.equal(account.accessToken, undefined);
      assert.ok(account.id);
    }
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/accounts' })).statusCode, 401);
});

test('invalid Anthropic requests fail before any model discovery or generation', async t => {
  const app = Fastify();
  t.after(() => app.close());
  registerAnthropicRoutes(app, config, {} as any, {
    fetchAvailableModels: () => assert.fail('invalid request reached upstream')
  } as any, () => {});
  for (const bad of [null, { model: '' }, { model: {} }, { messages: [] }, { max_tokens: -1 }, { max_tokens: 1.5 }, { system: {} }, { stream: 'false' }, { tools: [null] }, { messages: [null] }]) {
    const payload = bad === null ? null : { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], ...bad };
    for (const url of ['/v1/messages', '/v1/messages/count_tokens']) {
      const response = await app.inject({ method: 'POST', url, payload });
      assert.equal(response.statusCode, 400, JSON.stringify(bad));
    }
  }
});
