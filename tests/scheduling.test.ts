import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { test, before, after } from 'node:test';
import { extractSessionIdentity, extractSessionKey, attachUpstreamSessionId } from '../src/gateway/session.js';
import { RequestExecutor } from '../src/pool/breaker.js';
import { AccountSchedulingError, hasFamilyQuota } from '../src/pool/scheduling.js';
import { createServer } from '../src/gateway/server.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-scheduling-'));
const originalDirectory = process.cwd();
let AccountPool: any;
let pools: any[] = [];
before(async () => {
  process.chdir(directory);
  ({ AccountPool } = await import('../src/pool/account-pool.js'));
});
after(() => {
  for (const pool of pools) pool.dispose();
  process.chdir(originalDirectory);
  fs.rmSync(directory, { force: true, recursive: true });
});

function fresh(capacities = [1]) {
  for (const pool of pools) pool.dispose();
  pools = [];
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/accounts.json', '[]');
  const pool = new AccountPool('zero-waste', path.join(directory, 'data'));
  pools.push(pool);
  const accounts = capacities.map((maxConcurrency, index) => pool.addAccount({
    email: 'fake-' + index + '@example.test', refreshToken: 'fake', accessToken: 'fake', expiresInSeconds: 3600, maxConcurrency
  }));
  return { pool, accounts };
}
const lease = (pool: any, key: string, family = 'gemini') => pool.acquireAccount(new Set(), family, key);
const queue = (pool: any, key: string, options: any = {}, family = 'gemini') =>
  pool.acquireAccountAsync(new Set(), family, key, { timeoutMs: 1500, ...options });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const id = (session: string, agent = 'main') => ({ metadata: { user_id: JSON.stringify({ session_id: session, agent_id: agent }) } });
const quota = () => ({ gemini5hFraction: 1, geminiWeeklyFraction: 1, claude5hFraction: 1, claudeWeeklyFraction: 1 });

test('session identity preserves child and parent while routing to the same account root', () => {
  const parent = extractSessionIdentity({}, id('A'), 'anthropic')!;
  const child = extractSessionIdentity({}, id('A', 'worker'), 'anthropic')!;
  assert.notEqual(child.sessionKey, parent.sessionKey);
  assert.equal(child.parentKey, parent.sessionKey);
  assert.equal(child.rootKey, parent.rootKey);
  assert.equal(extractSessionKey({ 'X-Claude-Code-Session-Id': 'A', 'X-Claude-Code-Agent-Id': 'worker' }, {}, 'anthropic'), parent.rootKey);
  const nested = extractSessionIdentity({}, { metadata: { user_id: JSON.stringify({ session_id: 'A', agent_id: 'nested', parent_agent_id: 'worker' }) } }, 'anthropic')!;
  assert.equal(nested.parentKey, child.sessionKey);
  assert.equal(nested.rootKey, parent.rootKey);
  const separate = extractSessionIdentity({}, { session_id: 'child-session', parent_session_id: 'A' }, 'anthropic')!;
  assert.equal(separate.rootKey, parent.rootKey);
  assert.notEqual(separate.sessionKey, parent.sessionKey);
});

test('legacy metadata normalizes with headers and fallback hashes beyond 4000 characters', () => {
  const uuid = '785b5fae-0348-4eb7-beb2-077e5e3b4377';
  const legacy = extractSessionKey({}, { metadata: { user_id: 'user_device_session_' + uuid } }, 'anthropic');
  assert.equal(legacy, extractSessionKey({ 'x-claude-code-session-id': uuid }, {}, 'anthropic'));
  const fallback = (tail: string, system = 'system') => extractSessionKey({}, {
    system, messages: [{ role: 'user', content: 'x'.repeat(4000) + tail }]
  }, 'anthropic');
  assert.notEqual(fallback('a'), fallback('b'));
  assert.equal(fallback('a'), fallback('a', 'changed'));
  assert.equal(extractSessionKey({}, { prompt_cache_key: 'key' }, 'responses'), 'pck:key');
  assert.equal(extractSessionKey({ 'x-session-id': 'explicit' }, { prompt_cache_key: 'key' }, 'responses'), 'explicit');
  assert.equal(extractSessionKey({}, { session_id: 'same', prompt_cache_key: 'same' }, 'responses'), 'same');
  const upstream: any = { request: {} };
  attachUpstreamSessionId(upstream, 'claude:A' + String.fromCharCode(0) + 'account', true);
  const previous = upstream.request.sessionId;
  const digest = crypto.createHash('sha256').update('antigravity-session' + String.fromCharCode(0)
    + 'claude:A' + String.fromCharCode(0) + 'account').digest('hex');
  assert.equal(previous, '-' + (BigInt('0x' + digest.slice(0, 15)) & BigInt('0x7fffffffffffffff')).toString());
  attachUpstreamSessionId(upstream, 'claude:A' + String.fromCharCode(0) + 'account', true);
  assert.equal(upstream.request.sessionId, previous);
});

test('new conversations prefer actual utilization over binding counts', () => {
  const { pool, accounts: [idle, busy] } = fresh([5, 5]);
  for (const root of ['A', 'B', 'C']) { const account = lease(pool, root); pool.releaseAccount(account.id); }
  for (let i = 0; i < 4; i++) lease(pool, 'B');
  assert.equal(idle.activeConcurrency, 0);
  assert.equal(busy.activeConcurrency, 4);
  assert.equal(lease(pool, 'D').id, idle.id);
});

