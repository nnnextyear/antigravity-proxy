import { request } from 'undici';
import type { Dispatcher } from 'undici';
import { Account, AppConfig, GoogleCloudCodePayload } from '../types.js';
import { AccountPool } from './account-pool.js';
import { TokenRefresher } from './refresher.js';
import { QuotaManager } from './quota-manager.js';
import { getOrCreateDispatcher, resetDispatcher } from './dispatcher.js';
import { isLocationError, isPolicyBlockedError, retryAfterMs } from './error-policy.js';
import { jittered, TransportAttempt, waitForRetry } from './transport.js';
import { attachUpstreamSessionId } from '../gateway/session.js';
import type { LiveModelCatalog } from '../gateway/models.js';
import { requestUpstream } from './h2-transport.js';

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

export interface AvailableModelsResult extends LiveModelCatalog {
  /** The account used for a live fetch. Cached responses do not have a lease. */
  accountUsed?: Account;
}

/** An upstream response that must be returned to the client, never retried on another account. */
export class UpstreamRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly upstreamBody: string,
    public readonly upstreamHeaders?: Record<string, any>
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

/** Return the upstream Retry-After value for a gateway response, if present. */
export function getRetryAfterHeader(error: unknown): string | undefined {
  if (!(error instanceof UpstreamRequestError)) return undefined;
  const value = error.upstreamHeaders?.['retry-after'] ?? error.upstreamHeaders?.['Retry-After'];
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function isContextOverflow(statusCode: number, body: string): boolean {
  return statusCode === 400 && (
    /input token count exceeds the maximum number of tokens/i.test(body) ||
    /maximum number of tokens allowed/i.test(body) ||
    /CONTEXT_LENGTH_EXCEEDED/i.test(body)
  );
}

function isLocationNotSupported(statusCode: number, body: string): boolean {
  return isLocationError(statusCode, body);
}

function headersWithRetryAfter(headers: Record<string, any>, delayMs: number): Record<string, any> {
  if (headers['retry-after'] !== undefined || headers['Retry-After'] !== undefined) return headers;
  return { ...headers, 'retry-after': String(Math.ceil(delayMs / 1000)) };
}

/**
 * A 403 covers very different upstream decisions. Only a policy termination is
 * permanent; quota/permission 403s must stay recoverable, and none of them may
 * trigger account rotation inside one client request.
 */
function classifyForbidden(statusCode: number, body: string): 'location' | 'policy' | 'quota' | 'other' {
  if (isLocationNotSupported(statusCode, body)) return 'location';
  if (isPolicyBlockedError(statusCode, body)) return 'policy';
  if (/resource_exhausted|rate.?limit|quota|too many requests/i.test(body)) return 'quota';
  return 'other';
}

/**
 * Reading an error body can itself fail (the socket may already be gone). The
 * status code is what drives account state, so never lose it to a body read.
 */
async function readErrorBody(res: any): Promise<string> {
  try {
    return await res.body.text();
  } catch {
    return '';
  }
}

export class RequestExecutor {
  private modelCatalogCache: { catalog: LiveModelCatalog; expiresAt: number; upstreamUrl: string } | null = null;
  private modelCatalogInFlight: Promise<AvailableModelsResult> | null = null;
  private readonly modelCatalogTtlMs = 45 * 1000;
  /** Proxy connect/TLS handshake budget. Never bounds an established stream. */
  private readonly connectTimeoutMs = 60000;
  /** Response header / inter-chunk budget. Long thinking may stay silent for minutes. */
  private readonly upstreamTimeoutMs: number;
  private readonly countTimeoutMs = 120000;
  /** Minimum spacing between two generation starts on the same account. */
  private readonly minStartIntervalMs: number;
  private readonly lastGenerationStartAt = new Map<string, number>();

  constructor(
    private pool: AccountPool,
    private refresher: TokenRefresher,
    private config: AppConfig,
    private quotaManager?: QuotaManager
  ) {
    this.upstreamTimeoutMs = Math.max(60000, Number(config.upstreamTimeoutMs) || 900000);
    this.minStartIntervalMs = Math.max(0, Number(config.minRequestIntervalMs ?? 1000));
  }

  /**
   * A failed token refresh must not silently pin a conversation to an account
   * that cannot authenticate: the binding guard would make every later attempt
   * return null and the request would die with a misleading "quota exhausted"
   * error while other accounts sit idle. The first failure retries the same
   * account (usually a network blip); the second drops the affinity binding so
   * the pool may serve the conversation elsewhere.
   *
   * @returns true when the session binding was dropped.
   */
  private noteRefreshFailure(failures: Map<string, number>, accountId: string, sessionKey?: string): boolean {
    const count = (failures.get(accountId) ?? 0) + 1;
    failures.set(accountId, count);
    if (count >= 2 && sessionKey) {
      this.pool.clearSessionBinding(sessionKey, accountId);
      console.warn('[Executor] 账号连续两次续期失败，已解除会话绑定，本次请求改由其他账号服务。');
      return true;
    }
    return false;
  }

  /**
   * Space generation starts on one account. Filling every concurrency slot in
   * the same tick is exactly the burst pattern upstream rate limiters look
   * for; a small minimum interval spreads the starts without costing real
   * throughput (a generation takes far longer than the interval).
   */
  private async paceAccount(account: Account, signal?: AbortSignal): Promise<void> {
    if (this.minStartIntervalMs <= 0) return;
    const last = this.lastGenerationStartAt.get(account.id) ?? 0;
    const wait = last + this.minStartIntervalMs - Date.now();
    if (wait > 0) await waitForRetry(jittered(wait), signal);
    this.lastGenerationStartAt.set(account.id, Date.now());
  }

  /**
   * Acquire a lease while preserving an established conversation binding.
   * A full bound account is a queueing condition, not a reason to migrate the
   * conversation. Permanent failures clear the binding before this is called.
   */
  private async acquireRequestAccount(
    excludeIds: Set<string>,
    requiredFamily: 'claude' | 'gemini',
    sessionKey: string | undefined,
    signal?: AbortSignal,
    /** Preflight callers must not queue: the generation phase queues anyway. */
    waitForBoundAccount = true
  ): Promise<Account | null> {
    const maxWaitMs = 120000;
    // Jittered: every waiter bound to one account must not wake up in the same
    // tick and fire together the moment a slot frees.
    const pollMs = 100 + Math.floor(Math.random() * 120);
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      if (signal?.aborted) throw new Error('Request aborted by client.');
      const account = this.pool.acquireAccount(excludeIds, requiredFamily, sessionKey);
      if (account) return account;

      const binding = sessionKey ? this.pool.getSessionBinding(sessionKey) : undefined;
      const bound = binding ? this.pool.getAccount(binding.accountId) : undefined;
      const boundIsBusy = Boolean(
        bound && bound.status === 'active' && !excludeIds.has(bound.id) && bound.activeConcurrency >= bound.maxConcurrency
      );
      if (!boundIsBusy) return null;
      if (!waitForBoundAccount) return null;
      if (Date.now() >= deadline) {
        throw new Error(`会话绑定账号 ${bound!.email} 当前并发已满，等待 120 秒后仍未释放；本次请求未切换账号。`);
      }
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('Request aborted by client.'));
        };
        timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, pollMs);
        if (!signal) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /** Fetch the live model catalog from Antigravity. There is deliberately no
   * static fallback: an unavailable control-plane endpoint must be visible to
   * CC Switch instead of advertising models that the account cannot use.
   *
   * The catalog changes much less often than individual generations. Keep a
   * short cache and coalesce concurrent refreshes so model discovery from
   * several clients cannot create a control-plane request burst. A caller can
   * explicitly bypass the cache (for example, an authenticated admin refresh).
   */
  public async fetchAvailableModels(
    maxRetries = 3,
    options: { forceRefresh?: boolean } = {},
    signal?: AbortSignal
  ): Promise<AvailableModelsResult> {
    const now = Date.now();
    if (!options.forceRefresh && this.modelCatalogCache
      && this.modelCatalogCache.upstreamUrl === this.config.upstreamUrl
      && this.modelCatalogCache.expiresAt > now) {
      return { ...this.modelCatalogCache.catalog };
    }

    // A forced refresh also joins an already-running refresh. This prevents
    // several explicit refreshes arriving together from bypassing the guard.
    if (this.modelCatalogInFlight) return this.modelCatalogInFlight;

    const refresh = this.fetchAvailableModelsFromUpstream(maxRetries, signal);
    this.modelCatalogInFlight = refresh;
    try {
      const result = await refresh;
      const catalog: LiveModelCatalog = {
        models: result.models,
        agentModelSorts: result.agentModelSorts
      };
      this.modelCatalogCache = {
        catalog,
        expiresAt: Date.now() + this.modelCatalogTtlMs,
        upstreamUrl: this.config.upstreamUrl
      };
      return result;
    } finally {
      if (this.modelCatalogInFlight === refresh) this.modelCatalogInFlight = null;
    }
  }

  private async fetchAvailableModelsFromUpstream(maxRetries: number, signal?: AbortSignal): Promise<AvailableModelsResult> {
    const triedAccountIds = new Set<string>();
    const modelsUrl = (() => {
      try {
        const url = new URL(this.config.upstreamUrl);
        url.pathname = url.pathname.replace(/:[^/]+$/, ':fetchAvailableModels');
        url.search = '';
        return url.toString();
      } catch {
        return 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
      }
    })();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Request aborted by client.');
      const account = this.pool.acquireAccount(triedAccountIds);
      if (!account) throw new Error('No available account for fetching the Antigravity model list.');
      triedAccountIds.add(account.id);

      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        let refreshed = false;
        try {
          refreshed = await this.refresher.refreshSingleAccount(account, signal);
        } catch (err) {
          this.pool.releaseAccount(account.id);
          throw err;
        }
        if (!refreshed) {
          // TokenRefresher already persists terminal invalid_grant failures.
          // A network-only refresh failure must not turn a healthy account dead.
          this.pool.releaseAccount(account.id);
          continue;
        }
      }

      // An empty configured proxy means direct system networking (for example
      // Clash TUN). Do not silently reintroduce an ambient shell proxy here.
      const effectiveProxy = account.proxyUrl || this.config.defaultProxyUrl;
      try {
        const dispatcher = effectiveProxy ? getOrCreateDispatcher(effectiveProxy, { timeoutMs: 30000 }) : undefined;
        const res = await request(modelsUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/2.14.0',
            'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
          },
          body: '{}',
          headersTimeout: 30000,
          bodyTimeout: 30000,
          dispatcher,
          signal
        });
        const body = await res.body.text();

        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed: any;
          try {
            parsed = JSON.parse(body);
          } catch {
            this.pool.releaseAccount(account.id);
            throw new UpstreamRequestError(502, 'Antigravity returned invalid model list JSON.');
          }
          if (!parsed || !parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) {
            this.pool.releaseAccount(account.id);
            throw new UpstreamRequestError(502, 'Antigravity returned no model list.');
          }
          this.pool.releaseAccount(account.id);
          return { models: parsed.models, agentModelSorts: parsed.agentModelSorts, accountUsed: account };
        }

        if (res.statusCode === 401) {
          this.pool.releaseAccount(account.id);
          if (await this.refresher.refreshSingleAccount(account)) {
            triedAccountIds.delete(account.id);
          }
          continue;
        }

        if (res.statusCode === 429) {
          const retryDelay = retryAfterMs(res.headers as Record<string, unknown>, body, this.config.cooldownSeconds * 1000);
          this.pool.releaseAccount(account.id, {
            code: res.statusCode,
            message: body,
            retryAfterMs: retryDelay
          });
          throw new UpstreamRequestError(
            res.statusCode,
            body,
            headersWithRetryAfter(res.headers as Record<string, any>, retryDelay)
          );
        }
        // The catalog call must classify 403 the same way generation does,
        // otherwise a transient permission 403 permanently kills an account.
        if (res.statusCode === 403) {
          const forbiddenKind = classifyForbidden(res.statusCode, body);
          if (forbiddenKind === 'location') {
            // An exit-IP problem, not an account problem.
            this.pool.releaseAccount(account.id);
            throw new LocationNotSupportedError(res.statusCode, body);
          }
          if (forbiddenKind === 'policy') {
            this.pool.releaseAccount(account.id, { code: 403, message: body.substring(0, 500) });
            throw new UpstreamRequestError(res.statusCode, body, res.headers as Record<string, any>);
          }
          const forbiddenCooldown = Math.max(
            retryAfterMs(res.headers as Record<string, unknown>, body, this.config.cooldownSeconds * 1000),
            5 * 60 * 1000
          );
          console.warn(`[Executor] 模型目录请求遇到可恢复 403 (${forbiddenKind})，账号冷却 ${Math.ceil(forbiddenCooldown / 1000)}s。`);
          this.pool.releaseAccount(account.id, { code: 403, message: body.substring(0, 500), retryAfterMs: forbiddenCooldown, recoverable: true });
          throw new UpstreamRequestError(
            res.statusCode,
            body,
            headersWithRetryAfter(res.headers as Record<string, any>, forbiddenCooldown)
          );
        }
        this.pool.releaseAccount(account.id, { code: res.statusCode, message: body.substring(0, 500) });
        if (res.statusCode >= 500) {
          triedAccountIds.delete(account.id);
          if (attempt < maxRetries) await waitForRetry(jittered(Math.min(500 * attempt, 1500)), signal);
          continue;
        }
        throw new UpstreamRequestError(res.statusCode, body, res.headers as Record<string, any>);
      } catch (err: any) {
        if (err instanceof UpstreamRequestError) throw err;
        this.pool.releaseAccount(account.id);
        if (signal?.aborted) throw err;
        triedAccountIds.delete(account.id);
        if (attempt < maxRetries) await waitForRetry(jittered(Math.min(500 * attempt, 1500)), signal);
        if (attempt === maxRetries) throw err;
      }
    }
    throw new Error('Failed to fetch the Antigravity model list after retries.');
  }

  /** Uses Google's countTokens endpoint so Claude Code can run its own compaction logic. */
  public async countTokens(
    payload: GoogleCloudCodePayload,
    maxRetries = 3,
    sessionKey?: string,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<UpstreamTokenCountResult> {
    const triedAccountIds = new Set<string>();
    /** An account may only be re-tried once after its token was refreshed. */
    const refreshedAccounts = new Set<string>();
    const model = (payload.model || '').toLowerCase();
    const family: 'claude' | 'gemini' = (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('gpt') || model.includes('oss'))
      ? 'claude'
      : 'gemini';
    const countUrl = this.config.upstreamUrl
      .replace(/streamGenerateContent/i, 'countTokens')
      .replace(/[?&]alt=sse\b/i, '')
      .replace(/[?&]$/, '');
    const { sessionId: _sessionId, ...countRequest } = payload.request;
    const serializedCountPayload = JSON.stringify({ request: countRequest });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Token counting is an auxiliary control-plane call. It may establish
      // the request's local account lease, but it must not replace that lease
      // with another account before generation starts, and it must not queue
      // for a busy bound account: generation queues once, not twice.
      const account = await this.acquireRequestAccount(triedAccountIds, family, sessionKey, signal, false);
      if (!account) throw new Error(`No available ${family} account for token counting.`);
      triedAccountIds.add(account.id);

      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        let ok = false;
        try {
          ok = await this.refresher.refreshSingleAccount(account, signal);
        } catch (err) {
          this.pool.releaseAccount(account.id);
          throw err;
        }
        if (!ok) {
          if (account.status === 'dead') {
            this.pool.releaseAccount(account.id, { code: 401, message: 'Token refresh failed during countTokens' }, family, sessionKey);
          } else {
            this.pool.releaseAccount(account.id);
          }
          throw new UpstreamRequestError(401, 'Token refresh failed during countTokens; account requires re-authentication.');
        }
      }

      // An empty configured proxy means direct system networking (for example
      // Clash TUN). Do not silently reintroduce an ambient shell proxy here.
      const effectiveProxy = account.proxyUrl || this.config.defaultProxyUrl;
      // Same rule as generation: never build the pool outside the try that
      // owns this account's lease.
      let dispatcher: Dispatcher | undefined;
      let transport: TransportAttempt | undefined;
      let poolRetired = false;
      const retirePool = () => {
        if (poolRetired || !dispatcher) return;
        poolRetired = true;
        resetDispatcher(effectiveProxy, { timeoutMs: this.connectTimeoutMs }, dispatcher);
      };
      try {
        dispatcher = effectiveProxy ? getOrCreateDispatcher(effectiveProxy, { timeoutMs: this.connectTimeoutMs }) : undefined;
        transport = new TransportAttempt(dispatcher, requestId);
        // countTokens accepts the inner request envelope only. Sending the
        // full generation payload first doubles the upload for large prompts
        // and adds avoidable proxy/TLS failure points.
        // Google countTokens does not need the generation session ID; keep the
        // upstream affinity token exclusive to the actual generation call.
        const res = await transport.run(() => requestUpstream(countUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/2.14.0',
            'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
          },
          body: serializedCountPayload,
          headersTimeout: this.countTimeoutMs,
          bodyTimeout: this.countTimeoutMs,
          connectTimeout: this.connectTimeoutMs,
          dispatcher,
          signal
        }, effectiveProxy));
        const body = await readErrorBody(res);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const parsed = JSON.parse(body);
          const totalTokens = Number(
            parsed.totalTokens ?? parsed.total_tokens ?? parsed.promptTokenCount ?? parsed.usageMetadata?.promptTokenCount
          );
          if (Number.isFinite(totalTokens)) {
            this.pool.releaseAccount(account.id);
            return { totalTokens, accountUsed: account };
          }
          // Let the surrounding transport-error path release this lease once.
          // Releasing here and then again in catch would steal concurrency
          // from another request sharing the same account.
          throw new Error(`countTokens response did not include totalTokens: ${body.slice(0, 300)}`);
        }

        if (isLocationNotSupported(res.statusCode, body)) {
          this.pool.releaseAccount(account.id);
          this.pool.clearSessionBinding(sessionKey, account.id);
          retirePool();
          console.warn('[Executor] countTokens 地区限制；本次请求停止，不在同一出口重复探测。');
          throw new LocationNotSupportedError(res.statusCode, body);
        }

        // A control-plane 401 is not proof that the account is gone: refresh
        // once, exactly like the generation path does.
        if (res.statusCode === 401) {
          if (refreshedAccounts.has(account.id)) {
            // The freshly minted token was rejected again. Mirror the
            // generation path: park the account instead of killing a healthy
            // account whose refresh token still works.
            console.error(`[Executor] countTokens rejected a freshly refreshed token for ${account.email}; parking it.`);
            this.pool.releaseAccount(account.id, {
              code: 401,
              message: body || 'Repeated 401 after token refresh',
              recoverable: true
            }, family, sessionKey);
            throw new UpstreamRequestError(503, `Upstream rejected a freshly refreshed account token during token counting: ${body.substring(0, 300)}`);
          }
          console.warn(`[Executor] countTokens 401 for ${account.email}; refreshing the token once before isolating it.`);
          const refreshOk = await this.refresher.refreshSingleAccount(account);
          if (refreshOk) {
            this.pool.releaseAccount(account.id);
            refreshedAccounts.add(account.id);
            triedAccountIds.delete(account.id);
            continue;
          }
          if (account.status === 'dead') {
            this.pool.releaseAccount(account.id, { code: 401, message: 'Token refresh failed during countTokens' }, family, sessionKey);
          } else {
            this.pool.releaseAccount(account.id);
          }
          throw new UpstreamRequestError(503, `Upstream rejected a freshly refreshed account token during token counting: ${body.substring(0, 300)}`);
        }

        if (res.statusCode === 403) {
          const forbiddenKind = classifyForbidden(res.statusCode, body);
          if (forbiddenKind === 'policy') {
            this.pool.releaseAccount(account.id, { code: 403, message: body || 'HTTP 403' }, family, sessionKey);
            throw new UpstreamRequestError(res.statusCode, body, res.headers as Record<string, any>);
          }
          const forbiddenCooldown = Math.max(
            retryAfterMs(res.headers as Record<string, unknown>, body, this.config.cooldownSeconds * 1000),
            5 * 60 * 1000
          );
          console.warn(`[Executor] countTokens 403 (${forbiddenKind}) for ${account.email}; cooling down ${Math.ceil(forbiddenCooldown / 1000)}s.`);
          this.pool.releaseAccount(account.id, { code: 403, message: body || 'HTTP 403', retryAfterMs: forbiddenCooldown, recoverable: true }, family, sessionKey);
          throw new UpstreamRequestError(
            res.statusCode,
            body,
            headersWithRetryAfter(res.headers as Record<string, any>, forbiddenCooldown)
          );
        }

        const retryDelay = res.statusCode === 429
          ? retryAfterMs(res.headers as Record<string, unknown>, body, this.config.cooldownSeconds * 1000)
          : undefined;
        this.pool.releaseAccount(account.id, {
          code: res.statusCode,
          message: body,
          ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay })
        }, family, sessionKey);
        throw new UpstreamRequestError(
          res.statusCode,
          body,
          retryDelay === undefined
            ? res.headers as Record<string, any>
            : headersWithRetryAfter(res.headers as Record<string, any>, retryDelay)
        );
      } catch (err: any) {
        if (err instanceof UpstreamRequestError) throw err;
        this.pool.releaseAccount(account.id);
        if (signal?.aborted) throw err;
        const errorCode = err?.code || err?.cause?.code || (err?.name && err.name !== 'Error' ? err.name : 'unknown');
        const errorKind = errorCode === 'unknown' ? 'processing error' : 'network error';
        console.warn(`[Executor] countTokens ${errorKind} for account ${account.email} (attempt ${attempt}/${maxRetries}, code=${errorCode}, ${transport ? transport.describe() : 'dispatcher-unavailable'}, payload=${Buffer.byteLength(serializedCountPayload)} bytes):`, err.message);
        triedAccountIds.delete(account.id);
        if (attempt < maxRetries) {
          await waitForRetry(jittered(attempt * 1000), signal);
        }
        if (attempt === maxRetries) throw err;
      }
    }
    throw new Error('Failed to count tokens after retries.');
  }

  /**
   * 带有限重试与熔断的执行器（按模型族群避开已知额度耗尽账号）
   */
  public async executeWithRetry(
    payload: GoogleCloudCodePayload,
    maxRetries = 3,
    sessionKey?: string,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<UpstreamExecutionResult> {
    const triedAccountIds = new Set<string>();
    /** An account may only be re-tried once after its token was refreshed. */
    const refreshedAccounts = new Set<string>();
    /** Consecutive token-refresh failures per account inside this request. */
    const refreshFailures = new Map<string, number>();
    const model = (payload.model || '').toLowerCase();
    const family: 'claude' | 'gemini' = (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('gpt') || model.includes('oss'))
      ? 'claude'
      : 'gemini';
    // Session-bound payloads are serialized per attempt (the upstream session
    // id depends on the account); everything else is encoded once.
    const baseBody = sessionKey ? undefined : JSON.stringify(payload);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const account = await this.acquireRequestAccount(triedAccountIds, family, sessionKey, signal);

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

      // A cancellation during backoff must not release another request's lease.
      let released = false;
      const releaseAccount = (error?: Parameters<AccountPool['releaseAccount']>[1], leaseFamily?: 'claude' | 'gemini', leaseKey?: string) => {
        if (released) return;
        released = true;
        this.pool.releaseAccount(account.id, error, leaseFamily, leaseKey);
      };

      // 检查 Token 是否需要刷新
      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        let ok = false;
        try {
          ok = await this.refresher.refreshSingleAccount(account, signal);
        } catch (err) {
          // The refresh was cancelled with the client: release before leaving.
          releaseAccount();
          throw err;
        }
        if (!ok) {
          if (account.status === 'dead') {
            releaseAccount({ code: 401, message: 'Initial token refresh failed' }, family, sessionKey);
          } else {
            releaseAccount();
            // 首次失败只重试同一账号（多为网络抖动）；连续两次才解除会话绑定换号，
            // 否则绑定失效的账号会把整个请求卡死并误报“额度耗尽”。
            if (!this.noteRefreshFailure(refreshFailures, account.id, sessionKey)) {
              triedAccountIds.delete(account.id);
            }
          }
          continue;
        }
      }

      // Empty proxy configuration deliberately means direct system networking
      // (Clash/Mihomo TUN, VPN, or the host routing table). Never inherit an
      // ambient shell proxy implicitly, because that creates a second egress.
      const effectiveProxy = account.proxyUrl || this.config.defaultProxyUrl;
      // Build the pool INSIDE the try: a malformed proxy URL throws
      // synchronously and would otherwise leak this account's lease forever.
      let dispatcher: Dispatcher | undefined;
      let transport: TransportAttempt | undefined;
      let attemptBody = baseBody ?? '';
      let poolRetired = false;
      const retirePool = () => {
        if (poolRetired || !dispatcher) return;
        poolRetired = true;
        resetDispatcher(effectiveProxy, { timeoutMs: this.connectTimeoutMs }, dispatcher);
      };
      try {
        await this.paceAccount(account, signal);
        dispatcher = effectiveProxy ? getOrCreateDispatcher(effectiveProxy, { timeoutMs: this.connectTimeoutMs }) : undefined;
        transport = new TransportAttempt(dispatcher, requestId);
        // A conversation that migrates accounts must not present the same
        // upstream session token under a different account identity. The id is
        // part of the serialized body, so re-encode when it changed.
        if (sessionKey) {
          attachUpstreamSessionId(payload, `${sessionKey}\0${account.id}`, true);
          attemptBody = JSON.stringify(payload);
        }
        const upstreamHeaders: Record<string, string> = {
          'Authorization': `Bearer ${account.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/2.14.0',
          'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
        };

        const res = await transport.run(() => requestUpstream(this.config.upstreamUrl, {
          method: 'POST',
          headers: upstreamHeaders,
          body: attemptBody,
          headersTimeout: this.upstreamTimeoutMs,
          bodyTimeout: this.upstreamTimeoutMs,
          connectTimeout: this.connectTimeoutMs,
          dispatcher,
          signal
        }, effectiveProxy));

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
          const errBody = await readErrorBody(res);
          const retryDelay = retryAfterMs(res.headers as Record<string, unknown>, errBody, this.config.cooldownSeconds * 1000);
          console.warn(`[Executor] 账号 ${account.email} 触发 429 限频/额度枯竭 (第 ${attempt}/${maxRetries} 次尝试)，已记录 ${Math.ceil(retryDelay / 1000)} 秒冷却并停止复用该账号:`, errBody.substring(0, 120));
          releaseAccount({ code: 429, message: errBody || 'HTTP 429', retryAfterMs: retryDelay }, family, sessionKey);
          // Respect the upstream rate/quota decision for this request. Do not
          // turn one 429 into a burst of retries across other accounts.
          throw new UpstreamRequestError(
            res.statusCode,
            errBody,
            headersWithRetryAfter(res.headers as Record<string, any>, retryDelay)
          );
        }

        // 处理 401 Token 失效
        if (res.statusCode === 401) {
          const errBody = await readErrorBody(res);
          if (!refreshedAccounts.has(account.id) && signal?.aborted) {
            releaseAccount();
            throw new Error('Request aborted by client.');
          }
          if (refreshedAccounts.has(account.id)) {
            // A freshly minted token was rejected again: treat it as an account
            // level problem, but park the account rather than killing it —
            // a single rejection can just be auth replication lag.
            console.error(`[Executor] Account ${account.email} rejected a freshly refreshed token; parking it.`, errBody.substring(0, 200));
            releaseAccount({ code: 401, message: errBody || 'Repeated 401 after token refresh', recoverable: true }, family, sessionKey);
            // The client's own key is fine; this is an upstream account problem.
            // A 401 would make clients treat their own credentials as invalid.
            throw new UpstreamRequestError(503, `Upstream rejected a freshly refreshed account token: ${errBody.substring(0, 300)}`);
          }
          console.warn(`[Executor] Account ${account.email} hit 401 Unauthorized:`, errBody);
          // 尝试立即刷新 Token 一次
          let refreshOk = false;
          try {
            refreshOk = await this.refresher.refreshSingleAccount(account, signal);
          } catch (err) {
            releaseAccount();
            throw err;
          }
          if (refreshOk) {
            // 刷新成功，重试当前账号（每个账号每次请求只允许一次）
            refreshedAccounts.add(account.id);
            releaseAccount();
            triedAccountIds.delete(account.id);
          } else {
            if (account.status === 'dead') {
              releaseAccount({ code: 401, message: 'Token refresh failed' }, family, sessionKey);
            } else {
              releaseAccount();
              if (!this.noteRefreshFailure(refreshFailures, account.id, sessionKey)) {
                triedAccountIds.delete(account.id);
              }
            }
          }
          continue;
        }

        // 处理 403 封禁或无权限
        if (res.statusCode === 403) {
          const errBody = await readErrorBody(res);
          const forbiddenKind = classifyForbidden(res.statusCode, errBody);
          if (forbiddenKind === 'location') {
            releaseAccount();
            this.pool.clearSessionBinding(sessionKey, account.id);
            retirePool();
            console.warn('[Executor] 生成请求地区限制；本次请求停止，不在同一出口重复探测。');
            throw new LocationNotSupportedError(res.statusCode, errBody);
          }
          if (forbiddenKind === 'policy') {
            console.error(`[Executor] Account ${account.email} hit a terminal policy 403:`, errBody);
            releaseAccount({ code: 403, message: errBody || 'HTTP 403' }, family, sessionKey);
            // 403 策略终止不是普通容量错误。继续轮换账号会放大请求并掩盖
            // 真正原因；把原始上游正文直接返回给调用方。
            throw new UpstreamRequestError(res.statusCode, errBody, res.headers as Record<string, any>);
          }
          // A quota/permission 403 is recoverable. Park the account for a
          // while instead of killing it, and never rotate inside this request.
          // It is released as a *recoverable 403* (not as a 429): relabelling
          // would make the pool read the 403 body as a quota signal.
          const forbiddenCooldown = Math.max(
            retryAfterMs(res.headers as Record<string, unknown>, errBody, this.config.cooldownSeconds * 1000),
            5 * 60 * 1000
          );
          console.error(`[Executor] Account ${account.email} hit a recoverable 403 (${forbiddenKind}); cooling it down for ${Math.ceil(forbiddenCooldown / 1000)}s:`, errBody.substring(0, 200));
          releaseAccount({ code: 403, message: errBody || 'HTTP 403', retryAfterMs: forbiddenCooldown, recoverable: true }, family, sessionKey);
          throw new UpstreamRequestError(
            res.statusCode,
            errBody,
            headersWithRetryAfter(res.headers as Record<string, any>, forbiddenCooldown)
          );
        }

        // 处理 503 容量不足智能降级转移
        if (res.statusCode === 503) {
          const errBody = await readErrorBody(res);
          console.warn(`[Executor] Google Upstream 503:`, errBody);
          // Capacity is transient. Keep the conversation binding and retry
          // the same account after a short backoff instead of rotating it.
          releaseAccount();
          triedAccountIds.delete(account.id);
          if (attempt < maxRetries) {
            await waitForRetry(jittered(Math.min(1000 * attempt, 3000)), signal);
          }
          continue;
        }

        // 400 是请求本身不合法或环境限制，换账号无意义；尤其不能把上下文超限误报成网络故障。
        const errBody = await readErrorBody(res);
        releaseAccount();
        if (isContextOverflow(res.statusCode, errBody)) {
          throw new ContextOverflowError(res.statusCode, errBody);
        }
        if (isLocationNotSupported(res.statusCode, errBody)) {
          this.pool.clearSessionBinding(sessionKey, account.id);
          retirePool();
          console.error(`[Executor] 🚨 账号 ${account.email} 遭遇 Google 地区限制: User location is not supported for the API use. 本次请求已停止。`);
          console.error(`[Executor] 💡 原因定位：当前代理出口节点或其所属数据中心机房段 (ASN) 被 Google API 判定为不受支持地区。`);
          console.error(`[Executor] 💡 诊断建议：请在代理软件（如 Clash）中更换其他美国(US)、日本(JP)或新加坡(SG)节点，避免使用同一条不稳定的出口链路。`);
          throw new LocationNotSupportedError(res.statusCode, errBody);
        }
        throw new UpstreamRequestError(res.statusCode, errBody, res.headers as Record<string, any>);

      } catch (err: any) {
        // 协议错误已完成账号释放，不允许被 catch 当成网络异常后再换号。
        if (err instanceof UpstreamRequestError) {
          throw err;
        }
        if (signal?.aborted) {
          releaseAccount();
          throw err;
        }
        // 网络层异常只影响本次请求。保留会话绑定并有限重试同一账号，
        // 避免普通代理抖动把整个会话永久迁移到另一个账号。
        const errorCode = err?.code || err?.cause?.code || (err?.name && err.name !== 'Error' ? err.name : 'unknown');
        console.error(`[Executor] Network or connection error for account ${account.email} (attempt ${attempt}/${maxRetries}, code=${errorCode}, ${transport ? transport.describe() : 'dispatcher-unavailable'}, payload=${Buffer.byteLength(attemptBody)} bytes):`, err.message);
        releaseAccount();
        // A POST may have started generation even when no response arrived.
        // Replaying it can create several concurrent generations upstream.
        if (transport?.requestSent) {
          throw new UpstreamRequestError(502, `Upstream connection failed after the generation request was sent (${errorCode}); execution result is unknown. Automatic replay stopped.`);
        }
        triedAccountIds.delete(account.id);
        if (attempt < maxRetries) {
          await waitForRetry(jittered(attempt * 1000), signal);
        }
        if (attempt === maxRetries) {
          throw err;
        }
      }
    }

    throw new Error(`Failed to fulfill request after ${maxRetries} attempts with rotating accounts.`);
  }
}
