import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { RequestExecutor, UpstreamRequestError, LocationNotSupportedError } from '../src/pool/breaker.js';
import type { Account, AppConfig, GoogleCloudCodePayload } from '../src/types.js';

delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.DEFAULT_PROXY_URL;

interface Release { code?: number; message?: string; retryAfterMs?: number; family?: string; recoverable?: boolean }

let clearBindings = 0;

/** Mirror AccountPool's lease accounting so leaks and double releases show up. */
function makePool(account: Account) {
  const releases: Release[] = [];
  return {
    releases,
    acquireAccount: () => { account.activeConcurrency++; return account; },
    releaseAccount: (_id: string, error?: { code: number; message: string; retryAfterMs?: number; recoverable?: boolean }, family?: string) => {
      account.activeConcurrency = Math.max(0, account.activeConcurrency - 1);
      releases.push({ code: error?.code, message: error?.message, retryAfterMs: error?.retryAfterMs, family, recoverable: error?.recoverable });
    },
    getAllAccounts: () => [account],
    clearSessionBinding: () => { clearBindings++; },
    getSessionBinding: () => undefined
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'one@example.com',
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
    createdAt: Date.now(),
    ...overrides
  };
}

async function withUpstream(handler: http.RequestListener) {
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

function payload(): GoogleCloudCodePayload {
  return { model: 'gemini-3.8-flash', request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } };
}

const closeServer = (server: http.Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('a malformed proxy URL still releases the account lease', async () => {
  const upstream = await withUpstream((_req, res) => { res.end('never reached'); });
  const acc = account({ proxyUrl: '127.0.0.1:7897' }); // no scheme: new URL() throws
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.executeWithRetry(payload(), 1));
    assert.equal(acc.activeConcurrency, 0, 'a throw while building the pool must not leak the lease');
    assert.equal(pool.releases.length, 1, 'the lease must be released exactly once, not zero and not twice');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a generation 429 cools the account down and is never rotated', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 429;
    res.setHeader('retry-after', '9');
    res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted' } }));
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.executeWithRetry(payload(), 3), (error: any) => error?.statusCode === 429);
    assert.equal(calls, 1, 'one 429 must not become a burst of retries');
    assert.equal(acc.activeConcurrency, 0);
    assert.equal(pool.releases.length, 1, 'the lease must be released exactly once');
    assert.equal(pool.releases[0].code, 429);
    assert.ok((pool.releases[0].retryAfterMs ?? 0) >= 9000, 'Retry-After must drive the cooldown');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a policy 403 marks the account terminal and is not rotated', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: {
        code: 403,
        reason: 'TOS_VIOLATION',
        message: 'This service has been disabled in this account for violation of Terms of Service.'
      }
    }));
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.executeWithRetry(payload(), 3), (error: any) => error?.statusCode === 403);
    assert.equal(calls, 1);
    assert.equal(pool.releases.length, 1);
    assert.equal(pool.releases[0].code, 403, 'a policy termination must reach the pool as 403 (terminal)');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a quota flavoured 403 cools the account down instead of killing it', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 403, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted' } }));
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.executeWithRetry(payload(), 3), (error: any) => error?.statusCode === 403);
    assert.equal(calls, 1, 'a 403 must never trigger account rotation');
    assert.equal(pool.releases.length, 1);
    assert.equal(pool.releases[0].code, 403);
    assert.equal(pool.releases[0].recoverable, true, 'a recoverable 403 must park the account, not kill it');
    assert.ok((pool.releases[0].retryAfterMs ?? 0) >= 5 * 60 * 1000, 'the cooldown floor must apply');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a location 403 stops the request, clears the binding and retires the exit pool', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 403;
    res.end('User location is not supported for the API use.');
  });
  const acc = account();
  const pool = makePool(acc);
  clearBindings = 0;
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.executeWithRetry(payload(), 3), (error: any) => error instanceof LocationNotSupportedError);
    assert.equal(calls, 1);
    assert.equal(clearBindings, 1, 'the conversation binding must be dropped for a blocked exit');
    assert.equal(acc.activeConcurrency, 0);
  } finally {
    await closeServer(upstream.server);
  }
});

test('a 429 whose body cannot be read still cools the account down', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.writeHead(429, { 'content-type': 'application/json', 'content-length': '400', 'retry-after': '11' });
    res.write('{"error":');
    res.flushHeaders();
    // Truncate the body: reading it will fail, the status must survive.
    setTimeout(() => res.socket?.destroy(), 30);
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.executeWithRetry(payload(), 3));
    assert.equal(calls, 1);
    assert.equal(pool.releases.length, 1);
    assert.equal(pool.releases[0].code, 429, 'an unreadable body must not lose the rate-limit signal');
    assert.ok((pool.releases[0].retryAfterMs ?? 0) >= 11_000);
  } finally {
    await closeServer(upstream.server);
  }
});

test('the upstream session id follows the account, not the conversation', async () => {
  const seen: string[] = [];
  let served: string[] = [];
  const upstream = await withUpstream((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(raw)?.request?.sessionId ?? 'none');
      served.push(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end('{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}');
    });
  });
  const accA = account({ id: 'acc-A', accessToken: 'token-A' });
  const accB = account({ id: 'acc-B', accessToken: 'token-B' });
  let current = accA;
  const releases: Release[] = [];
  const pool = {
    releases,
    acquireAccount: () => { current.activeConcurrency++; return current; },
    releaseAccount: (_id: string, error?: any) => { releases.push({ code: error?.code }); },
    getAllAccounts: () => [accA, accB],
    clearSessionBinding: () => {},
    getSessionBinding: () => undefined
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await executor.executeWithRetry(payload(), 1, 'session-1');
    await executor.executeWithRetry(payload(), 1, 'session-1');
    current = accB;
    await executor.executeWithRetry(payload(), 1, 'session-1');

    assert.equal(seen.length, 3, `expected three upstream calls, saw ${seen.length}`);
    assert.notEqual(seen[0], 'none', 'the upstream session id must be attached');
    assert.equal(seen[1], seen[0], 'one conversation on one account keeps one affinity token (prompt cache)');
    assert.notEqual(seen[2], seen[0], 'a migrated conversation must not reuse another account\'s session id');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a socks5 proxy is rejected with an actionable message', async () => {
  const upstream = await withUpstream((_req, res) => { res.end('never reached'); });
  const acc = account({ proxyUrl: 'socks5://127.0.0.1:1080' });
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    const error: any = await executor.executeWithRetry(payload(), 1).catch(error => error);
    assert.match(String(error?.message), /HTTP\/HTTPS/);
    assert.equal(acc.activeConcurrency, 0, 'a rejected proxy must not leak the lease');
  } finally {
    await closeServer(upstream.server);
  }
});

test('generation starts on one account are spaced out', async () => {
  const started: number[] = [];
  const upstream = await withUpstream((_req, res) => {
    started.push(Date.now());
    res.setHeader('content-type', 'application/json');
    res.end('{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}');
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, {
    ...config(upstream.url),
    minRequestIntervalMs: 300
  });

  try {
    await executor.executeWithRetry(payload(), 1);
    await executor.executeWithRetry(payload(), 1);
    assert.equal(started.length, 2);
    assert.ok(
      started[1] - started[0] >= 240,
      `two generations must not fire in the same tick (gap was ${started[1] - started[0]}ms)`
    );
  } finally {
    await closeServer(upstream.server);
  }
});

test('a transient catalog 403 cools the account instead of killing it', async () => {
  const upstream = await withUpstream((_req, res) => {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 403, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted' } }));
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.fetchAvailableModels(1), (error: any) => error?.statusCode === 403);
    assert.equal(pool.releases.length, 1);
    assert.equal(pool.releases[0].code, 403);
    assert.equal(pool.releases[0].recoverable, true, 'the model-list path must park recoverable 403s, not kill the account');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a policy catalog 403 still marks the account terminal', async () => {
  const upstream = await withUpstream((_req, res) => {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 403, reason: 'TOS_VIOLATION', message: 'This service has been disabled in this account for violation of Terms of Service.' } }));
  });
  const acc = account();
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    await assert.rejects(executor.fetchAvailableModels(1), (error: any) => error?.statusCode === 403);
    assert.equal(pool.releases.length, 1);
    assert.equal(pool.releases[0].code, 403);
    assert.notEqual(pool.releases[0].recoverable, true, 'a policy 403 must stay terminal');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a broken token refresh on a bound account migrates the conversation instead of failing', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end('{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}');
  });
  const accA = account({ id: 'acc-A', accessToken: '', accessTokenExpiresAt: 0 });
  const accB = account({ id: 'acc-B' });
  let binding: string | undefined = 'acc-A';
  const accounts = [accA, accB];
  const pool = {
    releases: [] as Release[],
    getAllAccounts: () => accounts,
    getAccount: (id: string) => accounts.find(a => a.id === id),
    getSessionBinding: () => (binding ? { accountId: binding, lastUsedAt: Date.now() } : undefined),
    clearSessionBinding: (_key: string, id?: string) => { if (!id || binding === id) binding = undefined; },
    acquireAccount: (excluded: Set<string>) => {
      const preferred = binding ? accounts.find(a => a.id === binding) : undefined;
      const chosen = preferred && !excluded.has(preferred.id) ? preferred : accounts.find(a => a.id !== binding && !excluded.has(a.id));
      if (!chosen) return null;
      chosen.activeConcurrency++;
      binding = chosen.id;
      return chosen;
    },
    releaseAccount: (id: string) => {
      const acc = accounts.find(a => a.id === id);
      if (acc) acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1);
    }
  };
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => false } as any, config(upstream.url));

  try {
    // Account A is bound to the session but its token can never be refreshed;
    // the request must end up on the idle account instead of dying with a
    // misleading "all accounts exhausted" error.
    const result = await executor.executeWithRetry(payload(), 3, 'sess-1');
    assert.equal(result.accountUsed.id, 'acc-B');
    assert.equal(calls, 1);
    assert.equal(binding, 'acc-B', 'the conversation must be rebound to the working account');
    assert.equal(accA.activeConcurrency, 0, 'the broken account must not keep its lease');
  } finally {
    await closeServer(upstream.server);
  }
});