test('heterogeneous capacities compare fractions and keep existing account affinity', () => {
  const { pool, accounts: [small, large] } = fresh([2, 10]);
  for (const root of ['A', 'B']) { const account = lease(pool, root); pool.releaseAccount(account.id); }
  lease(pool, 'A');
  for (let i = 0; i < 3; i++) lease(pool, 'B');
  assert.equal(lease(pool, 'C').id, large.id);
  assert.equal(lease(pool, 'A').id, small.id);
});

test('fair queue alternates roots, preserves root FIFO, and disallows immediate slot stealing', async () => {
  const { pool, accounts: [account] } = fresh();
  for (const root of ['A', 'B']) { const held = lease(pool, root); pool.releaseAccount(held.id); }
  lease(pool, 'A');
  const order: string[] = [];
  const tasks = ['A1', 'A2', 'A3', 'B1', 'B2'].map(label => queue(pool, label[0]).then((result: any) => {
    assert.equal(result.id, account.id); order.push(label); return result;
  }));
  pool.releaseAccount(account.id);
  assert.equal(lease(pool, 'A'), null);
  await tick();
  for (let i = 0; i < 4; i++) { pool.releaseAccount(account.id); await tick(); }
  await Promise.all(tasks);
  assert.deepEqual(order, ['A1', 'B1', 'A2', 'B2', 'A3']);
  pool.releaseAccount(account.id);
  assert.equal(account.activeConcurrency, 0);
});

test('a busy bound root cannot block a different account, including preflight callers', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  lease(pool, 'A');
  const controller = new AbortController();
  const waiting = queue(pool, 'A', { signal: controller.signal });
  const rejected = assert.rejects(waiting, /aborted/i);
  assert.equal(lease(pool, 'B').id, b.id);
  controller.abort(); await rejected;
  assert.equal(a.activeConcurrency, 1);
  pool.releaseAccount(a.id); pool.releaseAccount(b.id);
});

test('new roots queue when all accounts are full and bind consistently after release', async () => {
  const { pool, accounts: [account] } = fresh();
  lease(pool, 'A');
  const first = queue(pool, 'NEW');
  const sibling = queue(pool, 'NEW');
  pool.releaseAccount(account.id);
  const acquired = await first;
  assert.equal(acquired.id, account.id);
  assert.equal(pool.getSessionBinding('NEW').accountId, account.id);
  pool.releaseAccount(account.id);
  assert.equal((await sibling).id, account.id);
  pool.releaseAccount(account.id);
});

test('queue bounds, cancellation and deadline leave active leases untouched', async () => {
  const { pool, accounts: [account] } = fresh();
  lease(pool, 'A');
  const controller = new AbortController();
  const waiting = queue(pool, 'A', { signal: controller.signal, maxConversationQueue: 1 });
  const cancelled = assert.rejects(waiting, /aborted/i);
  await assert.rejects(queue(pool, 'A', { maxConversationQueue: 1 }), (error: any) => error.code === 'queue_full');
  controller.abort(); await cancelled;
  await assert.rejects(queue(pool, 'A', { timeoutMs: 25 }), (error: any) => error.code === 'queue_timeout');
  assert.equal(account.activeConcurrency, 1);
  assert.equal(pool.waiters.length, 0);
  pool.releaseAccount(account.id);
  assert.equal(account.activeConcurrency, 0);
});

test('queued requests migrate only when their account becomes unavailable', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  lease(pool, 'A');
  const waiting = queue(pool, 'A');
  a.status = 'dead';
  pool.releaseAccount(a.id);
  assert.equal((await waiting).id, b.id);
  pool.releaseAccount(b.id);
  const held = lease(pool, 'A');
  held.quota = quota();
  const exhausted = queue(pool, 'A');
  held.quota.gemini5hFraction = 0;
  held.quota.geminiResetTime = new Date(Date.now() + 60_000).toISOString();
  pool.releaseAccount(held.id);
  await assert.rejects(exhausted, (error: any) => error.code === 'quota_exhausted');
});

test('full accounts with exhausted requested family may migrate to a usable family account', () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  lease(pool, 'A');
  a.quota = quota();
  a.quota.claude5hFraction = 0;
  a.quota.claudeResetTime = new Date(Date.now() + 60_000).toISOString();
  assert.equal(lease(pool, 'A', 'claude').id, b.id);
});

test('an unavailable Claude request cannot erase three running Gemini agents or their queued sibling', async () => {
  const { pool, accounts: [a, b] } = fresh([3, 3]);
  for (const account of [a, b]) account.quota = {
    ...quota(), claude5hFraction: 0, claudeResetTime: new Date(Date.now() + 60_000).toISOString()
  };
  const running = Array.from({ length: 3 }, () => {
    const account = lease(pool, 'ROOT');
    assert.equal(account.id, a.id);
    const owned = pool.trackLease(account, 'gemini', 'ROOT'); owned.markGeneration(); return owned;
  });
  const original = pool.getSessionBinding('ROOT', 'gemini');
  const waiting = queue(pool, 'ROOT');
  await assert.rejects(queue(pool, 'ROOT', {}, 'claude'), (error: any) => error.code === 'quota_exhausted');
  assert.equal(pool.getSessionBinding('ROOT', 'gemini'), original);
  assert.equal(pool.getSessionBinding('ROOT', 'claude'), undefined);
  assert.ok(running.every(owned => owned.isCurrent()));
  running[0].release();
  const next = await waiting;
  assert.equal(next.id, a.id);
  assert.equal(b.activeConcurrency, 0);
  pool.releaseAccount(next.id);
  running.slice(1).forEach(owned => owned.release());
  assert.equal(pool.sessionLeases.size, 0);
});

