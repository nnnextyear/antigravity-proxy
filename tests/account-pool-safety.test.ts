import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

// AccountPool resolves ./data against the process cwd at import time, so give
// it a throwaway directory and never touch the real accounts file. The modules
// are imported inside a hook because this package compiles to CommonJS.
let AccountPool: any;
let sharedEgressWarning: any;
let shouldPollQuota: any;
let jittered: any;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-pool-'));

const pools: any[] = [];
const accountFile = () => path.join(sandbox, 'data', 'accounts.json');

/** Each pool gets a clean accounts file so tests cannot inherit each other's accounts. */
function makePool() {
  for (const previous of pools.splice(0)) previous.dispose();
  try { fs.rmSync(accountFile(), { force: true }); } catch { /* best effort */ }
  const pool = new AccountPool('zero-waste');
  pools.push(pool);
  return pool;
}

function seed(pool: any, overrides: Record<string, unknown> = {}) {
  const acc = pool.addAccount({
    email: `${Math.random().toString(16).slice(2)}@example.com`,
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresInSeconds: 3600
  });
  Object.assign(acc, overrides);
  return acc;
}

function quota(overrides: Record<string, unknown> = {}) {
  return {
    geminiWeeklyFraction: 1,
    gemini5hFraction: 1,
    claudeWeeklyFraction: 1,
    claude5hFraction: 1,
    ...overrides
  };
}

before(async () => {
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
  process.chdir(sandbox);
  ({ AccountPool } = await import('../src/pool/account-pool.js'));
  ({ sharedEgressWarning } = await import('../src/pool/dispatcher.js'));
  ({ shouldPollQuota } = await import('../src/pool/quota-manager.js'));
  ({ jittered } = await import('../src/pool/transport.js'));
});

after(() => {
  for (const pool of pools) pool.dispose();
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a 429 puts the account in cooldown and out of the candidate list', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 429, message: 'rate limited', retryAfterMs: 30_000 });

  assert.equal(acc.status, 'cooldown');
  assert.ok(acc.cooldownUntil > Date.now() + 25_000, 'the upstream retry hint must become the cooldown');
  assert.equal(pool.acquireAccount(), null, 'a cooling account must not be selected');
});

test('a longer cooldown is never shortened by a later 429', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 429, message: 'long', retryAfterMs: 600_000 });
  const longUntil = acc.cooldownUntil;
  pool.releaseAccount(acc.id, { code: 429, message: 'short', retryAfterMs: 1_000 });

  assert.equal(acc.cooldownUntil, longUntil, 'the cooldown must be max(), not last-writer-wins');
});

test('quota exhaustion zeroes only that family and keeps the account usable for the other', () => {
  const pool = makePool();
  const acc = seed(pool, { quota: quota() });

  pool.releaseAccount(acc.id, { code: 429, message: 'Resource has been exhausted', retryAfterMs: 60_000 }, 'claude', 'sess');

  assert.equal(acc.quota!.claude5hFraction, 0);
  assert.equal(acc.status, 'active', 'the account stays usable for the other family');
  assert.equal(acc.quota!.gemini5hFraction, 1);
  assert.ok(
    acc.quota!.claudeResetTime && new Date(acc.quota!.claudeResetTime).getTime() > Date.now(),
    'a missing reset time must get a floor so the account is not re-selected immediately'
  );
  // The claude family must be skipped, the gemini family must still be served.
  assert.equal(pool.acquireAccount(new Set(), 'claude', 'sess'), null);
  assert.ok(pool.acquireAccount(new Set(), 'gemini', 'sess'));
});

test('a policy 403 is terminal: dead, named, and never selectable again', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, {
    code: 403,
    message: JSON.stringify({ error: { reason: 'TOS_VIOLATION', message: 'This service has been disabled in this account for violation of Terms of Service.' } })
  });

  assert.equal(acc.status, 'dead');
  assert.match(acc.lastError ?? '', /POLICY_BLOCKED/);
  assert.equal(pool.acquireAccount(), null);
});

test('a late 429 cannot revive a terminal account', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 403, message: '{"error":{"reason":"TOS_VIOLATION","message":"This service has been disabled in this account."}}' });
  assert.equal(acc.status, 'dead');

  // A request that was already in flight when the account was isolated now
  // comes back rate limited; it must not downgrade the terminal state.
  pool.releaseAccount(acc.id, { code: 429, message: 'rate limited', retryAfterMs: 1_000 });

  assert.equal(acc.status, 'dead', 'a cooling window must never resurrect a blocked account');
  assert.equal(pool.acquireAccount(), null);
  assert.ok((acc.rateLimitHits ?? 0) >= 1, 'the rate-limit counter is still recorded for visibility');
});

