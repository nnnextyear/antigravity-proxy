import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

function dashboard(elements: Record<string, any> = {}) {
  const context = vm.createContext({
    localStorage: { getItem: () => null },
    document: { getElementById: (id: string) => elements[id] ?? null, addEventListener: () => {}, querySelectorAll: () => [] },
    window: {}, URL, setTimeout: () => 0,
    fetch: async () => { throw new Error('Offline'); }
  });
  vm.runInContext(fs.readFileSync(path.resolve('public/app.js'), 'utf8'), context);
  const run = (code: string) => vm.runInContext(code, context);
  return { context, run };
}

function account(overrides: any = {}) {
  return { id: 'test', email: 'test@example.com', status: 'active', quota: {
    gemini5hFraction: 0.5, geminiWeeklyFraction: 0.8, claude5hFraction: 1, claudeWeeklyFraction: 1
  }, ...overrides };
}

test('weekly exhaustion and a 24h retry deadline never appear as a 5h countdown', () => {
  const { context, run } = dashboard();
  context.account = account({ quota: { claude5hFraction: 0, claudeWeeklyFraction: 0,
    claudeResetTime: new Date(Date.now() + 23.95 * 3600_000).toISOString(),
    claudeWeeklyResetTime: new Date(Date.now() + 5 * 86400_000).toISOString() },
    quotaBlockedUntil: { claude: Date.now() + 86400_000 } });
  assert.equal(run('quotaResetHint(familyQuota(account, "claude")).text'), '⏸ 周额度限制');
  assert.match(run('getPoolFastest5hRecoveryText([account], "claude")'), /周额度限制/);
  context.account.quota.claudeWeeklyFraction = 0.8;
  assert.equal(run('quotaResetHint(familyQuota(account, "claude")).text'), '⏸ 限额等待');
  assert.doesNotMatch(run('getPoolFastest5hRecoveryText([account], "claude")'), /23h|回满/);
});

test('partial or missing quota never claims full and invalid timestamps never render NaN', () => {
  const { context, run } = dashboard();
  context.account = account();
  assert.match(run('renderPodHtml("gemini", account)'), /重置时间未知/);
  assert.doesNotMatch(run('renderPodHtml("gemini", account)'), /满格|NaN/);
  for (const invalid of [null, undefined, 'invalid', NaN, Infinity]) {
    context.account.quota.gemini5hFraction = invalid;
    context.account.quota.geminiResetTime = 'invalid';
    const html = run('renderPodHtml("gemini", account)');
    assert.match(html, /未检测/);
    assert.doesNotMatch(html, /满格|NaN|Infinity/);
  }
  assert.equal(run('formatResetTime("invalid")'), '');
  assert.equal(run('formatResetTime(new Date(Date.now() - 1).toISOString())'), '待刷新确认');
  assert.equal(run('formatResetTime(new Date(Date.now() + 1000).toISOString())'), '不足1分钟后');
  assert.doesNotMatch(run('formatResetTime(new Date(Date.now() + 2 * 86400_000).toISOString())'), /后后/);
});

test('known 5h and weekly reset times remain independent and a nearly full balance is not full', () => {
  const { context, run } = dashboard();
  context.account = account();
  context.account.quota.gemini5hFraction = 0.9996;
  context.account.quota.geminiResetTime = new Date(Date.now() + 2 * 3600_000).toISOString();
  context.account.quota.geminiWeeklyResetTime = new Date(Date.now() + 5 * 86400_000).toISOString();
  assert.match(run('quotaResetHint(familyQuota(account, "gemini")).text'), /2h/);
  assert.match(run('getPoolFastest5hRecoveryText([account], "gemini")'), /2h.*重置/);
  assert.match(run('getPoolFastestWeeklyRefreshText([account], "gemini")'), /5天/);
});

test('pool summaries exclude disabled and dead accounts, keep unknown separate, and count small positive balances', () => {
  const { context, run } = dashboard();
  context.accounts = [
    account({ id: 'small', quota: { gemini5hFraction: 0.005, geminiWeeklyFraction: 0.5 } }),
    account({ id: 'weekly', quota: { gemini5hFraction: 1, geminiWeeklyFraction: 0 } }),
    account({ id: 'disabled', status: 'disabled' }), account({ id: 'dead', status: 'dead' }),
    account({ id: 'unknown', quota: {} }), account({ id: 'auth', validationUrl: 'https://example.com' }),
    account({ id: 'blocked', quotaBlockedUntil: { gemini: Date.now() + 3600_000 } })
  ];
  const summary = run('summarizeFamilyQuota(accounts, "gemini")');
  assert.equal(summary.ready, 1);
  assert.equal(summary.total, 5);
  assert.equal(summary.shortAverage, 50.125);
  assert.equal(summary.weeklyAverage, 52.5);
  assert.equal(run('summarizeFamilyQuota([accounts[4]], "gemini").shortAverage'), null);
});