test('both model families prefer the same usable account and retain independent leases', () => {
  const { pool, accounts: [a, b] } = fresh([4, 4]);
  const geminiAccount = lease(pool, 'ROOT');
  const gemini = pool.trackLease(geminiAccount, 'gemini', 'ROOT'); gemini.markGeneration();
  const claudeAccount = lease(pool, 'ROOT', 'claude');
  const claude = pool.trackLease(claudeAccount, 'claude', 'ROOT'); claude.markGeneration();
  assert.equal(geminiAccount.id, a.id);
  assert.equal(claudeAccount.id, a.id);
  assert.notEqual(pool.getSessionBinding('ROOT', 'gemini').version, pool.getSessionBinding('ROOT', 'claude').version);
  assert.equal(gemini.isCurrent(), true);
  assert.equal(claude.isCurrent(), true);
  claude.release();
  assert.equal(gemini.isCurrent(), true);
  assert.equal(a.activeConcurrency, 1);
  assert.equal(b.activeConcurrency, 0);
  gemini.release();
  assert.equal(pool.sessionLeases.size, 0);
});

test('a Claude quota failover and its late rejection leave Gemini on the original account', () => {
  const { pool, accounts: [a, b] } = fresh([5, 5]);
  const geminiAccount = lease(pool, 'ROOT');
  const gemini = pool.trackLease(geminiAccount, 'gemini', 'ROOT'); gemini.markGeneration();
  const geminiVersion = pool.getSessionBinding('ROOT', 'gemini').version;
  const old = Array.from({ length: 2 }, () => {
    const account = lease(pool, 'ROOT', 'claude');
    assert.equal(account.id, a.id);
    const owned = pool.trackLease(account, 'claude', 'ROOT'); owned.markGeneration(); return owned;
  });
  old[0].release({ code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 });
  const replacementAccount = lease(pool, 'ROOT', 'claude');
  assert.equal(replacementAccount.id, b.id);
  const replacement = pool.trackLease(replacementAccount, 'claude', 'ROOT'); replacement.markGeneration();
  old[1].release({ code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 });
  assert.equal(pool.getSessionBinding('ROOT', 'gemini').version, geminiVersion);
  assert.equal(gemini.isCurrent(), true);
  assert.equal(replacement.isCurrent(), true);
  assert.equal(lease(pool, 'ROOT').id, a.id);
  pool.releaseAccount(a.id); gemini.release(); replacement.release();
  assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
  assert.equal(pool.sessionLeases.size, 0);
});

test('one family preflight releases only its own cold binding', () => {
  const { pool, accounts: [a] } = fresh([5, 5]);
  const account = lease(pool, 'ROOT');
  const gemini = pool.trackLease(account, 'gemini', 'ROOT'); gemini.markGeneration();
  const counted = lease(pool, 'ROOT', 'claude');
  pool.trackLease(counted, 'claude', 'ROOT').release();
  assert.equal(pool.getSessionBinding('ROOT', 'claude'), undefined);
  assert.equal(pool.getSessionBinding('ROOT', 'gemini').accountId, a.id);
  assert.equal(gemini.isCurrent(), true);
  gemini.release();
  assert.equal(pool.sessionLeases.size, 0);
});

test('small positive balances preserve affinity and queued work through quota updates and reloads', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  const account = lease(pool, 'ROOT');
  const running = pool.trackLease(account, 'gemini', 'ROOT'); running.markGeneration();
  const originalVersion = pool.getSessionBinding('ROOT', 'gemini').version;
  const waiting = queue(pool, 'ROOT');
  pool.updateAccount(a.id, { quota: { ...quota(), gemini5hFraction: 0.0046, geminiWeeklyFraction: 0.004,
    geminiResetTime: new Date(Date.now() + 60_000).toISOString(),
    geminiWeeklyResetTime: new Date(Date.now() + 3600_000).toISOString() } });
  pool.loadAccounts();
  running.release();
  const next = await waiting;
  assert.equal(next.id, a.id);
  assert.equal(pool.getSessionBinding('ROOT', 'gemini').version, originalVersion);
  assert.equal(b.activeConcurrency, 0);
  pool.releaseAccount(next.id);
});

test('separate family bindings still share one account concurrency limit', async () => {
  const { pool, accounts: [a] } = fresh([2, 2]);
  const first = lease(pool, 'ROOT');
  const gemini = pool.trackLease(first, 'gemini', 'ROOT'); gemini.markGeneration();
  const second = lease(pool, 'ROOT', 'claude');
  const claude = pool.trackLease(second, 'claude', 'ROOT'); claude.markGeneration();
  assert.equal(second.id, a.id);
  const g = queue(pool, 'ROOT');
  const c = queue(pool, 'ROOT', {}, 'claude');
  gemini.release();
  const gAccount = await g;
  assert.equal(gAccount.id, a.id);
  assert.equal(a.activeConcurrency, 2);
  pool.releaseAccount(gAccount.id);
  assert.equal((await c).id, a.id);
  assert.equal(a.activeConcurrency, 2);
  pool.releaseAccount(a.id); claude.release();
  assert.equal(a.activeConcurrency, 0);
});

test('the first request of another family waits for the usable conversation home when it is full', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  const account = lease(pool, 'ROOT');
  const gemini = pool.trackLease(account, 'gemini', 'ROOT'); gemini.markGeneration();
  const waiting = queue(pool, 'ROOT', {}, 'claude');
  assert.equal(pool.getSessionBinding('ROOT', 'claude'), undefined);
  assert.equal(b.activeConcurrency, 0);
  gemini.release();
  const next = await waiting;
  assert.equal(next.id, a.id);
  assert.equal(pool.getSessionBinding('ROOT', 'claude').accountId, a.id);
  pool.trackLease(next, 'claude', 'ROOT').release();
  assert.equal(pool.sessionLeases.size, 0);
});

test('pool shutdown rejects pending work without dropping another lease', async () => {
  const { pool, accounts: [account] } = fresh();
  lease(pool, 'A');
  const waiting = queue(pool, 'A');
  pool.dispose();
  await assert.rejects(waiting, (error: any) => error.code === 'unavailable');
  assert.equal(account.activeConcurrency, 1);
  await assert.rejects(queue(pool, 'NEW'), (error: any) => error.code === 'unavailable');
});

test('idle cleanup retains bindings with active or waiting requests', async () => {
  const { pool, accounts: [account] } = fresh();
  lease(pool, 'A');
  pool.getSessionBinding('A', 'gemini').lastUsedAt = Date.now() - 61 * 60_000;
  pool.sessionCleanTimer._onTimeout();
  assert.equal(pool.getSessionBinding('A').accountId, account.id);
  pool.releaseAccount(account.id);
  pool.sessionCleanTimer._onTimeout();
  assert.equal(pool.getSessionBinding('A'), undefined);
});

test('an account disabled during pacing is never sent a new generation', async () => {
  const { pool, accounts: [account] } = fresh();
  let requests = 0;
  const upstream = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as any;
  const executor = new RequestExecutor(pool, {} as any, {
    upstreamUrl: 'http://127.0.0.1:' + address.port + '/v1internal:streamGenerateContent', minRequestIntervalMs: 80
  } as any);
  await (executor as any).paceAccount(account);
  try {
    const pending = executor.executeWithRetry({ model: 'gemini-test', request: { contents: [] } }, 1, 'A');
    setTimeout(() => { account.status = 'disabled'; }, 10);
    await assert.rejects(pending, (error: any) => error.code === 'unavailable');
    assert.equal(requests, 0);
    assert.equal(pool.getAccount(account.id).activeConcurrency, 0);
  } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('account and global queue limits reject excess work and cancellation frees admission', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  lease(pool, 'A'); lease(pool, 'B');
  const ca = new AbortController();
  const cb = new AbortController();
  const pa = queue(pool, 'A', { signal: ca.signal });
  const pb = queue(pool, 'B', { signal: cb.signal });
  const ra = assert.rejects(pa, /aborted/i);
  const rb = assert.rejects(pb, /aborted/i);
  await assert.rejects(queue(pool, 'A', { maxAccountQueue: 1 }), (error: any) => error.code === 'queue_full');
  await assert.rejects(queue(pool, 'NEW', { maxTotalQueue: 2 }), (error: any) => error.code === 'queue_full');
  ca.abort(); cb.abort(); await Promise.all([ra, rb]);
  const replacement = queue(pool, 'NEW', { maxTotalQueue: 1 });
  pool.releaseAccount(a.id);
  assert.equal((await replacement).id, a.id);
  pool.releaseAccount(a.id); pool.releaseAccount(b.id);
});

test('a full Gemini binding does not block an independently usable Claude account', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  lease(pool, 'G'); lease(pool, 'C');
  a.quota = quota(); a.quota.claude5hFraction = 0;
  a.quota.claudeResetTime = new Date(Date.now() + 60_000).toISOString();
  b.quota = quota(); b.quota.gemini5hFraction = 0;
  b.quota.geminiResetTime = new Date(Date.now() + 60_000).toISOString();
  const cancel = new AbortController();
  const gemini = queue(pool, 'G', { signal: cancel.signal });
  const cancelled = assert.rejects(gemini, /aborted/i);
  const claude = queue(pool, 'C', {}, 'claude');
  pool.releaseAccount(b.id);
  assert.equal((await claude).id, b.id);
  assert.equal(a.activeConcurrency, 1);
  cancel.abort(); await cancelled;
  pool.releaseAccount(a.id); pool.releaseAccount(b.id);
});

test('six accounts complete 240 mixed queued requests without exceeding capacity or changing healthy bindings', async () => {
  const { pool, accounts } = fresh([2, 4, 6, 2, 4, 6]);
  const owners = new Map<string, string>();
  for (let i = 0; i < 8; i++) {
    const root = 'root-' + i;
    const account = lease(pool, root); owners.set(root, account.id); pool.releaseAccount(account.id);
  }
  const peaks = new Map<string, number>();
  let done = 0;
  const work = Array.from({ length: 240 }, (_, i) => (async () => {
    const root = 'root-' + i % 8;
    const account = await queue(pool, root, { timeoutMs: 5000, maxAccountQueue: 300, maxTotalQueue: 400, maxConversationQueue: 64 });
    assert.equal(account.id, owners.get(root));
    peaks.set(account.id, Math.max(peaks.get(account.id) ?? 0, account.activeConcurrency));
    assert.ok(account.activeConcurrency <= account.maxConcurrency);
    await new Promise(resolve => setTimeout(resolve, 1 + i % 5));
    done++; pool.releaseAccount(account.id);
  })());
  await Promise.all(work);
  assert.equal(done, 240);
  assert.equal(pool.waiters.length, 0);
  assert.ok(pool.getAllAccounts().every((account: any) => account.activeConcurrency === 0));
  assert.ok(accounts.every((account: any) => (peaks.get(account.id) ?? 0) <= account.maxConcurrency));
});

test('all API protocols retain scheduling reason before and after streaming headers', async () => {
  const { pool } = fresh();
  const fake = {
    fetchAvailableModels: async () => ({ models: { 'gemini-test': { maxOutputTokens: 1024 } } }),
    countTokens: async () => ({ totalTokens: 1 }),
    executeWithRetry: async () => {
      if (slow) await new Promise(resolve => setTimeout(resolve, 1100));
      throw new AccountSchedulingError('queue_timeout', 'Local queue expired');
    }
  };
  let slow = false;
  const app = await createServer({ apiMasterKey: 'test-key', streamKeepaliveMs: 1000 } as any, pool,
    { refreshSingleAccount: async () => true } as any, fake as any);
  try {
    for (const stream of [false, true]) {
      slow = stream;
      for (const [url, payload] of [
        ['/v1/messages', { model: 'gemini-test', messages: [{ role: 'user', content: 'test' }], max_tokens: 16, stream }],
        ['/v1/chat/completions', { model: 'gemini-test', messages: [{ role: 'user', content: 'test' }], stream }],
        ['/v1/responses', { model: 'gemini-test', input: 'test', stream }]
      ] as const) {
        const response = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer test-key' }, payload });
        assert.equal(response.statusCode, stream ? 200 : 503, response.body);
        assert.ok(response.body.includes('queue_timeout'), response.body);
        if (stream) assert.ok(response.body.includes(': keepalive'), response.body);
      }
    }
  } finally { await app.close(); }
});

test('local executor traffic enforces concurrency pacing, cancels waiters and skips busy preflight', async () => {
  const { pool, accounts: [account] } = fresh([5]);
  const starts: number[] = [];
  const sessions: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    starts.push(Date.now()); sessions.push(body.request.sessionId);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const executor = new RequestExecutor(pool, { refreshSingleAccount: async () => true } as any, {
    upstreamUrl: 'http://127.0.0.1:' + address.port + '/v1internal:streamGenerateContent',
    minRequestIntervalMs: 70, accountQueueTimeoutMs: 500
  } as any);
  const payload = () => ({ model: 'gemini-test', request: { contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] } });
  try {
    const consume = async (signal?: AbortSignal) => {
      const result = await executor.executeWithRetry(payload(), 1, 'A', signal);
      try { await result.bodyStream.text(); } finally { result.release!(); }
    };
    await consume();
    const controller = new AbortController();
    const tasks = [consume(), consume(controller.signal), consume(), consume(), consume()];
    const cancelled = assert.rejects(tasks[1], /abort/i);
    setTimeout(() => controller.abort(), 20);
    await Promise.all([tasks[0], tasks[2], tasks[3], tasks[4], cancelled]);
    assert.equal(starts.length, 5);
    await consume(); // A new request after cancellation must still reach upstream.
    const gaps = starts.slice(1).map((time, index) => time - starts[index]);
    assert.equal(starts.length, 6);
    assert.ok(gaps.every(gap => gap >= 55), 'generation start gaps: ' + gaps.join(','));
    assert.equal(new Set(sessions).size, 1);
    assert.equal(account.activeConcurrency, 0);
    assert.equal(pool.sessionLeases.size, 0);
    assert.equal((executor as any).pacingTails.size, 0);
    for (let i = 0; i < 5; i++) lease(pool, 'A');
    const before = Date.now();
    await assert.rejects(executor.countTokens(payload(), 1, 'A'), /No available/);
    assert.ok(Date.now() - before < 150);
    assert.equal(account.activeConcurrency, 5);
    const timeout = executor.executeWithRetry(payload(), 1, 'NEW');
    await assert.rejects(timeout, (error: any) => error instanceof AccountSchedulingError && error.code === 'queue_timeout');
    assert.equal(starts.length, 6);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// Real executor + real pool + local HTTP upstream. No Google quota or credentials are used.
const generationPayload = () => ({ model: 'gemini-test', request: { contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] } });
const generationEvent = () => 'data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 1 } } }) + '\n\n';
const quotaResponse = () => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'Individual quota reached. Resets in 2h42m55s.', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXHAUSTED',
      metadata: { model: 'gemini-3.8-flash-tiered', quotaResetDelay: '2h42m55.780266816s' } },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9775.780266816s' }
  ] } });
async function localExecutor(pool: any, handler: http.RequestListener, overrides: any = {}) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config: any = { upstreamUrl: 'http://127.0.0.1:' + (server.address() as any).port + '/v1internal:streamGenerateContent',
    minRequestIntervalMs: 0, cooldownSeconds: 60, accountQueueTimeoutMs: 1000, apiMasterKey: '', streamKeepaliveMs: 1000, ...overrides };
  return { executor: new RequestExecutor(pool, { refreshSingleAccount: async () => true } as any, config), config,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function consumeGeneration(executor: RequestExecutor, root: string, preflight = true) {
  const result = await executor.executeWithRetry(generationPayload(), 1, root, undefined, root, preflight);
  try { await result.bodyStream.text(); } finally { result.release!(); }
  return result;
}

test('real mixed-model execution cannot move three running Gemini requests when Claude has no quota', async () => {
  const { pool, accounts: [a, b] } = fresh([5, 5]);
  a.accessToken = 'A'; b.accessToken = 'B';
  for (const account of [a, b]) account.quota = { ...quota(), claude5hFraction: 0,
    claudeResetTime: new Date(Date.now() + 60_000).toISOString() };
  const calls: Array<{ account: string; session: string }> = [];
  const local = await localExecutor(pool, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url!.includes('countTokens')) { res.end('{"totalTokens":42}'); return; }
    calls.push({ account: String(req.headers.authorization), session: body.request.sessionId });
    res.end(generationEvent());
  });
  const running: any[] = [];
  try {
    for (let i = 0; i < 3; i++) running.push(await local.executor.executeWithRetry(generationPayload(), 1, 'ROOT', undefined, 'child-' + i, true));
    assert.equal(a.activeConcurrency, 3);
    const originalVersion = pool.getSessionBinding('ROOT', 'gemini').version;
    const claudePayload = { ...generationPayload(), model: 'claude-test' };
    await assert.rejects(local.executor.executeWithRetry(claudePayload, 1, 'ROOT', undefined, 'main', true),
      (error: any) => error.code === 'quota_exhausted');
    await assert.rejects(local.executor.countTokens(claudePayload, 1, 'ROOT'), /No available/);
    await consumeGeneration(local.executor, 'ROOT');
    assert.equal(pool.getSessionBinding('ROOT', 'gemini').version, originalVersion);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.account === 'Bearer A'));
    assert.equal(new Set(calls.map(call => call.session)).size, 1, 'the cache session identity must remain stable');
    assert.equal(b.activeConcurrency, 0);
  } finally {
    for (const result of running) { await result.bodyStream.text(); result.release(); }
    await local.close();
  }
  assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
  assert.equal(pool.sessionLeases.size, 0);
});

test('a low positive poll during preflight does not migrate before generation starts', async () => {
  const { pool, accounts: [a, b] } = fresh([2, 2]);
  a.accessToken = 'A'; b.accessToken = 'B';
  const generated: string[] = [];
  const local = await localExecutor(pool, async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    if (req.url!.includes('countTokens')) {
      pool.updateAccount(a.id, { quota: { ...quota(), gemini5hFraction: 0.005,
        geminiResetTime: new Date(Date.now() + 60_000).toISOString() } });
      res.end('{"totalTokens":42}');
    } else { generated.push(String(req.headers.authorization)); res.end(generationEvent()); }
  });
  try {
    await consumeGeneration(local.executor, 'ROOT');
    assert.deepEqual(generated, ['Bearer A']);
    assert.equal(pool.getSessionBinding('ROOT', 'gemini').accountId, a.id);
    assert.equal(pool.sessionLeases.size, 0);
  } finally { await local.close(); }
});

test('quota rejection visits six accounts even with a one-attempt network budget and keeps the replacement affinity', async () => {
  const { pool, accounts } = fresh([1, 1, 1, 1, 1, 1]);
  accounts.forEach((account: any, index: number) => { account.accessToken = 'fake-' + index; account.quota = quota(); });
  const rejected = new Set(accounts.slice(0, 5).map((account: any) => 'Bearer ' + account.accessToken));
  const calls: string[] = [];
  const local = await localExecutor(pool, async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    calls.push(String(req.headers.authorization));
    if (rejected.has(req.headers.authorization)) { res.statusCode = 429; res.end(quotaResponse()); }
    else res.end(generationEvent());
  });
  try {
    const result = await consumeGeneration(local.executor, 'ROOT', false);
    assert.equal(result.accountUsed.id, accounts[5].id);
    assert.equal(calls.length, 6);
    assert.equal(new Set(calls).size, 6);
    assert.equal(pool.getSessionBinding('ROOT').accountId, accounts[5].id);
    assert.ok(accounts.slice(0, 5).every((account: any) => !hasFamilyQuota(account, 'gemini') && hasFamilyQuota(account, 'claude')));
    assert.ok(accounts[0].quotaBlockedUntil.gemini > Date.now() + 9700_000);
    accounts[0].quota = quota();
    assert.equal(hasFamilyQuota(accounts[0], 'gemini'), false, 'stale quota poll must not undo an upstream rejection');
    await consumeGeneration(local.executor, 'ROOT', false);
    assert.equal(calls[6], 'Bearer fake-5');
    assert.ok(accounts.every((account: any) => account.activeConcurrency === 0));
    assert.equal(pool.sessionLeases.size, 0);
  } finally { await local.close(); }
});