test('an unreachable exit proxy retries in full and never leaks a lease', async () => {
  const upstream = await withUpstream((_req, res) => { res.end('never reached'); });
  // Port 1 refuses instantly, so every attempt fails before the body is handed
  // to any socket: this is the replay-safe class of failures.
  const acc = account({ proxyUrl: 'http://127.0.0.1:1' });
  const pool = makePool(acc);
  const executor = new RequestExecutor(pool as any, { refreshSingleAccount: async () => true } as any, config(upstream.url));

  try {
    const error: any = await executor.executeWithRetry(payload(), 3).catch(error => error);
    assert.ok(error, 'an unreachable proxy must surface an error');
    assert.doesNotMatch(String(error.message), /Automatic replay stopped/, 'a request that never left the machine may be replayed');
    assert.equal(pool.releases.length, 3, 'every attempt must release its own lease');
    assert.equal(acc.activeConcurrency, 0, 'no lease may leak');
  } finally {
    await closeServer(upstream.server);
  }
});

test('a rejected token is refreshed once, then the account is parked instead of looped', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":{"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials."}}');
  });
  const acc = account();
  const pool = makePool(acc);
  let refreshes = 0;
  const refresher = { refreshSingleAccount: async () => { refreshes++; return true; } };
  const executor = new RequestExecutor(pool as any, refresher as any, config(upstream.url));

  try {
    const error: any = await executor.executeWithRetry(payload(), 3).catch(error => error);
    assert.equal(refreshes, 1, 'exactly one refresh per request');
    assert.equal(calls, 2, 'one retry with the fresh token, then stop - never a loop');
    assert.equal(pool.releases.length, 2);
    assert.equal(pool.releases[1].code, 401);
    assert.equal(pool.releases[1].recoverable, true, 'a rejected fresh token parks the account, it does not kill it');
    assert.equal(acc.activeConcurrency, 0);
    // An upstream account problem must not look like an invalid client key.
    assert.equal(error.statusCode, 503);
  } finally {
    await closeServer(upstream.server);
  }
});

test('a retired pool is never mistaken for its replacement', async () => {
  const { getOrCreateDispatcher, resetDispatcher } = await import('../src/pool/dispatcher.js');
  const keepAlive = { timeoutMs: 1234 };
  const first = getOrCreateDispatcher('http://127.0.0.1:1', keepAlive);

  try {
    const other = getOrCreateDispatcher('http://127.0.0.1:2', keepAlive);
    // A late failure from another pool must not retire this one.
    resetDispatcher('http://127.0.0.1:1', keepAlive, other);
    assert.equal(getOrCreateDispatcher('http://127.0.0.1:1', keepAlive), first, 'the pool must survive a foreign reset');

    resetDispatcher('http://127.0.0.1:1', keepAlive, first);
    const replacement = getOrCreateDispatcher('http://127.0.0.1:1', keepAlive);
    assert.notEqual(replacement, first, 'retiring the right pool must install a fresh one');
  } finally {
    // Clean up whatever is still cached for those two keys.
    const live1 = getOrCreateDispatcher('http://127.0.0.1:1', keepAlive);
    if (live1) resetDispatcher('http://127.0.0.1:1', keepAlive, live1);
    const live2 = getOrCreateDispatcher('http://127.0.0.1:2', keepAlive);
    if (live2) resetDispatcher('http://127.0.0.1:2', keepAlive, live2);
  }
});

test('a repeated 401 during token counting parks the account instead of killing it', async () => {
  let calls = 0;
  const upstream = await withUpstream((_req, res) => {
    calls++;
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":{"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials."}}');
  });
  const acc = account();
  const pool = makePool(acc);
  let refreshes = 0;
  const refresher = { refreshSingleAccount: async () => { refreshes++; return true; } };
  const executor = new RequestExecutor(pool as any, refresher as any, config(upstream.url));

  try {
    const error: any = await executor.countTokens(payload(), 2, 'sess-1').catch(error => error);
    assert.equal(refreshes, 1, 'exactly one refresh per request');
    assert.equal(calls, 2);
    assert.equal(pool.releases.length, 2);
    assert.equal(pool.releases[1].code, 401);
    assert.equal(pool.releases[1].recoverable, true, 'a healthy account must be parked, not killed');
    assert.equal(acc.activeConcurrency, 0);
    // 503 is not an "upstream verdict", so the preflight lets generation proceed.
    assert.equal(error.statusCode, 503);
  } finally {
    await closeServer(upstream.server);
  }
});
