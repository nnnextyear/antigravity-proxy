import { request, ProxyAgent } from 'undici';
import { Account, AppConfig, GoogleCloudCodePayload } from '../types.js';
import { AccountPool } from './account-pool.js';
import { TokenRefresher } from './refresher.js';

import { QuotaManager } from './quota-manager.js';

export interface UpstreamExecutionResult {
  statusCode: number;
  headers: Record<string, any>;
  bodyStream: any;
  accountUsed: Account;
}

export class RequestExecutor {
  constructor(
    private pool: AccountPool,
    private refresher: TokenRefresher,
    private config: AppConfig,
    private quotaManager?: QuotaManager
  ) {}

  /**
   * 携带重试与熔断的执行器 (支持模型族群额度感知与智能无感换号)
   */
  public async executeWithRetry(
    payload: GoogleCloudCodePayload,
    maxRetries = 3,
    sessionKey?: string
  ): Promise<UpstreamExecutionResult> {
    const triedAccountIds = new Set<string>();
    const model = (payload.model || '').toLowerCase();
    const family: 'claude' | 'gemini' = (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('gpt') || model.includes('oss'))
      ? 'claude'
      : 'gemini';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const account = this.pool.acquireAccount(triedAccountIds, family, sessionKey);

      if (!account) {
        throw new Error('All accounts in the pool are busy, in cooldown, or exhausted.');
      }

      triedAccountIds.add(account.id);

      // 检查 Token 是否需要刷新
      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        const ok = await this.refresher.refreshSingleAccount(account);
        if (!ok) {
          this.pool.releaseAccount(account.id, { code: 401, message: 'Initial token refresh failed' });
          continue; // 换下一个号重试
        }
      }

      try {
        const dispatcher = account.proxyUrl ? new ProxyAgent(account.proxyUrl) : undefined;
        const upstreamHeaders: Record<string, string> = {
          'Authorization': `Bearer ${account.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/2.14.0',
          'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
        };

        const res = await request(this.config.upstreamUrl, {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify(payload),
          headersTimeout: 600000,
          bodyTimeout: 600000,
          dispatcher
        });

        // 成功状态
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return {
            statusCode: res.statusCode,
            headers: res.headers,
            bodyStream: res.body,
            accountUsed: account
          };
        }

        // 处理 429 限频 / 额度耗尽
        if (res.statusCode === 429) {
          const errBody = await res.body.text();
          console.warn(`[Executor] 账号 ${account.email} 触发 429 限频/额度枯竭 (第 ${attempt}/${maxRetries} 次尝试)，正在无感自动换号...:`, errBody.substring(0, 120));
          this.pool.releaseAccount(account.id, { code: 429, message: errBody });
          if (this.quotaManager) {
            this.quotaManager.fetchQuotaForAccount(account).catch(() => {});
          }
          // 自动进入下一轮循环，换取下一个可用账号
          continue;
        }

        // 处理 401 Token 失效
        if (res.statusCode === 401) {
          const errBody = await res.body.text();
          console.warn(`[Executor] Account ${account.email} hit 401 Unauthorized:`, errBody);
          // 尝试立即刷新 Token 一次
          const refreshOk = await this.refresher.refreshSingleAccount(account);
          if (refreshOk) {
            // 刷新成功，重试当前账号
            triedAccountIds.delete(account.id);
          } else {
            this.pool.releaseAccount(account.id, { code: 401, message: 'Token refresh failed' });
          }
          continue;
        }

        // 处理 403 封禁或无权限
        if (res.statusCode === 403) {
          const errBody = await res.body.text();
          console.error(`[Executor] Account ${account.email} hit 403 Forbidden:`, errBody);
          this.pool.releaseAccount(account.id, { code: 403, message: errBody });
          continue;
        }

        // 处理 503 容量不足智能降级转移
        if (res.statusCode === 503) {
          const errBody = await res.body.text();
          console.warn(`[Executor] Google Upstream 503:`, errBody);
          if (errBody.includes('MODEL_CAPACITY_EXHAUSTED') && payload.model?.includes('gpt-oss')) {
            console.warn(`[Executor] GPT-OSS capacity exhausted, automatically falling back to gemini-3.8-flash-high...`);
            payload.model = 'gemini-3.8-flash-high';
            triedAccountIds.delete(account.id);
            this.pool.releaseAccount(account.id);
            continue;
          }
          this.pool.releaseAccount(account.id, { code: 503, message: errBody });
          continue;
        }

        // 其他上游错误
        const errBody = await res.body.text();
        this.pool.releaseAccount(account.id, { code: res.statusCode, message: errBody });
        throw new Error(`Google Upstream returned HTTP ${res.statusCode}: ${errBody}`);

      } catch (err: any) {
        // 网络层异常
        console.error(`[Executor] Network or connection error for account ${account.email}:`, err.message);
        this.pool.releaseAccount(account.id, { code: 500, message: err.message });
        if (attempt === maxRetries) {
          throw err;
        }
      }
    }

    throw new Error(`Failed to fulfill request after ${maxRetries} attempts with rotating accounts.`);
  }
}