test('preflight quota failover counts and generates on the replacement without generating on the exhausted account', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  a.accessToken = 'A'; b.accessToken = 'B';
  const calls: string[] = [];
  const local = await localExecutor(pool, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const counting = req.url!.includes('countTokens');
    calls.push(req.headers.authorization + (counting ? ':count' : ':generate'));
    assert.equal(pool.getAllAccounts().reduce((sum: number, account: any) => sum + account.activeConcurrency, 0), 1);
    if (counting) assert.equal(JSON.parse(raw).request.sessionId, undefined);
    if (req.headers.authorization === 'Bearer A') { res.statusCode = 429; res.end(quotaResponse()); }
    else res.end(counting ? '{"totalTokens":42}' : generationEvent());
  });
  try {
    const result = await consumeGeneration(local.executor, 'ROOT');
    assert.equal(result.inputTokenCount, 42);
    assert.deepEqual(calls, ['Bearer A:count', 'Bearer B:count', 'Bearer B:generate']);
    assert.equal(pool.getSessionBinding('ROOT').accountId, b.id);
    assert.equal(pool.sessionLeases.size, 0);
    assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
  } finally { await local.close(); }
});

test('standalone countTokens can fail over through more accounts than its transport retry budget and leaves no cold bindings', async () => {
  const { pool, accounts } = fresh([1, 1, 1, 1]);
  accounts.forEach((account: any, i: number) => { account.accessToken = String(i); });
  const seen: string[] = [];
  const local = await localExecutor(pool, (req, res) => {
    seen.push(String(req.headers.authorization));
    if (req.headers.authorization !== 'Bearer 3') { res.statusCode = 429; res.end(quotaResponse()); }
    else res.end('{"totalTokens":42}');
  });
  try {
    assert.equal((await local.executor.countTokens(generationPayload(), 1, 'ROOT')).totalTokens, 42);
    assert.equal(new Set(seen).size, 4);
    assert.equal(pool.getSessionBinding('ROOT'), undefined);
    assert.equal(pool.sessionLeases.size, 0);
    assert.ok(accounts.every((account: any) => account.activeConcurrency === 0));
  } finally { await local.close(); }
});

test('a transient preflight 503 retains the slot for generation; a policy 403 blocks generation and releases it', async () => {
  for (const status of [503, 403]) {
    const { pool, accounts: [account] } = fresh();
    let generations = 0;
    const local = await localExecutor(pool, (req, res) => {
      if (req.url!.includes('countTokens')) {
        res.statusCode = status;
        res.end(status === 403 ? '{"error":{"reason":"TOS_VIOLATION"}}' : 'temporarily unavailable');
      } else { generations++; assert.equal(account.activeConcurrency, 1); res.end(generationEvent()); }
    });
    try {
      if (status === 503) await consumeGeneration(local.executor, 'ROOT');
      else await assert.rejects(consumeGeneration(local.executor, 'ROOT'), (error: any) => error.statusCode === 403);
      assert.equal(generations, status === 503 ? 1 : 0);
      assert.equal(account.activeConcurrency, 0);
      assert.equal(pool.sessionLeases.size, 0);
    } finally { await local.close(); }
  }
});

test('a late rejection from the old account cannot clear a newer replacement binding', async () => {
  const { pool, accounts: [a, b] } = fresh([2, 2]);
  const first = lease(pool, 'ROOT'); const old1 = pool.trackLease(first, 'gemini', 'ROOT'); old1.markGeneration();
  const second = lease(pool, 'ROOT'); const old2 = pool.trackLease(second, 'gemini', 'ROOT'); old2.markGeneration();
  old1.release({ code: 429, message: quotaResponse(), retryAfterMs: 60_000 });
  const replacement = lease(pool, 'ROOT'); const current = pool.trackLease(replacement, 'gemini', 'ROOT'); current.markGeneration();
  const version = pool.getSessionBinding('ROOT').version;
  assert.equal(replacement.id, b.id);
  old2.release({ code: 429, message: quotaResponse(), retryAfterMs: 60_000 });
  assert.equal(pool.getSessionBinding('ROOT').version, version);
  assert.equal(current.isCurrent(), true);
  current.release(); current.release();
  assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
  assert.equal(pool.sessionLeases.size, 0);
});

test('all exhausted accounts return a bounded local 503 and Retry-After without exposing Google 429', async () => {
  const { pool, accounts } = fresh([1, 1, 1]);
  let requests = 0;
  const local = await localExecutor(pool, (_req, res) => { requests++; res.statusCode = 429; res.end(quotaResponse()); });
  try {
    await assert.rejects(consumeGeneration(local.executor, 'ROOT'), (error: any) =>
      error instanceof AccountSchedulingError && error.statusCode === 503 && error.code === 'quota_exhausted'
      && error.retryAfterSeconds! > 9700 && !error.message.includes('Google Upstream returned HTTP 429'));
    assert.equal(requests, 3);
    assert.ok(accounts.every((account: any) => account.activeConcurrency === 0));
    assert.equal(pool.sessionLeases.size, 0);
  } finally { await local.close(); }
});

