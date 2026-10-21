import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestExecutor } from '../src/pool/breaker.js';
import type { Account } from '../src/types.js';

function pacing() {
  const executor = new RequestExecutor({} as any, {} as any, { minRequestIntervalMs: 10 } as any);
  const account = { id: 'synthetic-pacing-account' } as Account;
  const pace = (signal?: AbortSignal) => (executor as any).paceAccount(account, signal) as Promise<void>;
  const tails = (executor as any).pacingTails as Map<string, Promise<void>>;
  return { executor, account, pace, tails };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('cancelling a middle waiter preserves FIFO and allows fresh pacing requests after the queue drains', async () => {
  const { pace, tails, account } = pacing();
  let unlock!: () => void;
  tails.set(account.id, new Promise<void>(resolve => { unlock = resolve; }));
  const order: string[] = [];
  const controller = new AbortController();
  const first = pace().then(() => { order.push('first'); });
  const middle = pace(controller.signal);
  const cancelled = assert.rejects(middle, /aborted/i);
  const last = pace().then(() => { order.push('last'); });
  controller.abort();
  await cancelled;
  await flush();
  assert.deepEqual(order, [], 'cancellation must not release the pending predecessor');
  assert.ok(tails.has(account.id), 'the live tail must remain until its predecessor finishes');
  unlock();
  await Promise.all([first, last]);
  assert.deepEqual(order, ['first', 'last']);
  await pace();
  await pace();
  await flush();
  assert.equal(tails.size, 0);
});

test('cancelling the interval sleep leaves the account usable for new requests', async () => {
  const { executor, account, pace, tails } = pacing();
  const controller = new AbortController();
  // Make the sleep long enough that cancellation cannot race its expiry.
  (executor as any).lastGenerationStartAt.set(account.id, Date.now() + 60_000);
  const pending = pace(controller.signal);
  const cancelled = assert.rejects(pending, /abort/i);
  await flush();
  controller.abort();
  await cancelled;
  (executor as any).lastGenerationStartAt.delete(account.id);
  await pace();
  await pace();
  await flush();
  assert.equal(tails.size, 0);
});

test('pre-aborted requests and a burst of cancelled waiters do not poison subsequent pacing', async () => {
  const { pace, tails, account } = pacing();
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(pace(alreadyCancelled.signal), /aborted/i);
  let unlock!: () => void;
  tails.set(account.id, new Promise<void>(resolve => { unlock = resolve; }));
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  const waiting = controllers.map(controller => pace(controller.signal));
  const outcomes = Promise.allSettled(waiting);
  controllers.forEach(controller => controller.abort());
  assert.ok((await outcomes).every(outcome => outcome.status === 'rejected'));
  unlock();
  await pace();
  await pace();
  await flush();
  assert.equal(tails.size, 0);
});

test('a rejected predecessor gate is contained and subsequent requests recover without unhandled rejection', async () => {
  const { pace, tails, account } = pacing();
  // Fault injection: normal cancellation rejects its caller, not this gate.
  tails.set(account.id, Promise.reject(new Error('synthetic predecessor failure')));
  await pace();
  await pace();
  await flush();
  assert.equal(tails.size, 0);
});
