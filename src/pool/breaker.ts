import { request } from 'undici';
import { Account, AppConfig, GoogleCloudCodePayload } from '../types.js';
import { AccountPool } from './account-pool.js';
import { TokenRefresher } from './refresher.js';
import { QuotaManager } from './quota-manager.js';
import { getOrCreateDispatcher, resetDispatcher } from './dispatcher.js';

export interface UpstreamExecutionResult {
  statusCode: number;
  headers: Record<string, any>;
  bodyStream: any;
  accountUsed: Account;
}

export interface UpstreamTokenCountResult {
  totalTokens: number;
  accountUsed: Account;
}

/** An upstream response that must be returned to the client, never retried on another account. */
export class UpstreamRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly upstreamBody: string
  ) {
    super(`Google Upstream returned HTTP ${statusCode}: ${upstreamBody}`);
    this.name = 'UpstreamRequestError';
  }
}

export class ContextOverflowError extends UpstreamRequestError {
  constructor(statusCode: number, upstreamBody: string) {
    super(statusCode, upstreamBody);
    this.name = 'ContextOverflowError';
  }
}

export class LocationNotSupportedError extends UpstreamRequestError {
  constructor(statusCode: number, upstreamBody: string) {
    super(statusCode, upstreamBody);
    this.name = 'LocationNotSupportedError';
  }
}

function isContextOverflow(statusCode: number, body: string): boolean {
  return statusCode === 400 && (
    /input token count exceeds the maximum number of tokens/i.test(body) ||
    /maximum number of tokens allowed/i.test(body) ||
    /CONTEXT_LENGTH_EXCEEDED/i.test(body)
  );
}

function isLocationNotSupported(statusCode: number, body: string): boolean {
  return (statusCode === 400 || statusCode === 403) && (
    /User location is not supported/i.test(body) ||
    /location is not supported/i.test(body) ||
    (/FAILED_PRECONDITION/i.test(body) && /location/i.test(body))
  );
}

export class RequestExecutor {
  constructor(
    private pool: AccountPool,
    private refresher: TokenRefresher,
    private config: AppConfig,
    private quotaManager?: QuotaManager
  ) {}

  /** Uses Google's countTokens endpoint so Claude Code can run its own compaction logic. */
  public async countTokens(
    payload: GoogleCloudCodePayload,
    maxRetries = 3,
    sessionKey?: string
  ): Promise<UpstreamTokenCountResult> {
    const triedAccountIds = new Set<string>();
    const model = (payload.model || '').toLowerCase();
    const family: 'claude' | 'gemini' = (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('gpt') || model.includes('oss'))
      ? 'claude'
      : 'gemini';
    const countUrl = this.config.upstreamUrl
      .replace(/streamGenerateContent/i, 'countTokens')
      .replace(/[?&]alt=sse\b/i, '')
      .replace(/[?&]$/, '');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const account = this.pool.acquireAccount(triedAccountIds, family, sessionKey);
      if (!account) throw new Error(`No available ${family} account for token counting.`);
      triedAccountIds.add(account.id);

      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        const ok = await this.refresher.refreshSingleAccount(account);
        if (!ok) {
          this.pool.releaseAccount(account.id, { code: 401, message: 'Token refresh failed during countTokens' }, family);
          continue;
        }
      }

