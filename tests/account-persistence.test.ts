import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AccountPool } from '../src/pool/account-pool.js';

function persistence(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-save-'));
  let notifyChange!: () => void;
  let closed = false;
  // Drive actual watcher logic without depending on OS event-delivery timing.
  t.mock.method(fs, 'watch', (_file: string, callback: () => void) => {
    notifyChange = callback;
    return { close: () => { closed = true; } } as fs.FSWatcher;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = new AccountPool('zero-waste', directory);
  const reloaded = t.mock.method(pool, 'loadAccounts');
  t.after(() => {
    pool.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { pool, reloaded, notifyChange: () => notifyChange(), closed: () => closed };
}

test('overlapping saves suppress self-write events until 500ms after the latest save', t => {
  const { pool, reloaded, notifyChange } = persistence(t);
  // The constructor saved at t=0. Save again at t=400.
  t.mock.timers.tick(400);
  pool.saveAccounts();
  // The original t=500 callback must not clear the new save's protection.
  t.mock.timers.tick(150);
  notifyChange();
  t.mock.timers.tick(300);
  assert.equal(reloaded.mock.callCount(), 0, 'an earlier save must not expose later self-write events');
  t.mock.timers.tick(50);
  // An external change after t=900 must still be reloaded normally.
  notifyChange();
  t.mock.timers.tick(299);
  assert.equal(reloaded.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(reloaded.mock.callCount(), 1);
});

test('disposing a pool cancels its pending save-release and reload timers', t => {
  const { pool, reloaded, notifyChange, closed } = persistence(t);
  const setTimeoutCalls = t.mock.method(globalThis, 'setTimeout');
  const clearTimeoutCalls = t.mock.method(globalThis, 'clearTimeout');
  t.mock.timers.tick(500);
  notifyChange();
  pool.saveAccounts();
  assert.equal(setTimeoutCalls.mock.callCount(), 2, 'a debounce and a save-release timer were scheduled');
  pool.dispose();
  for (const scheduled of setTimeoutCalls.mock.calls) {
    assert.ok(clearTimeoutCalls.mock.calls.some(call => call.arguments[0] === scheduled.result), 'each pending timer must be cancelled');
  }
  assert.equal(closed(), true);
  t.mock.timers.tick(1000);
  assert.equal(reloaded.mock.callCount(), 0);
});
