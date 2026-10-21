import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

function dashboard() {
  const requests: Array<{ url: string; resolve: (value: any) => void }> = [];
  const total = { innerText: '' };
  const gemini = { innerText: '' };
  const context = vm.createContext({
    localStorage: { getItem: () => null },
    document: {
      getElementById: (id: string) => id === 'stat-total' ? total : id === 'stat-gemini-5h' ? gemini : null,
      addEventListener: () => {}
    },
    window: {},
    fetch: (url: string) => new Promise(resolve => { requests.push({ url, resolve }); })
  });
  vm.runInContext(fs.readFileSync(path.resolve('public/app.js'), 'utf8'), context);
  vm.runInContext('renderFilteredAccounts = () => { globalThis.renderedQuota = renderPodHtml("gemini", cachedAccounts[0]); };', context);
  function refresh() {
    const start = requests.length;
    const done = vm.runInContext('loadAllData()', context) as Promise<void>;
    assert.equal(requests[start].url, '/api/admin/stats');
    assert.equal(requests[start + 1].url, '/api/admin/accounts');
    return {
      done,
      async finish(fraction: number, count = 1) {
        const quota = { gemini5hFraction: fraction, geminiWeeklyFraction: 1, claude5hFraction: 1, claudeWeeklyFraction: 1 };
        const reply = (data: unknown) => ({ status: 200, ok: true, json: async () => data });
        requests[start].resolve(reply({ totalAccounts: count }));
        requests[start + 1].resolve(reply({ accounts: [{ id: 'test', status: 'active', quota }] }));
        await done;
      }
    };
  }
  return { context, refresh, total, gemini };
}

test('a late old dashboard response cannot replace a newer zero with 0.5 percent', async () => {
  const { context, refresh, total, gemini } = dashboard();
  const old = refresh();
  const recent = refresh();
  await recent.finish(0, 2);
  await old.finish(0.005);
  assert.equal(total.innerText, 2);
  assert.equal(gemini.innerText, '0.0%');
  assert.equal(vm.runInContext('cachedAccounts[0].quota.gemini5hFraction', context), 0);
  assert.match(context.renderedQuota, />0\.0%<\/span>/);
  const recovery = refresh();
  await recovery.finish(0.5);
  assert.equal(gemini.innerText, '50.0%');
});

test('slow overlapping polling still displays completions in order', async () => {
  const { refresh, gemini } = dashboard();
  const first = refresh();
  const second = refresh();
  await first.finish(0.2);
  assert.equal(gemini.innerText, '20.0%');
  await second.finish(0);
  assert.equal(gemini.innerText, '0.0%');
});

test('stopping polling discards responses left over from the previous login', async () => {
  const { context, refresh, gemini } = dashboard();
  await refresh().finish(0);
  const pending = refresh();
  vm.runInContext('stopDataPolling()', context);
  await pending.finish(0.005);
  assert.equal(gemini.innerText, '0.0%');
  await refresh().finish(0.4);
  assert.equal(gemini.innerText, '40.0%');
});