test('unknown 403s escalate to a terminal state instead of looping forever', () => {
  const pool = makePool();
  const acc = seed(pool);
  const body = '{"error":{"message":"The caller does not have permission"}}';

  pool.releaseAccount(acc.id, { code: 403, message: body, retryAfterMs: 1_000, recoverable: true });
  assert.equal(acc.status, 'cooldown');
  const firstPark = acc.cooldownUntil;
  assert.ok(firstPark > Date.now() + 4 * 60 * 1000, 'the first strike parks it for at least five minutes');

  pool.releaseAccount(acc.id, { code: 403, message: body, retryAfterMs: 1_000, recoverable: true });
  assert.equal(acc.status, 'cooldown');
  assert.ok(acc.cooldownUntil > firstPark, 'the second strike parks it longer');

  pool.releaseAccount(acc.id, { code: 403, message: body, retryAfterMs: 1_000, recoverable: true });
  assert.equal(acc.status, 'dead', 'a persistent 403 must stop being probed');
  assert.match(acc.lastError ?? '', /FORBIDDEN_REPEATED/);
  assert.equal(pool.acquireAccount(), null);
});

test('a successful request clears the escalation counter', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 403, message: '{"error":{"message":"permission denied"}}', recoverable: true });
  assert.equal(acc.forbiddenCount, 1);

  pool.releaseAccount(acc.id); // a normal, error-free release = a served request
  assert.equal(acc.forbiddenCount, 0);
});

test('a freshly refreshed token being rejected parks the account instead of killing it', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 401, message: 'Upstream rejected the new token', recoverable: true });

  assert.equal(acc.status, 'cooldown');
  assert.ok(acc.cooldownUntil > Date.now() + 14 * 60 * 1000, 'auth replication lag must not kill the account');
  // Still escalating: a persistent offender ends up terminal.
  pool.releaseAccount(acc.id, { code: 401, message: 'again', recoverable: true });
  pool.releaseAccount(acc.id, { code: 401, message: 'again', recoverable: true });
  assert.equal(acc.status, 'dead');
});

test('a suspended-account 403 body is recognised as terminal too', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 403, message: '{"error":{"message":"This account has been suspended."}}' });

  assert.equal(acc.status, 'dead');
  // Only the policy matcher writes this marker: without it the assertion would
  // pass for ANY 403, which would hide a regression in the pattern list.
  assert.match(acc.lastError ?? '', /POLICY_BLOCKED/);
});

test('reloading accounts.json keeps in-flight leases and never revives a dead account', () => {
  const pool = makePool();
  const acc = seed(pool);

  const leased = pool.acquireAccount();
  assert.ok(leased);
  assert.equal(leased.activeConcurrency, 1);

  pool.releaseAccount(acc.id, { code: 403, message: '{"error":{"reason":"TOS_VIOLATION"}}' });
  const deadAcc = pool.getAccount(acc.id)!;
  deadAcc.activeConcurrency = 1; // pretend one request is still finishing

  // Simulate a stale writer (an editor tab, a second process) that still has
  // the account as active with no leases.
  const stale = JSON.parse(fs.readFileSync(accountFile(), 'utf-8'));
  for (const entry of stale) {
    entry.status = 'active';
    entry.activeConcurrency = 0;
    entry.lastError = undefined;
    entry.cooldownUntil = 0;
  }
  fs.writeFileSync(accountFile(), JSON.stringify(stale, null, 2), 'utf-8');

  pool.loadAccounts();

  const reloaded = pool.getAccount(acc.id)!;
  assert.equal(reloaded.activeConcurrency, 1, 'in-flight leases must survive a reload');
  assert.equal(reloaded.status, 'dead', 'a stale file copy must not resurrect a dead account');
  assert.equal(pool.acquireAccount(), null);
});

test('a stale file copy cannot erase an active cooldown', () => {
  const pool = makePool();
  const acc = seed(pool);

  pool.releaseAccount(acc.id, { code: 429, message: 'rate limited', retryAfterMs: 600_000 });
  assert.equal(acc.status, 'cooldown');

  const stale = JSON.parse(fs.readFileSync(accountFile(), 'utf-8'));
  for (const entry of stale) { entry.status = 'active'; entry.cooldownUntil = 0; }
  fs.writeFileSync(accountFile(), JSON.stringify(stale), 'utf-8');

  pool.loadAccounts();

  const reloaded = pool.getAccount(acc.id)!;
  assert.equal(reloaded.status, 'cooldown', 'the anti-ban throttle must survive a stale reload');
  assert.ok(reloaded.cooldownUntil > Date.now() + 500_000);
});