      try {
        const effectiveProxy = account.proxyUrl || this.config.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const dispatcher = getOrCreateDispatcher(effectiveProxy, { timeoutMs: 60000 });
        // countTokens accepts the inner request envelope only. Sending the
        // full generation payload first doubles the upload for large prompts
        // and adds avoidable proxy/TLS failure points.
        const res = await request(countUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/2.14.0',
            'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
          },
          body: JSON.stringify({ request: payload.request }),
          headersTimeout: 120000,
          bodyTimeout: 120000,
          dispatcher
        });
        const body = await res.body.text();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const parsed = JSON.parse(body);
          const totalTokens = Number(
            parsed.totalTokens ?? parsed.total_tokens ?? parsed.promptTokenCount ?? parsed.usageMetadata?.promptTokenCount
          );
          if (Number.isFinite(totalTokens)) {
            this.pool.releaseAccount(account.id);
            return { totalTokens, accountUsed: account };
          }
          this.pool.releaseAccount(account.id);
          throw new Error(`countTokens response did not include totalTokens: ${body.slice(0, 300)}`);
        }

        if (isLocationNotSupported(res.statusCode, body)) {
          this.pool.releaseAccount(account.id);
          resetDispatcher(effectiveProxy, { timeoutMs: 60000 });
          if (attempt < maxRetries) {
            triedAccountIds.delete(account.id);
            console.warn(`[Executor] countTokens 地区限制，正在重建代理连接并重试 (${attempt + 1}/${maxRetries})。`);
            await new Promise(r => setTimeout(r, attempt * 1000));
            continue;
          }
          throw new LocationNotSupportedError(res.statusCode, body);
        }

        this.pool.releaseAccount(account.id);
        throw new UpstreamRequestError(res.statusCode, body);
      } catch (err: any) {
        if (err instanceof UpstreamRequestError) throw err;
        const retryProxy = account.proxyUrl || this.config.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        resetDispatcher(retryProxy, { timeoutMs: 60000 });
        this.pool.releaseAccount(account.id, { code: 500, message: `countTokens network error: ${err.message}` }, family);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
        if (attempt === maxRetries) throw err;
      }
    }
    throw new Error('Failed to count tokens after retries.');
  }

  /**
   * 携带重试与熔断的执行器 (支持模型族群额度感知与智能无感换号)
   */
  public async executeWithRetry(
    payload: GoogleCloudCodePayload,
    maxRetries = 3,
    sessionKey?: string,
    signal?: AbortSignal
  ): Promise<UpstreamExecutionResult> {
    const triedAccountIds = new Set<string>();
    const model = (payload.model || '').toLowerCase();
    const family: 'claude' | 'gemini' = (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('gpt') || model.includes('oss'))
      ? 'claude'
      : 'gemini';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const account = this.pool.acquireAccount(triedAccountIds, family, sessionKey);

      if (!account) {
        if (family === 'claude') {
          let nearestDiff = Infinity;
          for (const acc of this.pool.getAllAccounts()) {
            if (acc.quota?.claudeResetTime) {
              const diff = new Date(acc.quota.claudeResetTime).getTime() - Date.now();
              if (diff > 0 && diff < nearestDiff) {
                nearestDiff = diff;
              }
            }
          }
          const timeHint = nearestDiff !== Infinity
            ? ` (最近回满倒计时: ${Math.floor(nearestDiff / 3600000)}小时${Math.floor((nearestDiff % 3600000) / 60000)}分)`
            : '';
          throw new Error(`当前账号池所有账号的 Claude/GPT 5小时额度均已耗尽${timeHint}。Gemini 额度依然充足可用，建议在客户端切换为 gemini-3.8-flash 等模型，或等待额度自动回满。`);
        } else if (family === 'gemini') {
          let nearestDiff = Infinity;
          for (const acc of this.pool.getAllAccounts()) {
            if (acc.quota?.geminiResetTime) {
              const diff = new Date(acc.quota.geminiResetTime).getTime() - Date.now();
              if (diff > 0 && diff < nearestDiff) {
                nearestDiff = diff;
              }
            }
          }
          const timeHint = nearestDiff !== Infinity
            ? ` (最近回满倒计时: ${Math.floor(nearestDiff / 3600000)}小时${Math.floor((nearestDiff % 3600000) / 60000)}分)`
            : '';
          throw new Error(`当前账号池所有账号的 Gemini 5小时额度均已耗尽${timeHint}。Claude / GPT 额度依然充足可用，建议在客户端切换为 claude-3-7-sonnet 等模型，或等待额度自动回满。`);
        }
        throw new Error('All accounts in the pool are busy, in cooldown, or exhausted.');
      }

      triedAccountIds.add(account.id);

      // 检查 Token 是否需要刷新
      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        const ok = await this.refresher.refreshSingleAccount(account);
        if (!ok) {
          this.pool.releaseAccount(account.id, { code: 401, message: 'Initial token refresh failed' }, family);
          continue; // 换下一个号重试
        }
      }

      try {
        const effectiveProxy = account.proxyUrl || this.config.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const dispatcher = getOrCreateDispatcher(effectiveProxy, { timeoutMs: 60000 });
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
          dispatcher,
          signal
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
          this.pool.releaseAccount(account.id, { code: 429, message: errBody }, family);
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
          if (isLocationNotSupported(res.statusCode, errBody)) {
            this.pool.releaseAccount(account.id);
            resetDispatcher(effectiveProxy, { timeoutMs: 60000 });
            if (attempt < maxRetries) {
              triedAccountIds.delete(account.id);
              console.warn(`[Executor] 生成请求地区限制，正在重建代理连接并重试 (${attempt + 1}/${maxRetries})。`);
              await new Promise(r => setTimeout(r, attempt * 1000));
              continue;
            }
            throw new LocationNotSupportedError(res.statusCode, errBody);
          }
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

        // 400 是请求本身不合法或环境限制，换账号无意义；尤其不能把上下文超限误报成网络故障。
        const errBody = await res.body.text();
        this.pool.releaseAccount(account.id);
        if (isContextOverflow(res.statusCode, errBody)) {
          throw new ContextOverflowError(res.statusCode, errBody);
        }
        if (isLocationNotSupported(res.statusCode, errBody)) {
          resetDispatcher(effectiveProxy, { timeoutMs: 60000 });
          if (attempt < maxRetries) {
            triedAccountIds.delete(account.id);
            console.warn(`[Executor] ⚠️ 触发 Google 链路地区抖动 (HTTP 400)，正在极速刷新代理隧道重试 (${attempt + 1}/${maxRetries})...`);
            continue;
          }
          console.error(`[Executor] 🚨 账号 ${account.email} 遭遇 Google 地区限制: User location is not supported for the API use.`);
          console.error(`[Executor] 💡 原因定位：当前代理出口节点或其所属数据中心机房段 (ASN) 被 Google API 判定为不受支持地区。`);
          console.error(`[Executor] 💡 诊断建议：请在代理软件（如 Clash）中更换其他美国(US)、日本(JP)或新加坡(SG)节点，避免使用同一条不稳定的出口链路。`);
          if (effectiveProxy) {
            const probeDisp = getOrCreateDispatcher(effectiveProxy, { timeoutMs: 5000 });
            request('https://ipinfo.io/json', { dispatcher: probeDisp, headersTimeout: 5000, bodyTimeout: 5000 })
              .then(async r => {
                if (r.statusCode === 200) {
                  const info = (await r.body.json()) as any;
                  console.error(`[Executor] 🔍 出口 IP 探测：当前代理出口为 ${info.ip} (${info.country} - ${info.city || ''}, ${info.org || ''})`);
                }
              })
              .catch(() => {});
          }
          throw new LocationNotSupportedError(res.statusCode, errBody);
        }
        throw new UpstreamRequestError(res.statusCode, errBody);

      } catch (err: any) {
        // 协议错误已完成账号释放，不允许被 catch 当成网络异常后再换号。
        if (err instanceof UpstreamRequestError) {
          throw err;
        }
        // 网络层异常（如 Connect Timeout、Socket 掉线等），自动换号继续尝试，不立即中断
        console.error(`[Executor] Network or connection error for account ${account.email} (attempt ${attempt}/${maxRetries}):`, err.message);
        const retryProxy = account.proxyUrl || this.config.defaultProxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        resetDispatcher(retryProxy, { timeoutMs: 60000 });
        this.pool.releaseAccount(account.id, { code: 500, message: `Network error: ${err.message}` });
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
        if (attempt === maxRetries) {
          throw err;
        }
      }
    }

    throw new Error(`Failed to fulfill request after ${maxRetries} attempts with rotating accounts.`);
  }
}
