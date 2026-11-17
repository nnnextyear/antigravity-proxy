import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { AccountPool } from '../src/pool/account-pool.js';
import type { AppConfig, GoogleCloudCodePayload } from '../src/types.js';

export const config: AppConfig = {
  port: 0, host: '127.0.0.1', apiMasterKey: 'test-client-key', adminPassword: 'test-admin-password',
  upstreamUrl: 'https://upstream.invalid/v1internal:streamGenerateContent?alt=sse',
  defaultMaxConcurrency: 1, cooldownSeconds: 12, tokenRefreshIntervalMs: 60000,
  minRequestIntervalMs: 0, globalMinRequestIntervalMs: 0
};
export function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'antigravity-tests-'));
  const pool = new AccountPool('round-robin', directory);
  t.after(() => { pool.dispose(); rmSync(directory, { recursive: true, force: true }); });
  const accounts = ['first', 'second'].map(name => pool.addAccount({
    email: name + '@example.invalid', refreshToken: 'secret-refresh-' + name,
    accessToken: 'secret-access-' + name, maxConcurrency: 1
  }));
  return { pool, accounts };
}
export const payload: GoogleCloudCodePayload = {
  project: 'test-project', model: 'gemini-3.8-flash-high',
  request: { contents: [{ role: 'user', parts: [{ text: '你好' }] }],
    systemInstruction: { parts: [{ text: 'Keep the system instructions.' }] } }
};
export const generic429 = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } });
