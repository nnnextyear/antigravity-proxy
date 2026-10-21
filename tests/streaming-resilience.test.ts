import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastify from 'fastify';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';
import { ContextOverflowError, LocationNotSupportedError, UpstreamRequestError } from '../src/pool/breaker.js';
import { AccountSchedulingError } from '../src/pool/scheduling.js';
import type { AppConfig } from '../src/types.js';

// The gateway must never reach a real proxy or the real upstream from a test.
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.DEFAULT_PROXY_URL;

const KEEPALIVE_MS = 1000;

function config(): AppConfig {
  return { streamKeepaliveMs: KEEPALIVE_MS } as AppConfig;
}

function catalog() {
  return { models: { 'claude-sonnet-4-6': { maxOutputTokens: 64000 } } };
}

function googleChunk(text: string) {
  return Buffer.from(`data: ${JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 }
    }
  })}\n\n`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Drive one streaming Anthropic request against a real socket. */
async function startGateway(executor: any, pool: any) {
  const app = fastify({ logger: false });
  registerAnthropicRoutes(app, config(), pool, executor, () => {});
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return { app, url: `http://127.0.0.1:${address.port}/v1/messages` };
}

async function streamRequest(url: string, init: RequestInit = {}, budgetMs = 8000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      max_tokens: 64
    }),
    ...init
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let timedOut = false;
  const startedAt = Date.now();
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, budgetMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    // A cancelled or aborted stream is an expected outcome in these tests.
  } finally {
    clearTimeout(timer);
  }
  return { response, body, timedOut, elapsedMs: Date.now() - startedAt };
}

test('a long silent upstream is covered by keepalive frames and still completes', async () => {
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => {
      await sleep(KEEPALIVE_MS + 800);
      return {
        accountUsed: { id: 'acc-1' },
        bodyStream: (async function* () { yield googleChunk('hello'); })()
      };
    }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { response, body, timedOut } = await streamRequest(url);
    assert.equal(response.status, 200);
    assert.equal(timedOut, false, 'stream should finish on its own');
    assert.ok(body.includes(': keepalive'), `expected a keepalive frame, got: ${body.slice(0, 300)}`);
    assert.ok(body.includes('event: message_start'), 'expected the SSE stream to open');
    assert.ok(body.includes('event: message_stop'), 'expected the stream to finish');
    assert.ok(
      body.indexOf(': keepalive') < body.indexOf('event: message_start'),
      'keepalive must cover the wait BEFORE the upstream answers'
    );
  } finally {
    await app.close();
  }
});

test('a context-overflow after the waiting keepalive reaches the client instead of hanging', async () => {
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => {
      await sleep(KEEPALIVE_MS + 600);
      throw new ContextOverflowError(400, 'input token count exceeds the maximum number of tokens allowed');
    }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { response, body, timedOut, elapsedMs } = await streamRequest(url);
    // The keepalive already locked HTTP 200, so the error must arrive in-band.
    assert.equal(response.status, 200);
    assert.equal(timedOut, false, 'the client must not be left hanging');
    assert.ok(elapsedMs < 6000, `error frame arrived after ${elapsedMs}ms`);
    assert.ok(body.includes('event: error'), `expected an SSE error event, got: ${body.slice(0, 300)}`);
    assert.match(body, /invalid_request_error/);
    assert.match(body, /prompt is too long/i);
    assert.match(body, /context_length_exceeded/);
  } finally {
    await app.close();
  }
});

test('a location block after the waiting keepalive reaches the client', async () => {
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => {
      await sleep(KEEPALIVE_MS + 600);
      throw new LocationNotSupportedError(403, 'User location is not supported for the API use.');
    }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { body, timedOut } = await streamRequest(url);
    assert.equal(timedOut, false);
    assert.ok(body.includes('event: error'), `expected an SSE error event, got: ${body.slice(0, 300)}`);
    assert.match(body, /location is not supported/i);
  } finally {
    await app.close();
  }
});

test('a local rate limit after the waiting keepalive carries 503 and its retry hint in-band', async () => {
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => {
      await sleep(KEEPALIVE_MS + 600);
      throw new AccountSchedulingError('rate_limited', 'Upstream temporarily limited request frequency.', 7);
    }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { body, timedOut } = await streamRequest(url);
    assert.equal(timedOut, false);
    assert.ok(body.includes('event: error'), `expected an SSE error event, got: ${body.slice(0, 300)}`);
    assert.match(body, /retry_after/);
    assert.match(body, /"retry_after":"7"/);
    assert.match(body, /"status":503/);
    assert.match(body, /"code":"rate_limited"/);
    assert.ok(!body.includes('429'));
  } finally {
    await app.close();
  }
});

test('errors before the first keepalive still use a real HTTP status', async () => {
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => { throw new AccountSchedulingError('rate_limited', 'Upstream temporarily limited request frequency.', 11); }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { response } = await streamRequest(url);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '11');
  } finally {
    await app.close();
  }
});

