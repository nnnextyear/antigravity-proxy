import { request } from 'undici';
import { Account, AppConfig } from '../types.js';
import { AccountPool } from './account-pool.js';
import { DEFAULT_OAUTH_CLIENT_ID, DEFAULT_OAUTH_CLIENT_SECRET } from '../config.js';
import { getOrCreateDispatcher } from './dispatcher.js';
import { isInvalidGrantError } from './error-policy.js';
import { jittered } from './transport.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const DEFAULT_CLIENT_ID = DEFAULT_OAUTH_CLIENT_ID;
const DEFAULT_CLIENT_SECRET = DEFAULT_OAUTH_CLIENT_SECRET;

export class TokenRefresher {
  private timer: NodeJS.Timeout | null = null;
  private refreshInFlight = new Map<string, Promise<boolean>>();
  /** Consecutive failed refreshes per account, used to stop hammering OAuth. */
  private refreshFailures = new Map<string, number>();

  constructor(
    private pool: AccountPool,
    private config: AppConfig
  ) {}

  /**
   * A failing token exchange must not kill every account in the pool (a wrong
   * OAUTH_CLIENT_ID/SECRET produces invalid_client for all of them), but it
   * must stop the request path from re-triggering the same broken refresh on
   * every request. Park the account after a few consecutive failures.
   */
  private noteRefreshFailure(acc: Account, reason: string): void {
    const failures = (this.refreshFailures.get(acc.id) ?? 0) + 1;
    this.refreshFailures.set(acc.id, failures);
    console.warn(`[TokenRefresher] ${acc.email} 续期失败 ${failures}/3 (${reason})`);
    if (failures >= 3 && acc.status === 'active') {
      acc.status = 'cooldown';
      acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + 15 * 60 * 1000);
      console.error('[TokenRefresher] 连续 3 次续期失败：账号进入 15 分钟冷却，避免请求路径反复触发同样的失败刷新。');
    }
  }

  public start(): void {
    if (this.timer) return;
    console.log('[TokenRefresher] Starting background token refresh worker...');
    // 立即执行一次初始检查
    this.refreshEligibleAccounts().catch(e => console.error('[TokenRefresher] Initial check error:', e));

    // 定期执行
    this.timer = setInterval(() => {
      this.refreshEligibleAccounts().catch(e => console.error('[TokenRefresher] Periodic check error:', e));
    }, this.config.tokenRefreshIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[TokenRefresher] Stopped background worker.');
    }
  }

  /**
   * 刷新所有即将过期或没有 access_token 的账号
   */
  public async refreshEligibleAccounts(): Promise<void> {
    const now = Date.now();
    const tenMinutes = 10 * 60 * 1000;

    for (const acc of this.pool.getAllAccounts()) {
      if (acc.status === 'dead' || acc.status === 'disabled') continue;
      if (!acc.refreshToken) continue;

      const needsRefresh = !acc.accessToken || acc.accessTokenExpiresAt - now < tenMinutes;
      if (needsRefresh) {
        await this.refreshSingleAccount(acc);
      }
    }
  }

  /**
   * 刷新单个账号的 Access Token
   *
   * Concurrent refreshes for one account share a single request. A caller may
   * pass its request signal: the shared work keeps running (other callers and
   * the background worker still need the token), but this caller returns as
   * soon as the client goes away instead of holding an account lease for the
   * full refresh window.
   */
  public async refreshSingleAccount(acc: Account, signal?: AbortSignal): Promise<boolean> {
    const existing = this.refreshInFlight.get(acc.id);
    let refresh: Promise<boolean>;
    if (existing) {
      refresh = existing;
    } else {
      refresh = this.refreshSingleAccountInternal(acc);
      this.refreshInFlight.set(acc.id, refresh);
      void refresh.finally(() => {
        if (this.refreshInFlight.get(acc.id) === refresh) this.refreshInFlight.delete(acc.id);
      }).catch(() => {});
    }

    if (!signal) return refresh;
    if (signal.aborted) throw new Error('Request aborted by client.');
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => reject(new Error('Request aborted by client.'));
      signal.addEventListener('abort', onAbort, { once: true });
      refresh.then(
        value => { signal.removeEventListener('abort', onAbort); resolve(value); },
        err => { signal.removeEventListener('abort', onAbort); reject(err); }
      );
    });
  }

  private async refreshSingleAccountInternal(acc: Account): Promise<boolean> {
    const clientId = this.config.oauthClientId || DEFAULT_CLIENT_ID;
    const bodyParams = new URLSearchParams({
      client_id: clientId,
      refresh_token: acc.refreshToken,
      grant_type: 'refresh_token'
    });

    const clientSecret = this.config.oauthClientSecret || DEFAULT_CLIENT_SECRET;
    bodyParams.append('client_secret', clientSecret);
      const effectiveProxy = acc.proxyUrl || this.config.defaultProxyUrl;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt === 1) {
          console.log(`[TokenRefresher] Refreshing token for account: ${acc.email} (${acc.id})...`);
        }
        const dispatcher = effectiveProxy ? getOrCreateDispatcher(effectiveProxy, { timeoutMs: 30000 }) : undefined;

        const res = await request(GOOGLE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: bodyParams.toString(),
          headersTimeout: 30000,
          bodyTimeout: 30000,
          dispatcher
        });

        if (res.statusCode === 200) {
          const data = (await res.body.json()) as any;
          const newAccessToken = data.access_token;
          const expiresIn = data.expires_in || 3600;
          const preserveTerminalReason = acc.status === 'dead' || acc.status === 'disabled';

          acc.accessToken = newAccessToken;
          acc.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
          if (!preserveTerminalReason) acc.lastError = undefined;
          this.refreshFailures.delete(acc.id);
          this.pool.saveAccounts();

          console.log(`[TokenRefresher] Successfully refreshed token for ${acc.email}. Expires in ${expiresIn}s.`);
          return true;
        } else {
          let errText = '';
          try {
            errText = await res.body.text();
          } catch {
            errText = '';
          }
          console.error(`[TokenRefresher] Failed to refresh token for ${acc.email}, HTTP ${res.statusCode}:`, errText);
          acc.lastError = `OAuth Refresh Failed (${res.statusCode}): ${errText}`;
          if (isInvalidGrantError(res.statusCode, errText)) {
            // The refresh token itself is revoked: this account is finished
            // until the operator re-authorises it.
            acc.status = 'dead';
            acc.lastError = `OAuth Refresh Failed (invalid_grant): ${errText}`;
          } else if (res.statusCode === 400 || res.statusCode === 401 || res.statusCode >= 500) {
            this.noteRefreshFailure(acc, `HTTP ${res.statusCode}`);
          }
          this.pool.saveAccounts();
          return false;
        }
      } catch (e: any) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, jittered(1500)));
          continue;
        }
        console.warn(`[TokenRefresher] Network error refreshing token for ${acc.email} (will retry in next cycle):`, e.message);
        acc.lastError = `Network error: ${e.message}`;
        this.noteRefreshFailure(acc, e.message);
        return false;
      }
    }
    return false;
  }
}
