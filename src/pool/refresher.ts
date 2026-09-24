import { request, ProxyAgent } from 'undici';
import { Account, AppConfig } from '../types.js';
import { AccountPool } from './account-pool.js';
import { DEFAULT_OAUTH_CLIENT_ID, DEFAULT_OAUTH_CLIENT_SECRET } from '../config.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const DEFAULT_CLIENT_ID = DEFAULT_OAUTH_CLIENT_ID;
const DEFAULT_CLIENT_SECRET = DEFAULT_OAUTH_CLIENT_SECRET;

export class TokenRefresher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private pool: AccountPool,
    private config: AppConfig
  ) {}

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
   */
  public async refreshSingleAccount(acc: Account): Promise<boolean> {
    const clientId = this.config.oauthClientId || DEFAULT_CLIENT_ID;
    const bodyParams = new URLSearchParams({
      client_id: clientId,
      refresh_token: acc.refreshToken,
      grant_type: 'refresh_token'
    });

    const clientSecret = this.config.oauthClientSecret || DEFAULT_CLIENT_SECRET;
    bodyParams.append('client_secret', clientSecret);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt === 1) {
          console.log(`[TokenRefresher] Refreshing token for account: ${acc.email} (${acc.id})...`);
        }
        const effectiveProxy = acc.proxyUrl || this.config.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const dispatcher = effectiveProxy ? new ProxyAgent({
          uri: effectiveProxy,
          connect: { timeout: 30000 }
        }) : undefined;

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

          acc.accessToken = newAccessToken;
          acc.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
          if (acc.status === 'dead') {
            acc.status = 'active';
          }
          acc.lastError = undefined;
          this.pool.saveAccounts();

          console.log(`[TokenRefresher] Successfully refreshed token for ${acc.email}. Expires in ${expiresIn}s.`);
          return true;
        } else {
          const errText = await res.body.text();
          console.error(`[TokenRefresher] Failed to refresh token for ${acc.email}, HTTP ${res.statusCode}:`, errText);
          acc.lastError = `OAuth Refresh Failed (${res.statusCode}): ${errText}`;
          if (res.statusCode === 400 || res.statusCode === 401) {
            acc.status = 'dead';
          }
          this.pool.saveAccounts();
          return false;
        }
      } catch (e: any) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        console.warn(`[TokenRefresher] Network error refreshing token for ${acc.email} (will retry in next cycle):`, e.message);
        acc.lastError = `Network error: ${e.message}`;
        return false;
      }
    }
    return false;
  }
}
