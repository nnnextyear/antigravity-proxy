import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { AccountPool } from '../src/pool/account-pool.js';
import { QuotaManager } from '../src/pool/quota-manager.js';
import { registerAdminRoutes } from '../src/admin/routes.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { AccountQuota } from '../src/types.js';

function quota(overrides: Partial<AccountQuota> = {}): AccountQuota {
  return { gemini5hFraction: 1, geminiWeeklyFraction: 1, claude5hFraction: 1, claudeWeeklyFraction: 1, ...overrides };
}

function summary() {
  return { groups: [
    { displayName: 'Gemini', buckets: [
      { window: '5h', remainingFraction: 0.005 },
      { window: 'weekly', remainingFraction: 0.8 }
    ] },
    { displayName: 'Claude / GPT', buckets: [
      { window: '5h', remainingFraction: 0.6 },
      { window: 'weekly', remainingFraction: 0.7 }
    ] }
  ] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-quota-'));
  const pool = new AccountPool('zero-waste', directory);
  const account = pool.addAccount({
    email: 'quota-test@example.com', refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access', expiresInSeconds: 3600
  });
  pool.updateAccount(account.id, { quota: quota({ lastCheckedAt: Date.now() }) });
  const manager = new QuotaManager(pool);
  const previousDispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const intercept = () => mock.get('https://daily-cloudcode-pa.googleapis.com').intercept({
    path: '/v1internal:retrieveUserQuotaSummary', method: 'POST'
  });
  t.after(async () => {
    pool.dispose();
    manager.stop();
    setGlobalDispatcher(previousDispatcher);
    await mock.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { pool, account, manager, mock, intercept, file: path.join(directory, 'accounts.json') };
}

for (const family of ['gemini', 'claude'] as const) {
  test(family + ' exhaustion stays zero despite a positive quota poll; other quotas still update', async t => {
    const { pool, account, manager, intercept, mock } = harness(t);
    pool.releaseAccount(account.id, { code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 }, family);
    const blockedUntil = account.quotaBlockedUntil![family]!;
    const exhaustionReason = account.lastError;
    intercept().reply(200, summary());
    const polled = await manager.fetchQuotaForAccount(account, { forceRefresh: true });
    assert.ok(polled);
    assert.equal(polled, pool.getAccount(account.id)!.quota);
    assert.equal(polled.gemini5hFraction, family === 'gemini' ? 0 : 0.005);
    assert.equal(polled.claude5hFraction, family === 'claude' ? 0 : 0.6);
    assert.equal(polled.geminiWeeklyFraction, 0.8);
    assert.equal(polled.claudeWeeklyFraction, 0.7);
    assert.equal(family === 'gemini' ? polled.geminiResetTime : polled.claudeResetTime, undefined);
    assert.ok(blockedUntil > Date.now(), 'scheduling still honors the separate rejection deadline');
    assert.equal(account.lastError, exhaustionReason);
    assert.equal(pool.acquireAccount(new Set(), family), null);
    mock.assertNoPendingInterceptors();
  });
}

test('a real positive poll after the quota block expires restores quota and scheduling', async t => {
  const { pool, account, manager, intercept } = harness(t);
  pool.releaseAccount(account.id, { code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 }, 'gemini');
  account.quotaBlockedUntil = { gemini: Date.now() - 1 };
  const response = summary();
  response.groups[0].buckets[0].remainingFraction = 0.5;
  intercept().reply(200, response);
  const polled = await manager.fetchQuotaForAccount(account, { forceRefresh: true });
  assert.equal(polled?.gemini5hFraction, 0.5);
  assert.equal(account.lastError, undefined);
  assert.equal(pool.acquireAccount(new Set(), 'gemini')?.id, account.id);
});

test('a daily retry deadline never replaces the upstream 5h or weekly reset timestamp', async t => {
  const { pool, account, manager, intercept } = harness(t);
  const shortReset = new Date(Date.now() + 2 * 3600_000).toISOString();
  const weeklyReset = new Date(Date.now() + 5 * 86400_000).toISOString();
  pool.updateAccount(account.id, { quota: quota({ claudeResetTime: shortReset, claudeWeeklyResetTime: weeklyReset }) });
  pool.releaseAccount(account.id, { code: 429, message: 'Individual quota reached', retryAfterMs: 86400_000 }, 'claude');
  assert.equal(account.quota?.claudeResetTime, shortReset);
  assert.equal(account.quota?.claudeWeeklyResetTime, weeklyReset);
  const response = summary() as any;
  response.groups[1].buckets[0].resetTime = shortReset;
  response.groups[1].buckets[1].remainingFraction = 0;
  response.groups[1].buckets[1].resetTime = weeklyReset;
  intercept().reply(200, response);
  const polled = await manager.fetchQuotaForAccount(account, { forceRefresh: true });
  assert.equal(polled?.claudeResetTime, shortReset);
  assert.equal(polled?.claudeWeeklyResetTime, weeklyReset);
  assert.equal(polled?.claude5hFraction, 0);
  assert.equal(pool.acquireAccount(new Set(), 'claude'), null);
  assert.ok(pool.acquireAccount(new Set(), 'gemini'));
});

test('a stale file reload keeps an active zero and the newer values of other quotas', t => {
  const { pool, account, file } = harness(t);
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  pool.updateAccount(account.id, { quota: quota({ claude5hFraction: 0.4, lastCheckedAt: Date.now() + 1 }) });
  pool.releaseAccount(account.id, { code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 }, 'gemini');
  fs.writeFileSync(file, JSON.stringify(stale));
  pool.loadAccounts();
  const reloaded = pool.getAccount(account.id)!;
  assert.notEqual(reloaded, account);
  assert.equal(reloaded.quota?.gemini5hFraction, 0);
  assert.equal(reloaded.quota?.claude5hFraction, 0.4);
  assert.equal(reloaded.quotaBlockedUntil?.gemini, account.quotaBlockedUntil?.gemini);
});

test('an in-flight manual quota refresh returns live zeroed state after a file reload and rejection', async t => {
  const { pool, account, manager, intercept } = harness(t);
  const arrived = deferred<void>();
  const response = deferred<ReturnType<typeof summary>>();
  intercept().reply(200, () => {
    arrived.resolve();
    return response.promise as any;
  });
  const app = Fastify();
  registerAdminRoutes(app, pool, {} as any, { ...DEFAULT_CONFIG, adminPassword: 'quota-test' }, manager);
  t.after(() => app.close());
  const pending = app.inject({
    method: 'POST', url: '/api/admin/accounts/' + account.id + '/quota',
    headers: { 'x-admin-password': 'quota-test' }
  });
  // Observe the mock request so this race is tested without timed sleeps.
  const completion = Promise.resolve(pending);
  await arrived.promise;
  pool.loadAccounts();
  pool.releaseAccount(account.id, { code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 }, 'gemini');
  response.resolve(summary());
  const result = await completion;
  assert.equal(result.statusCode, 200);
  const body = result.json();
  assert.equal(body.success, true);
  assert.equal(body.quota.gemini5hFraction, 0);
  assert.equal(body.account.quota.gemini5hFraction, 0);
  assert.equal(body.account.quotaBlockedUntil.gemini, pool.getAccount(account.id)!.quotaBlockedUntil!.gemini);
  const listing = await app.inject({ url: '/api/admin/accounts', headers: { 'x-admin-password': 'quota-test' } });
  assert.equal(listing.json().accounts[0].quota.gemini5hFraction, 0);
});

test('a pending quota response cannot revive a removed account', async t => {
  const { pool, account, manager, intercept } = harness(t);
  const response = deferred<ReturnType<typeof summary>>();
  intercept().reply(200, () => response.promise as any);
  const pending = manager.fetchQuotaForAccount(account, { forceRefresh: true });
  pool.removeAccount(account.id);
  response.resolve(summary());
  assert.equal(await pending, null);
  assert.equal(pool.getAccount(account.id), undefined);
});

test('exhaustion before the first quota poll also keeps the first snapshot at zero', async t => {
  const { pool, account, manager, intercept } = harness(t);
  account.quota = undefined;
  pool.releaseAccount(account.id, { code: 429, message: 'Individual quota reached', retryAfterMs: 60_000 }, 'gemini');
  intercept().reply(200, summary());
  assert.equal((await manager.fetchQuotaForAccount(account, { forceRefresh: true }))?.gemini5hFraction, 0);
});

test('ordinary throttling does not zero a valid quota snapshot', async t => {
  const { pool, account, manager, intercept } = harness(t);
  pool.releaseAccount(account.id, { code: 429, message: 'Too many requests', retryAfterMs: 60_000 }, 'gemini');
  intercept().reply(200, summary());
  const polled = await manager.fetchQuotaForAccount(account, { forceRefresh: true });
  assert.equal(polled?.gemini5hFraction, 0.005);
  assert.equal(account.status, 'cooldown');
});

test('missing or invalid quota buckets remain unknown rather than becoming full', async t => {
  const { account, manager, intercept } = harness(t);
  intercept().reply(200, { groups: [{ displayName: 'Gemini', buckets: [
    { window: '5h', remainingFraction: null }, { window: 'weekly', remainingFraction: 0.3 }
  ] }] });
  const polled = await manager.fetchQuotaForAccount(account, { forceRefresh: true });
  assert.equal(polled?.gemini5hFraction, undefined);
  assert.equal(polled?.geminiWeeklyFraction, 0.3);
  assert.equal(polled?.claude5hFraction, undefined);
  assert.equal(polled?.claudeWeeklyFraction, undefined);
});

test('loading old data clears a synthetic 5h deadline but preserves the block and weekly reset', t => {
  const { pool, account, file } = harness(t);
  const block = Date.now() + 86400_000 + 0.25;
  const weeklyReset = new Date(Date.now() + 5 * 86400_000).toISOString();
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored[0].quotaBlockedUntil = { claude: block };
  stored[0].quota.claude5hFraction = 0;
  stored[0].quota.claudeWeeklyFraction = 0;
  stored[0].quota.claudeResetTime = new Date(block).toISOString();
  stored[0].quota.claudeWeeklyResetTime = weeklyReset;
  fs.writeFileSync(file, JSON.stringify(stored));
  pool.loadAccounts();
  const loaded = pool.getAccount(account.id)!;
  assert.equal(loaded.quota?.claudeResetTime, undefined);
  assert.equal(loaded.quota?.claudeWeeklyResetTime, weeklyReset);
  assert.equal(loaded.quotaBlockedUntil?.claude, block);
  assert.equal(pool.acquireAccount(new Set(), 'claude'), null);
});