test('background quota polling skips accounts the request path is resting', () => {
  const now = Date.now();
  const base = { status: 'active', cooldownUntil: 0, accessToken: 'token', accessTokenExpiresAt: now + 60_000 };

  assert.equal(shouldPollQuota({ ...base } as any, now), true);
  assert.equal(shouldPollQuota({ ...base, status: 'dead' } as any, now), false);
  assert.equal(shouldPollQuota({ ...base, status: 'disabled' } as any, now), false);
  assert.equal(shouldPollQuota({ ...base, status: 'cooldown', cooldownUntil: now + 60_000 } as any, now), false);
  assert.equal(shouldPollQuota({ ...base, status: 'cooldown', cooldownUntil: now - 1 } as any, now), true);
  assert.equal(shouldPollQuota({ ...base, accessTokenExpiresAt: now - 1 } as any, now), false);
  assert.equal(
    shouldPollQuota({ ...base } as any, now, { pausedUntil: now + 30_000 }),
    false,
    'a throttled endpoint must be able to pause polling'
  );
});

test('a validation-flagged account is re-probed on a slow cadence, not frozen forever', () => {
  const now = Date.now();
  const flagged = {
    status: 'active',
    cooldownUntil: 0,
    accessToken: 'token',
    accessTokenExpiresAt: now + 60_000,
    validationUrl: 'https://verify.example'
  };

  assert.equal(shouldPollQuota({ ...flagged } as any, now, { lastAttemptAt: now - 60_000 }), false,
    'do not hammer an account that is waiting for manual verification');
  assert.equal(shouldPollQuota({ ...flagged } as any, now, { lastAttemptAt: now - 31 * 60 * 1000 }), true,
    'the flag can only clear through a successful poll, so it must be retried eventually');
});

test('an operator refresh bypasses cooldown, pause and validation waits', () => {
  const now = Date.now();
  const cooling = {
    status: 'cooldown',
    cooldownUntil: now + 600_000,
    validationUrl: 'https://verify.example',
    accessToken: 'token',
    accessTokenExpiresAt: now + 60_000
  };

  assert.equal(shouldPollQuota({ ...cooling } as any, now, { pausedUntil: now + 600_000, lastAttemptAt: now }), false);
  assert.equal(shouldPollQuota({ ...cooling } as any, now, { pausedUntil: now + 600_000, lastAttemptAt: now, force: true }), true);
  // A terminal account is never polled, force or not.
  assert.equal(shouldPollQuota({ ...cooling, status: 'dead' } as any, now, { force: true }), false);
  assert.equal(shouldPollQuota({ ...cooling, accessToken: '' } as any, now, { force: true }), false);
});

test('shared egress is reported so the operator can isolate accounts', () => {
  assert.equal(sharedEgressWarning(['http://a:1', 'http://b:2'], undefined), undefined);
  assert.equal(sharedEgressWarning(['http://a:1'], 'http://b:2'), undefined);
  const sameProxy = sharedEgressWarning(['http://a:1', undefined], 'http://a:1');
  assert.ok(sameProxy && sameProxy.includes('2 个账号') && sameProxy.includes('http://a:1'));
  const noProxyAtAll = sharedEgressWarning([undefined, undefined], undefined);
  assert.ok(noProxyAtAll && noProxyAtAll.includes('(direct)'), 'two accounts on one direct route share an egress too');
});

test('retry delays are jittered so sessions do not fire in lockstep', () => {
  const samples = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const value = jittered(1000);
    assert.ok(value >= 800 && value <= 1200, `jittered(1000) produced ${value}`);
    samples.add(value);
  }
  assert.ok(samples.size > 5, 'jitter must actually vary');
});

test('policy and location wording beyond the original three phrases is recognised', async () => {
  const { isPolicyBlockedError, isLocationError } = await import('../src/pool/error-policy.js');

  for (const body of [
    '{"error":{"reason":"SUSPENDED_ACCOUNT","message":"nope"}}',
    '{"error":{"reason":"ACCOUNT_DISABLED","message":"nope"}}',
    '{"error":{"message":"This account has been suspended."}}',
    '{"error":{"message":"Your access has been revoked after a violation of terms of service."}}'
  ]) {
    assert.equal(isPolicyBlockedError(403, body), true, `should be terminal: ${body}`);
  }
  assert.equal(isPolicyBlockedError(403, '{"error":{"message":"The caller does not have permission"}}'), false);

  for (const body of [
    'User location is not supported for the API use.',
    'This service is not available in your country.',
    'unsupported country'
  ]) {
    assert.equal(isLocationError(403, body), true, `should be a location block: ${body}`);
  }
  assert.equal(isLocationError(403, '{"error":{"message":"rate limited"}}'), false);
});
