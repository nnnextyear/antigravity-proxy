import { request, ProxyAgent } from 'undici';
import { Account, AccountQuota } from '../types.js';
import { AccountPool } from './account-pool.js';

export class QuotaManager {
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private pool: AccountPool) {}

  /**
   * 从 Google 官方上游 (v1internal:retrieveUserQuotaSummary) 拉取账号实时额度
   */
  public async fetchQuotaForAccount(account: Account): Promise<AccountQuota | null> {
    if (!account.accessToken) return null;

    try {
      const dispatcher = account.proxyUrl ? new ProxyAgent(account.proxyUrl) : undefined;
      const res = await request('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/2.14.0',
          'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
        },
        body: JSON.stringify({ project: 'aicode-consumers' }),
        headersTimeout: 15000,
        bodyTimeout: 15000,
        dispatcher
      });

      if (res.statusCode !== 200) {
        const errText = await res.body.text();
        console.warn(`[QuotaManager] Failed to fetch quota for ${account.email} (HTTP ${res.statusCode}): ${errText.substring(0, 100)}`);
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

      account.quota = quota;
      account.validationUrl = undefined;
      account.lastError = undefined;
      this.pool.updateAccount(account.id, { quota, validationUrl: undefined, lastError: undefined });
      return quota;
    } catch (err: any) {
      console.error(`[QuotaManager] Error fetching quota for ${account.email}:`, err.message);
      return null;
    }
  }

  /**
   * 刷新账号池内所有活跃账号的额度
   */
  public async fetchAllQuotas(): Promise<void> {
    const accounts = this.pool.getAllAccounts();
    for (const acc of accounts) {
      if (acc.status === 'dead') continue;
      await this.fetchQuotaForAccount(acc);
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
