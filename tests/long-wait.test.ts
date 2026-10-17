import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import fastify from 'fastify';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';
import type { AppConfig } from '../src/types.js';

/**
 * The acceptance test for "长思考不断连": the upstream stays completely silent
 * for far longer than a client or reverse proxy would tolerate, and the
 * connection must survive on keepalive frames alone.
 *
 * It takes ~80 seconds, so it only runs when explicitly requested:
 *   RUN_LONG_TESTS=1 npm test
 */

delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.DEFAULT_PROXY_URL;

const UPSTREAM_SILENCE_MS = Number(process.env.LONG_TEST_SILENCE_MS || 80_000);
const KEEPALIVE_MS = 10_000;
const RUN = process.env.RUN_LONG_TESTS === '1';

test('a silent upstream longer than 75s keeps the client connection alive', { skip: !RUN }, async () => {
  const executor = {
    fetchAvailableModels: async () => ({ models: { 'claude-sonnet-4-6': { maxOutputTokens: 64000 } } }),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => {
      await new Promise(resolve => setTimeout(resolve, UPSTREAM_SILENCE_MS));
      return {
        accountUsed: { id: 'acc-1' },
        bodyStream: (async function* () {
          yield Buffer.from(`data: ${JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: 'finally' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 }
            }
          })}\n\n`);
        })()
      };
    }
  };
  const app = fastify({ logger: false });
  registerAnthropicRoutes(
    app,
    { streamKeepaliveMs: KEEPALIVE_MS } as AppConfig,
    { releaseAccount() {}, recordTokenUsage() {} } as any,
    executor as any,
    () => {}
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');

  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'think for a very long time' }],
        stream: true,
        max_tokens: 64
      })
    });
    assert.equal(response.status, 200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const keepaliveTimes: number[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      body += text;
      if (text.includes(': keepalive')) keepaliveTimes.push(Date.now() - startedAt);
    }

    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= UPSTREAM_SILENCE_MS, `stream finished too early (${elapsed}ms)`);
    assert.ok(body.includes('event: message_stop'), 'the stream must complete after the silence');
    assert.ok(keepaliveTimes.length >= 5, `expected keepalive frames during the wait, saw ${keepaliveTimes.length}`);
    assert.ok(keepaliveTimes[0] < 15_000, `first keepalive should arrive early, arrived at ${keepaliveTimes[0]}ms`);
    console.log(`[long-wait] survived ${Math.round(elapsed / 1000)}s of upstream silence with ${keepaliveTimes.length} keepalive frames`);
  } finally {
    await app.close();
  }
});

test('a silent upstream longer than 75s is not aborted by the configured budget', { skip: !RUN }, async () => {
  // Same shape, but through the real executor so the upstream timeouts that
  // would cut a long generation are the ones under test.
  const { RequestExecutor } = await import('../src/pool/breaker.js');

  let requests = 0;
  const upstream = http.createServer((_req, res) => {
    requests++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'late' }] }, finishReason: 'STOP' }] } })}\n\n`);
      res.end();
    }, UPSTREAM_SILENCE_MS);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

  const acc: any = {
    id: 'acc-1',
    email: 'one@example.com',
    refreshToken: 'r',
    accessToken: 'a',
    accessTokenExpiresAt: Date.now() + 600_000,
    status: 'active',
    cooldownUntil: 0,
    activeConcurrency: 0,
    maxConcurrency: 5,
    totalRequests: 0,
    failedRequests: 0,
    lastUsedAt: 0,
    createdAt: Date.now()
  };
  const pool = {
    acquireAccount: () => { acc.activeConcurrency++; return acc; },
    releaseAccount: () => { acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1); },
    getAllAccounts: () => [acc],
    clearSessionBinding: () => {},
    getSessionBinding: () => undefined
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, {
    port: 0,
    host: '127.0.0.1',
    apiMasterKey: '',
    adminPassword: '',
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}/v1internal:streamGenerateContent?alt=sse`,
    defaultMaxConcurrency: 5,
    cooldownSeconds: 60,
    tokenRefreshIntervalMs: 60_000,
    minRequestIntervalMs: 0
  } as AppConfig);

  try {
    const startedAt = Date.now();
    const result = await executor.executeWithRetry(
      { model: 'gemini-3.8-flash', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } },
      1
    );
    let body = '';
    for await (const chunk of result.bodyStream) body += chunk.toString();
    const elapsed = Date.now() - startedAt;

    assert.equal(requests, 1);
    assert.ok(elapsed >= UPSTREAM_SILENCE_MS, `the generation was cut at ${elapsed}ms`);
    assert.match(body, /late/);
    // On success the executor hands the lease to the caller, which releases it
    // once the stream is consumed; assert that contract explicitly.
    assert.equal(acc.activeConcurrency, 1);
    pool.releaseAccount();
    assert.equal(acc.activeConcurrency, 0);
    console.log(`[long-wait] executor held the connection for ${Math.round(elapsed / 1000)}s of silence`);
  } finally {
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