test('status accounts for weekly exhaustion, explicit blocks, missing data, and required authorization', () => {
  const { context, run } = dashboard();
  context.account = account();
  context.account.quota.claudeWeeklyFraction = 0;
  assert.match(run('getStatusPill(account)'), /Gemini可用/);
  context.account.quotaBlockedUntil = { gemini: Date.now() + 3600_000 };
  assert.match(run('getStatusPill(account)'), /双额度暂尽/);
  context.account = account({ quota: {} });
  assert.match(run('getStatusPill(account)'), /额度待检测/);
  context.account.validationUrl = 'https://example.com';
  assert.match(run('getStatusPill(account)'), /需授权/);
});

test('state changes update the action toolbar while unchanged polls preserve pending buttons', () => {
  const toolbar = { dataset: { state: 'active:false' }, innerHTML: 'request pending' };
  const card = { querySelector: (selector: string) => selector === '.card-actions-toolbar' ? toolbar : null };
  const { context, run } = dashboard({ 'card-test': card });
  context.account = account();
  run('updateCardInPlace(account)');
  assert.equal(toolbar.innerHTML, 'request pending');
  context.account.status = 'disabled';
  run('updateCardInPlace(account)');
  assert.match(toolbar.innerHTML, /启用/);
  assert.match(toolbar.innerHTML, /toggleAccountDisabled\('test', true/);
  assert.doesNotMatch(toolbar.innerHTML, /action-activate/);
  context.account.status = 'dead';
  context.account.lastError = 'POLICY_BLOCKED';
  run('updateCardInPlace(account)');
  assert.doesNotMatch(toolbar.innerHTML, /action-activate/);
});

test('a failed manual refresh reports failure without a success toast', async () => {
  const { context, run } = dashboard();
  run('globalThis.toasts = []; showToast = (text, type) => toasts.push({text, type});');
  await run('window.manualRefreshData()');
  assert.equal(context.toasts.length, 1);
  assert.equal(context.toasts[0].type, 'error');
  assert.match(context.toasts[0].text, /Offline/);
});

test('authorization links accept only HTTP URLs and quota rendering clamps invalid fractions', () => {
  const { context, run } = dashboard();
  context.account = account({ validationUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(run('renderPodHtml("gemini", account)'), /href="javascript:/);
  assert.match(run('renderPodHtml("gemini", account)'), /授权地址无效/);
  assert.equal(run('safeHttpUrl("https://example.com/verify")'), 'https://example.com/verify');
  assert.equal(run('quotaFraction(-0.1)'), 0);
  assert.equal(run('quotaFraction(1.1)'), 1);
  assert.equal(run('normalizeConcurrency(500)'), 50);
  assert.equal(run('normalizeConcurrency(-1)'), 1);
  assert.equal(run('normalizeProxyUrl("direct")'), '');
  assert.equal(run('normalizeProxyUrl("127.0.0.1:7897")'), 'http://127.0.0.1:7897');
  assert.equal(run('normalizeProxyUrl("socks5://127.0.0.1:1080")'), 'socks5://127.0.0.1:1080');
});

test('header loads the actual configured key and discards a late config response after logout', async () => {
  const keyText = { innerText: '' };
  const { context, run } = dashboard({ 'api-key-text': keyText });
  context.fetch = async () => ({ status: 200, ok: true, json: async () => ({ apiMasterKey: 'sk-synthetic-custom' }) });
  await run('loadDashboardConfig()');
  assert.equal(keyText.innerText, 'sk-synthetic-custom');
  let resolve!: (value: unknown) => void;
  context.fetch = () => new Promise(done => { resolve = done; });
  const pending = run('loadDashboardConfig()');
  run('stopDataPolling()');
  resolve({ status: 200, ok: true, json: async () => ({ apiMasterKey: 'sk-stale' }) });
  await pending;
  assert.equal(keyText.innerText, '未加载');
  assert.equal(run('dashboardApiKey'), null);
});