test('the gateway completes when the executor recovers from an auxiliary preflight failure', async () => {
  let generated = 0;
  const executor = {
    fetchAvailableModels: async () => catalog(),
    executeWithRetry: async (_payload: unknown, _retries: number, _key: string, _signal: AbortSignal, _id: string, preflight: boolean) => {
      assert.equal(preflight, true);
      generated++;
      return {
        accountUsed: { id: 'acc-1' },
        bodyStream: (async function* () { yield googleChunk('hello'); })()
      };
    }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { body } = await streamRequest(url, {}, 5000);
    assert.equal(generated, 1);
    assert.ok(body.includes('event: message_stop'), `expected a completed stream, got: ${body.slice(0, 300)}`);
  } finally {
    await app.close();
  }
});

test('an account-level preflight rejection from the executor reaches the gateway client', async () => {
  let executions = 0;
  const executor = {
    fetchAvailableModels: async () => catalog(),
    executeWithRetry: async () => { executions++; throw new UpstreamRequestError(403, '{"error":{"reason":"TOS_VIOLATION"}}'); }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { response } = await streamRequest(url);
    assert.equal(response.status, 403);
    assert.equal(executions, 1);
  } finally {
    await app.close();
  }
});

test('a client disconnect aborts the upstream request and releases the lease exactly once', async () => {
  let releases = 0;
  let inFlight = 0;
  let upstreamAborted = false;
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async (_payload: any, _retries: number, _key: string, signal?: AbortSignal) => {
      inFlight++;
      return {
        accountUsed: { id: 'acc-1' },
        bodyStream: (async function* () {
          yield googleChunk('partial');
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 30_000);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              upstreamAborted = true;
              reject(new Error('Request aborted by client.'));
            }, { once: true });
          });
        })()
      };
    }
  };
  const pool = {
    releaseAccount: () => { releases++; inFlight = Math.max(0, inFlight - 1); },
    recordTokenUsage() {}
  };
  const { app, url } = await startGateway(executor, pool);
  const controller = new AbortController();

  try {
    const request = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        max_tokens: 64
      }),
      signal: controller.signal
    }).catch(() => undefined);

    await sleep(600);
    controller.abort();
    await request;
    await sleep(600);

    assert.equal(upstreamAborted, true, 'the upstream request must be cancelled with the client');
    assert.equal(releases, 1, 'the lease must be released exactly once');
    assert.equal(inFlight, 0, 'no account slot may stay occupied');
  } finally {
    await app.close();
  }
});

test('a non-streaming request never emits keepalive frames', async () => {
  const executor = {
    fetchAvailableModels: async () => catalog(),
    countTokens: async () => ({ totalTokens: 10 }),
    executeWithRetry: async () => {
      await sleep(KEEPALIVE_MS + 300);
      return {
        accountUsed: { id: 'acc-1' },
        bodyStream: (async function* () { yield googleChunk('hello'); })()
      };
    }
  };
  const app = fastify({ logger: false });
  registerAnthropicRoutes(app, config(), { releaseAccount() {}, recordTokenUsage() {} } as any, executor as any, () => {});

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 64
      }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('keepalive'));
    assert.equal(response.json().type, 'message');
  } finally {
    await app.close();
  }
});

test('upstream statuses map to the right Anthropic error types', async () => {
  const { anthropicErrorType } = await import('../src/gateway/streaming.js');
  const table: Array<[number, string]> = [
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [503, 'overloaded_error'],
    [500, 'api_error']
  ];
  for (const [status, expected] of table) {
    assert.equal(anthropicErrorType(status), expected, `HTTP ${status}`);
  }
});

test('a client disconnect cancels model discovery before the stream starts', async () => {
  let discoveryAborted = false;
  let generationStarted = false;
  const executor = {
    fetchAvailableModels: async (_retries: number, _options: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          discoveryAborted = true;
          reject(new Error('Request aborted by client.'));
        }, { once: true });
      }),
    countTokens: async () => ({ totalTokens: 1 }),
    executeWithRetry: async () => { generationStarted = true; throw new Error('must not run'); }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });
  const controller = new AbortController();

  try {
    const request = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        max_tokens: 64
      }),
      signal: controller.signal
    }).catch(() => undefined);

    await sleep(400);
    controller.abort();
    await request;
    await sleep(400);

    assert.equal(discoveryAborted, true, 'the abort must reach model discovery, not just the generation call');
    assert.equal(generationStarted, false, 'a cancelled request must not start generating');
  } finally {
    await app.close();
  }
});

test('a slow model-discovery failure reaches a streaming client instead of hanging', async () => {
  const executor = {
    fetchAvailableModels: async () => {
      await sleep(KEEPALIVE_MS + 600);
      throw new UpstreamRequestError(503, 'catalog unavailable');
    },
    countTokens: async () => ({ totalTokens: 1 }),
    executeWithRetry: async () => { throw new Error('generation must not run'); }
  };
  const { app, url } = await startGateway(executor, { releaseAccount() {}, recordTokenUsage() {} });

  try {
    const { body, timedOut } = await streamRequest(url);
    assert.equal(timedOut, false, 'the client must not be left on an endless keepalive stream');
    assert.ok(body.includes('event: error'), `expected an in-band error frame, got: ${body.slice(0, 300)}`);
    assert.match(body, /catalog unavailable/);
  } finally {
    await app.close();
  }
});
