import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createServer } from '../src/gateway/server.js';

// The executor falls back to the ambient proxy env vars when no proxy is
// configured, which would route loopback requests through a real proxy.
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.DEFAULT_PROXY_URL;
import { RequestExecutor, UpstreamRequestError } from '../src/pool/breaker.js';
import type { Account, AppConfig, GoogleCloudCodePayload } from '../src/types.js';

function account(): Account {
  return {
    id: 'acc-test',
    email: 'test@example.com',
    refreshToken: 'refresh',
    accessToken: 'access',
    accessTokenExpiresAt: Date.now() + 60_000,
    status: 'active',
    cooldownUntil: 0,
    activeConcurrency: 0,
    maxConcurrency: 5,
    totalRequests: 0,
    failedRequests: 0,
    lastUsedAt: 0,
    createdAt: Date.now()
  };
}

async function withUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}/v1internal:streamGenerateContent?alt=sse` };
}

function config(upstreamUrl: string): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    apiMasterKey: '',
    adminPassword: '',
    upstreamUrl,
    defaultMaxConcurrency: 5,
    cooldownSeconds: 60,
    tokenRefreshIntervalMs: 60_000,
    minRequestIntervalMs: 0
  };
}

test('model discovery coalesces concurrent calls and serves a short cache', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: { 'gemini-3.8-flash': {} } }));
  });
  const acc = account();
  const pool = {
    acquireAccount: () => { acc.activeConcurrency++; return acc; },
    releaseAccount: () => { acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1); }
  };
  const refresher = { refreshSingleAccount: async () => true };
  const executor = new RequestExecutor(pool as any, refresher as any, config(upstream.url));

  try {
    await Promise.all([
      executor.fetchAvailableModels(),
      executor.fetchAvailableModels(),
      executor.fetchAvailableModels()
    ]);
    assert.equal(calls, 1);
    await executor.fetchAvailableModels();
    assert.equal(calls, 1);
    await executor.fetchAvailableModels(3, { forceRefresh: true });
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
});

test('countTokens acquires the supplied session binding key', async () => {
  const upstream = await withUpstream((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ totalTokens: 7 }));
  });
  const acc = account();
  const calls: Array<[Set<string>, 'claude' | 'gemini' | undefined, string | undefined]> = [];
  const pool = {
    acquireAccount: (excluded: Set<string>, family?: 'claude' | 'gemini', sessionKey?: string) => {
      calls.push([excluded, family, sessionKey]);
      acc.activeConcurrency++;
      return acc;
    },
    releaseAccount: () => { acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1); }
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));
  const payload: GoogleCloudCodePayload = {
    model: 'claude-sonnet-4-6',
    request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
  };

  try {
    const result = await executor.countTokens(payload, 1, 'request:session-1');
    assert.equal(result.totalTokens, 7);
    assert.equal(calls[0]?.[1], 'claude');
    assert.equal(calls[0]?.[2], 'request:session-1');
  } finally {
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
});

test('a 429 is cooled down and returned without rotating to another account', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 429;
    res.setHeader('retry-after', '9');
    res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }));
  });
  const acc = account();
  const pool = {
    acquireAccount: () => { acc.activeConcurrency++; return acc; },
    releaseAccount: (_id: string, error?: { code: number; message: string; retryAfterMs?: number }) => {
      acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1);
      if (error) {
        acc.status = 'cooldown';
        acc.cooldownUntil = Date.now() + (error.retryAfterMs || 0);
      }
    },
    getAllAccounts: () => [acc]
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));
  const payload: GoogleCloudCodePayload = {
    model: 'gemini-3.8-flash',
    request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
  };

  try {
    await assert.rejects(
      executor.executeWithRetry(payload, 3),
      (error: any) => error?.statusCode === 429
    );
    assert.equal(calls, 1);
    assert.equal(acc.status, 'cooldown');
    assert.ok(acc.cooldownUntil > Date.now());
  } finally {
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
});

test('an invalid countTokens success body releases its lease exactly once', async () => {
  const upstream = await withUpstream((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({}));
  });
  const acc = account();
  let releases = 0;
  const pool = {
    acquireAccount: () => { acc.activeConcurrency++; return acc; },
    releaseAccount: () => {
      releases++;
      acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1);
    }
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));
  const payload: GoogleCloudCodePayload = {
    model: 'gemini-3.8-flash',
    request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
  };

  try {
    await assert.rejects(executor.countTokens(payload, 1), /did not include totalTokens/);
    assert.equal(releases, 1);
    assert.equal(acc.activeConcurrency, 0);
  } finally {
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
});

test('429 Retry-After is returned to API clients', async () => {
  const app = await createServer(config('http://127.0.0.1:1/v1internal:streamGenerateContent?alt=sse'), {
    releaseAccount() {},
    recordTokenUsage() {},
    getStats: () => ({ totalAccounts: 0 }),
    getAllAccounts: () => []
  } as any, {} as any, {
    fetchAvailableModels: async () => ({ models: { 'gemini-3.8-flash': {} }, agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash'] }] }] }),
    executeWithRetry: async () => {
      throw new UpstreamRequestError(429, '{"error":"rate limited"}', { 'retry-after': '11' });
    }
  } as any);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hello' }] }
    });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(response.headers['retry-after'], '11');
  } finally {
    await app.close();
  }
});

test('does not replay a generation after the request was sent but the socket closes', async () => {
  let calls = 0;
  const upstream = await withUpstream((req) => {
    calls++;
    req.socket.destroy();
  });
  const acc = account();
  const pool = {
    acquireAccount: () => { acc.activeConcurrency++; return acc; },
    releaseAccount: () => { acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1); },
    getAllAccounts: () => [acc]
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));
  const payload: GoogleCloudCodePayload = {
    model: 'gemini-3.8-flash',
    request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
  };

  try {
    await assert.rejects(
      executor.executeWithRetry(payload, 3),
      (error: any) => error?.statusCode === 502 && /Automatic replay stopped/.test(error.message)
    );
    assert.equal(calls, 1);
    assert.equal(acc.activeConcurrency, 0);
  } finally {
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
});