test('ordinary rate throttling does not rotate across healthy accounts', async () => {
  const { pool, accounts: [a, b] } = fresh([1, 1]);
  let calls = 0;
  const local = await localExecutor(pool, (_req, res) => { calls++; res.statusCode = 429; res.setHeader('Retry-After', '7'); res.end('{"error":{"status":"RESOURCE_EXHAUSTED","message":"rate limit exceeded"}}'); });
  try {
    await assert.rejects(consumeGeneration(local.executor, 'ROOT'), (error: any) => error.code === 'rate_limited' && error.statusCode === 503);
    assert.equal(calls, 1);
    assert.equal(a.status, 'cooldown'); assert.equal(b.status, 'active');
    assert.equal(pool.sessionLeases.size, 0);
  } finally { await local.close(); }
});

test('all three gateway protocols hide an exhausted account and retain replacement bindings in stream and JSON responses', async () => {
  for (const stream of [false, true]) for (const url of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
    const { pool, accounts: [a, b] } = fresh([1, 1]); a.accessToken = 'A'; b.accessToken = 'B';
    const seen: string[] = [];
    const local = await localExecutor(pool, async (req, res) => {
      for await (const _ of req) { /* consume request */ }
      if (req.url!.includes('fetchAvailableModels')) { res.end('{"models":{"gemini-test":{}}}'); return; }
      if (req.url!.includes('countTokens')) { res.end('{"totalTokens":42}'); return; }
      seen.push(String(req.headers.authorization));
      if (req.headers.authorization === 'Bearer A') { res.statusCode = 429; res.end(quotaResponse()); }
      else { res.setHeader('content-type', 'text/event-stream'); res.end(generationEvent()); }
    });
    const app = await createServer(local.config, pool, {} as any, local.executor);
    try {
      const payload: any = { model: 'gemini-test', stream, ...(url === '/v1/responses' ? { input: 'test' } : { messages: [{ role: 'user', content: 'test' }] }) };
      const response = await app.inject({ method: 'POST', url, headers: { 'x-session-id': 'ROOT' }, payload });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes('QUOTA_EXHAUSTED') && !response.body.includes('Individual quota reached')
        && !response.body.includes('event: error') && !response.body.includes('Google Upstream returned HTTP 429'), response.body);
      assert.match(response.body, /ok/);
      if (url === '/v1/messages' && stream) assert.match(response.body, /"input_tokens":42/);
      assert.deepEqual(seen, ['Bearer A', 'Bearer B']);
      assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
      assert.equal(pool.sessionLeases.size, 0);
      assert.equal(pool.getSessionBinding(url === '/v1/messages' ? 'claude:ROOT' : 'ROOT').accountId, b.id);
    } finally { await app.close(); await local.close(); }
  }
});

test('subagent context overflow uses native recovery errors in preflight and generation without rotating or leaking', async () => {
  for (const phase of ['preflight', 'generation']) {
    const { pool, accounts: [a, b] } = fresh([1, 1]);
    const warm = lease(pool, 'claude:PARENT');
    const warmLease = pool.trackLease(warm, 'gemini', 'claude:PARENT'); warmLease.markGeneration(); warmLease.release();
    let overflowing = true;
    let generations = 0;
    const local = await localExecutor(pool, async (req, res) => {
      for await (const _ of req) { /* consume request */ }
      if (req.url!.includes('fetchAvailableModels')) { res.end('{"models":{"gemini-test":{}}}'); return; }
      const counting = req.url!.includes('countTokens');
      if (!counting) generations++;
      if (!overflowing) { res.end(counting ? '{"totalTokens":42}' : generationEvent()); return; }
      if (counting && phase !== 'preflight') { res.end('{"totalTokens":1050000}'); return; }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).' } }));
    });
    const app = await createServer(local.config, pool, {} as any, local.executor);
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/messages', payload: {
        model: 'gemini-test[1M]', messages: [{ role: 'user', content: 'Continue task' }],
        metadata: { user_id: JSON.stringify({ session_id: 'PARENT', agent_id: 'worker' }) }
      } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.type, 'invalid_request_error');
      assert.equal(response.json().error.code, 'context_length_exceeded');
      assert.equal(response.json().error.message, 'prompt is too long: 1050000 tokens > 1048576 maximum');
      assert.equal(generations, phase === 'preflight' ? 0 : 1);
      assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
      assert.equal(b.totalRequests, 0);
      assert.equal(pool.sessionLeases.size, 0);
      assert.equal(pool.getSessionBinding('claude:PARENT').accountId, a.id);
      overflowing = false;
      const recovered = await app.inject({ method: 'POST', url: '/v1/messages', payload: {
        model: 'gemini-test[1M]', messages: [{ role: 'user', content: 'Compacted task summary; continue work' }],
        metadata: { user_id: JSON.stringify({ session_id: 'PARENT', agent_id: 'worker' }) }
      } });
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.match(recovered.body, /ok/);
      assert.equal(pool.getSessionBinding('claude:PARENT').accountId, a.id);
      assert.equal(pool.sessionLeases.size, 0);
      assert.equal(a.activeConcurrency + b.activeConcurrency, 0);
    } finally { await app.close(); await local.close(); }
  }
});
