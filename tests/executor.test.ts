import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { RequestExecutor, UpstreamRequestError, getRetryAfterHeader } from '../src/pool/breaker.js';
import { config, fixture, generic429, payload } from './fixtures.js';

function response(statusCode: number, text = generic429, headers: Record<string, string> = {}) {
  const body = Object.assign(Readable.from([text]), { text: async () => text });
  return { statusCode, body, headers };
}

test('countTokens includes system instructions and tool schemas without changing generation input', async t => {
  const { pool } = fixture(t);
  const systemInstruction = { parts: [{ text: 'Follow the first rule.' }, { text: 'Follow the second rule.' }] };
  const tools = [{ functionDeclarations: [{
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }] }];
  const toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  const input: any = {
    ...payload,
    request: {
      ...payload.request,
      sessionId: 'session-only-for-generation',
      systemInstruction,
      tools,
      toolConfig
    }
  };
  const original = JSON.stringify(input);
  let countedPayload: any;
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async (_url, options) => {
      countedPayload = JSON.parse(options.body);
      return response(200, '{"totalTokens":123}');
    },
    wait: async () => {}, jitter: ms => ms
  });

  const result = await executor.countTokens(input, 1);

  assert.equal(result.totalTokens, 123);
  assert.deepEqual(countedPayload.request.contents[0], {
    role: 'user',
    parts: [
      { text: 'Follow the first rule.' },
      { text: 'Follow the second rule.' },
      { text: JSON.stringify({ tools, toolConfig }) }
    ]
  });
  assert.deepEqual(countedPayload.request.contents[1], payload.request.contents[0]);
  assert.equal('sessionId' in countedPayload.request, false);
  assert.equal('systemInstruction' in countedPayload.request, false);
  assert.equal('tools' in countedPayload.request, false);
  assert.equal('toolConfig' in countedPayload.request, false);
  assert.equal(JSON.stringify(input), original);
});

test('429 -> 429 -> success: same lease and body, one preflight, bounded exponential delays', async t => {
  const { pool, accounts } = fixture(t);
  const sent: any[] = [], waits: number[] = [];
  let counts = 0;
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async (url, options) => {
      if (url.includes('countTokens')) { counts++; return response(200, '{"totalTokens":12}'); }
      sent.push(options);
      assert.equal(accounts[0].activeConcurrency, 1);
      assert.equal(accounts[1].activeConcurrency, 0);
      return response(sent.length < 3 ? 429 : 200, sent.length < 3 ? generic429 : '你好');
    },
    wait: async ms => { waits.push(ms); assert.equal(accounts[0].activeConcurrency, 1); },
    jitter: ms => ms
  });
  const original = JSON.stringify(payload);
  const result = await executor.executeWithRetry(payload, 3, undefined, undefined, 'retry-test', true);
  assert.equal(counts, 1);
  assert.equal(sent.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(new Set(sent.map(call => call.headers.Authorization)).size, 1);
  assert.equal(new Set(sent.map(call => call.body)).size, 1);
  assert.equal(JSON.stringify(payload), original);
  assert.equal(result.inputTokenCount, 12);
  accounts[0].rateLimitStreak = 2;
  assert.equal(accounts[0].activeConcurrency, 1);
  assert.equal(await result.bodyStream.text(), '你好');
  result.release!(); result.release!();
  assert.equal(accounts[0].activeConcurrency, 0);
  assert.equal(accounts[0].rateLimitStreak, 0);
  assert.equal(accounts[1].totalRequests, 0);
});

test('permanent generic 429 preserves HTTP status/body and never sweeps the pool', async t => {
  const { pool, accounts } = fixture(t);
  accounts[0].quota = { gemini5hFraction: 0.8, geminiWeeklyFraction: 0.9 };
  accounts[0].rateLimitStreak = 2;
  accounts[0].lastRateLimitAt = Date.now();
  let calls = 0;
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async () => { calls++; return response(429); }, wait: async () => {}, jitter: ms => ms
  });
  await assert.rejects(executor.executeWithRetry(payload), (e: any) => {
    assert.ok(e instanceof UpstreamRequestError);
    assert.equal(e.statusCode, 429);
    assert.equal(e.upstreamBody, generic429);
    assert.equal(getRetryAfterHeader(e), '12');
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(accounts[0].activeConcurrency, 0);
  assert.equal(accounts[0].failedRequests, 1);
  assert.equal(accounts[0].rateLimitStreak, 3);
  assert.ok(accounts[0].cooldownUntil - Date.now() <= 12_000);
  assert.deepEqual(accounts[0].quota, { gemini5hFraction: 0.8, geminiWeeklyFraction: 0.9 });
  assert.equal(accounts[1].totalRequests, 0);
});

