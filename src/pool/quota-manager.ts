import { request } from 'undici';
import { Account, AccountQuota, AppConfig } from '../types.js';
import { AccountPool } from './account-pool.js';
import { getOrCreateDispatcher, resetDispatcher } from './dispatcher.js';
import { isPolicyBlockedError } from './error-policy.js';

export class QuotaManager {
  private pollTimer: NodeJS.Timeout | null = null;
  private quotaInFlight = new Map<string, Promise<AccountQuota | null>>();
  private quotaLastAttemptAt = new Map<string, number>();
  private readonly minFetchIntervalMs = 30 * 1000;

  constructor(
    private pool: AccountPool,
    private config?: AppConfig
  ) {}

  /**
   * 从 Google 官方上游 (v1internal:retrieveUserQuotaSummary) 拉取账号实时额度
   */
  public async fetchQuotaForAccount(
    account: Account,
    options: { forceRefresh?: boolean } = {}
  ): Promise<AccountQuota | null> {
    if (!account.accessToken) return null;

    const existing = this.quotaInFlight.get(account.id);
    if (existing) return existing;

    const lastAttemptAt = this.quotaLastAttemptAt.get(account.id) ?? account.quota?.lastCheckedAt ?? 0;
    if (!options.forceRefresh && Date.now() - lastAttemptAt < this.minFetchIntervalMs) {
      return account.quota || null;
    }

    const fetch = this.fetchQuotaForAccountInternal(account);
    this.quotaInFlight.set(account.id, fetch);
    this.quotaLastAttemptAt.set(account.id, Date.now());
    try {
      return await fetch;
    } finally {
      if (this.quotaInFlight.get(account.id) === fetch) this.quotaInFlight.delete(account.id);
    }
  }

  private async fetchQuotaForAccountInternal(account: Account): Promise<AccountQuota | null> {

    try {
      const effectiveProxy = account.proxyUrl || this.config?.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      const dispatcher = getOrCreateDispatcher(effectiveProxy, { timeoutMs: 30000 });
    let res: any;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await request('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/2.14.0',
            'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
          },
          body: JSON.stringify({ project: 'aicode-consumers' }),
          headersTimeout: 30000,
          bodyTimeout: 30000,
          dispatcher
        });
        break;
      } catch (err: any) {
        if (attempt < 2) {
          resetDispatcher(effectiveProxy, { timeoutMs: 30000 });
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        console.warn(`[QuotaManager] Network error fetching quota for ${account.email} (transient socket drop, will retry next cycle):`, err.message);
        return null;
      }
    }

      if (res.statusCode !== 200) {
        const errText = await res.body.text();
        console.warn(`[QuotaManager] Failed to fetch quota for ${account.email} (HTTP ${res.statusCode}): ${errText.substring(0, 100)}`);
        if (isPolicyBlockedError(res.statusCode, errText)) {
          // Quota polling is another upstream request. A policy 403 must
          // isolate the account here too, otherwise the background worker
          // would keep probing a disabled account every polling interval.
          account.status = 'dead';
          account.lastError = `[POLICY_BLOCKED] ${errText}`;
          this.pool.updateAccount(account.id, { status: 'dead', lastError: account.lastError });
          return null;
        }
        try {
          const errJson = JSON.parse(errText);
          const validationDetail = errJson.error?.details?.find((d: any) => d.reason === 'VALIDATION_REQUIRED' || d.metadata?.validation_url);
          const validationUrl = validationDetail?.metadata?.validation_url || (errJson.error?.message?.includes('Verify your account') ? errJson.error?.details?.[0]?.metadata?.validation_url : undefined);

          if (validationUrl) {
            account.validationUrl = validationUrl;
            account.lastError = '需要完成 Google 账号验证';
            this.pool.updateAccount(account.id, { validationUrl, lastError: account.lastError });
          } else {
            account.lastError = `HTTP ${res.statusCode}: ${errJson.error?.message || errText.substring(0, 60)}`;
            this.pool.updateAccount(account.id, { lastError: account.lastError });
          }
        } catch {
          account.lastError = `HTTP ${res.statusCode}`;
          this.pool.updateAccount(account.id, { lastError: account.lastError });
        }
        return null;
      }

      const data = (await res.body.json()) as any;
      const groups = data.groups || [];

      let geminiWeekly = 1.0;
      let gemini5h = 1.0;
      let geminiResetTime = '';
      let geminiWeeklyResetTime = '';
      let gemini5hDesc = '';
      let geminiWeeklyDesc = '';

      let claudeWeekly = 1.0;
      let claude5h = 1.0;
      let claudeResetTime = '';
      let claudeWeeklyResetTime = '';
      let claude5hDesc = '';
      let claudeWeeklyDesc = '';

      for (const group of groups) {
        const dName = (group.displayName || '').toLowerCase();
        const buckets = group.buckets || [];

        if (dName.includes('gemini')) {
          for (const b of buckets) {
            if (b.window === 'weekly' || b.bucketId === 'gemini-weekly') {
              geminiWeekly = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
              if (b.resetTime) geminiWeeklyResetTime = b.resetTime;
              if (b.description) geminiWeeklyDesc = b.description;
            }
            if (b.window === '5h' || b.bucketId === 'gemini-5h') {
              gemini5h = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
              if (b.resetTime) geminiResetTime = b.resetTime;
              if (b.description) gemini5hDesc = b.description;
            }
          }
        } else if (dName.includes('claude') || dName.includes('gpt')) {
          for (const b of buckets) {
            if (b.window === 'weekly' || b.bucketId === '3p-weekly') {
              claudeWeekly = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
              if (b.resetTime) claudeWeeklyResetTime = b.resetTime;
              if (b.description) claudeWeeklyDesc = b.description;
            }
            if (b.window === '5h' || b.bucketId === '3p-5h') {
              claude5h = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
              if (b.resetTime) claudeResetTime = b.resetTime;
              if (b.description) claude5hDesc = b.description;
            }
          }
        }
      }

      const quota: AccountQuota = {
        geminiWeeklyFraction: Math.round(geminiWeekly * 10000) / 10000,
        gemini5hFraction: Math.round(gemini5h * 10000) / 10000,
        geminiResetTime: geminiResetTime || undefined,
        geminiWeeklyResetTime: geminiWeeklyResetTime || undefined,
        gemini5hDesc: gemini5hDesc || undefined,
        geminiWeeklyDesc: geminiWeeklyDesc || undefined,
        claudeWeeklyFraction: Math.round(claudeWeekly * 10000) / 10000,
        claude5hFraction: Math.round(claude5h * 10000) / 10000,
        claudeResetTime: claudeResetTime || undefined,
        claudeWeeklyResetTime: claudeWeeklyResetTime || undefined,
        claude5hDesc: claude5hDesc || undefined,
        claudeWeeklyDesc: claudeWeeklyDesc || undefined,
        lastCheckedAt: Date.now()
      };

      const preserveTerminalReason = account.status === 'dead' || account.status === 'disabled';
      account.quota = quota;
      account.validationUrl = undefined;
      if (!preserveTerminalReason) account.lastError = undefined;
      this.pool.updateAccount(account.id, {
        quota,
        validationUrl: undefined,
        ...(preserveTerminalReason ? {} : { lastError: undefined })
      });
      return quota;
    } catch (err: any) {
      console.error(`[QuotaManager] Error fetching quota for ${account.email}:`, err.message);
      return null;
    }
  }

  /**
   * 刷新账号池内所有活跃账号的额度
   */
  public async fetchAllQuotas(options: { forceRefresh?: boolean } = {}): Promise<void> {
    const accounts = this.pool.getAllAccounts();
    for (const acc of accounts) {
      if (acc.status === 'dead' || acc.status === 'disabled') continue;
      await this.fetchQuotaForAccount(acc, options);
      // 适度防抖
      await new Promise(r => setTimeout(r, 600));
    }
  }

  /**
   * 启动后台额度自动轮询（默认每 3 分钟更新一次）
   */
  public startBackgroundWorker(intervalMs = 180000): void {
    if (this.pollTimer) return;
    console.log('[QuotaManager] Starting background quota monitor worker...');

    // 延迟 5 秒后首次运行
    setTimeout(() => {
      this.fetchAllQuotas().catch(() => {});
    }, 5000);

    this.pollTimer = setInterval(() => {
      this.fetchAllQuotas().catch(() => {});
    }, intervalMs);
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