for (const hint of [4, 30]) {
  test(`Retry-After ${hint}s is honored or returned without an early retry`, async t => {
    const { pool } = fixture(t);
    let calls = 0;
    const waits: number[] = [];
    const executor = new RequestExecutor(pool, {} as any, config, undefined, {
      request: async () => { calls++; return response(429, generic429, { 'retry-after': String(hint) }); },
      wait: async ms => { waits.push(ms); }, jitter: ms => ms
    });
    await assert.rejects(executor.executeWithRetry(payload), (e: any) => e.statusCode === 429 && getRetryAfterHeader(e) === String(hint));
    assert.equal(calls, hint > 15 ? 1 : 3);
    assert.deepEqual(waits, hint > 15 ? [] : [4000, 4000]);
  });
}

test('explicit quota 429 stops immediately without account rotation', async t => {
  const { pool, accounts } = fixture(t);
  accounts[0].quota = { gemini5hFraction: 0.8 };
  const quotaError = JSON.stringify({ error: { message: 'Individual quota reached', details: [{ reason: 'QUOTA_EXHAUSTED' }] } });
  let calls = 0;
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async () => { calls++; return response(429, quotaError); },
    wait: async () => assert.fail('quota must not retry'), jitter: ms => ms
  });
  await assert.rejects(executor.executeWithRetry(payload), (e: any) => e.statusCode === 429);
  assert.equal(calls, 1);
  assert.equal(accounts[1].totalRequests, 0);
  assert.ok(accounts[0].quotaBlockedUntil!.gemini! > Date.now());
  assert.equal(accounts[0].quota.gemini5hFraction, 0.8);
});

test('abort during backoff releases the lease once, without starting another generation', async t => {
  const { pool, accounts } = fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async () => { calls++; return response(429); },
    wait: async () => { controller.abort(); throw new Error('cancelled'); }, jitter: ms => ms
  });
  await assert.rejects(executor.executeWithRetry(payload, 3, undefined, controller.signal), /cancelled/);
  assert.equal(calls, 1);
  assert.equal(accounts[0].activeConcurrency, 0);
  assert.equal(accounts[0].failedRequests, 1);
});

test('network failure after headers were sent is never replayed', async t => {
  const { pool, accounts } = fixture(t);
  let calls = 0;
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async (_url, options) => {
      calls++; options.transportAttempt.markSent();
      throw Object.assign(new Error('socket lost'), { code: 'ECONNRESET' });
    }, wait: async () => assert.fail('ambiguous POST cannot replay'), jitter: ms => ms
  });
  await assert.rejects(executor.executeWithRetry(payload), (e: any) => e.statusCode === 502 && /result unknown/.test(e.message));
  assert.equal(calls, 1);
  assert.equal(accounts[0].activeConcurrency, 0);
});

test('401 refresh retries the same lease and uses the new token', async t => {
  const { pool, accounts } = fixture(t);
  const tokens: string[] = [];
  let refreshes = 0;
  const executor = new RequestExecutor(pool, { refreshSingleAccount: async (account: any) => {
    refreshes++; account.accessToken = 'refreshed-test-token'; return true;
  } } as any, config, undefined, {
    request: async (_url, options) => { tokens.push(options.headers.Authorization); return response(tokens.length === 1 ? 401 : 200); },
    wait: async () => {}, jitter: ms => ms
  });
  const result = await executor.executeWithRetry(payload);
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens, ['Bearer secret-access-first', 'Bearer refreshed-test-token']);
  result.release!();
  assert.equal(accounts[1].totalRequests, 0);
});

test('validation-required 403 blocks future scheduling even when no URL is supplied', async t => {
  const { pool, accounts } = fixture(t);
  const executor = new RequestExecutor(pool, {} as any, config, undefined, {
    request: async () => response(403, '{"error":{"message":"Verify your account to continue.","details":[{"reason":"VALIDATION_REQUIRED"}]}}'),
    wait: async () => assert.fail('403 cannot retry'), jitter: ms => ms
  });
  await assert.rejects(executor.executeWithRetry(payload), (e: any) => e.statusCode === 403);
  assert.equal(accounts[0].validationRequired, true);
  const next = pool.acquireAccount(new Set([accounts[1].id]), 'gemini');
  assert.equal(next, null);
});

test('auxiliary success does not reset generation error streaks', t => {
  const { pool, accounts } = fixture(t);
  accounts[0].rateLimitStreak = 3;
  const account = pool.acquireAccount(new Set([accounts[1].id]), 'gemini')!;
  pool.trackLease(account, 'gemini').release();
  assert.equal(account.rateLimitStreak, 3);
});

test('late 401/403/429 responses cannot reactivate a terminal account or erase its reason', t => {
  const { pool, accounts } = fixture(t);
  for (const status of ['dead', 'disabled'] as const) {
    for (const code of [401, 403, 429]) {
      const account = accounts[0];
      account.status = status;
      account.lastError = '[POLICY_BLOCKED] original reason';
      account.activeConcurrency = 1;
      pool.releaseAccount(account.id, { code, message: 'late response', recoverable: true });
      assert.equal(account.status, status);
      assert.equal(account.activeConcurrency, 0);
      assert.equal(account.lastError, '[POLICY_BLOCKED] original reason');
    }
  }
});
