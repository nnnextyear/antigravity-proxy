import { request } from 'undici';
import type { Dispatcher } from 'undici';
import { Account, AppConfig, GoogleCloudCodePayload } from '../types.js';
import { AccountPool } from './account-pool.js';
import { TokenRefresher } from './refresher.js';
import { QuotaManager } from './quota-manager.js';
import { getOrCreateDispatcher, resetDispatcher } from './dispatcher.js';
import { classifyUpstreamError, contextOverflowMessage, isContextOverflow, isLocationError, isPolicyBlockedError, retryAfterMs } from './error-policy.js';
import { jittered, TransportAttempt, waitForRetry } from './transport.js';
import { attachUpstreamSessionId } from '../gateway/session.js';
import type { LiveModelCatalog } from '../gateway/models.js';
import { requestUpstream, requestUpstreamWithPing } from './upstream-transport.js';
import { AccountSchedulingError, accountUnavailableError, isAccountEligible } from './scheduling.js';

export interface UpstreamExecutionResult {
  statusCode: number;
  headers: Record<string, any>;
  bodyStream: any;
  accountUsed: Account;
  inputTokenCount?: number;
  release?: (error?: { code: number; message: string; retryAfterMs?: number; recoverable?: boolean }) => void;
}

interface BorrowedCountLease {
  account: Account;
  release: (error?: { code: number; message: string; retryAfterMs?: number; recoverable?: boolean }) => void;
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
  readonly code = 'context_length_exceeded';
  readonly clientMessage: string;
  constructor(statusCode: number, upstreamBody: string) {
    super(statusCode, upstreamBody);
    this.name = 'ContextOverflowError';
    this.clientMessage = contextOverflowMessage(upstreamBody);
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
  if (error instanceof AccountSchedulingError && error.retryAfterSeconds) return String(error.retryAfterSeconds);
  if (!(error instanceof UpstreamRequestError)) return undefined;
  const value = error.upstreamHeaders?.['retry-after'] ?? error.upstreamHeaders?.['Retry-After'];
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function isLocationNotSupported(statusCode: number, body: string): boolean {
  return isLocationError(statusCode, body);
}

function headersWithRetryAfter(headers: Record<string, any>, delayMs: number): Record<string, any> {
  return { ...headers, 'retry-after': String(Math.ceil(delayMs / 1000)) };
}

interface ExecutorIO {
  request: typeof requestUpstream;
  requestWithPing?: typeof requestUpstreamWithPing;
  wait: typeof waitForRetry;
  jitter: typeof jittered;
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

/** The Antigravity countTokens endpoint counts contents but ignores system instructions and tool schemas. */
function buildCountTokensPayload(request: GoogleCloudCodePayload['request']): { request: GoogleCloudCodePayload['request'] } {
  const { sessionId: _sessionId, systemInstruction, tools, toolConfig, ...countRequest } = request;
  const supplementalParts: Array<{ text: string }> = [];

  for (const part of systemInstruction?.parts ?? []) {
    if (typeof part.text === 'string' && part.text.length) supplementalParts.push({ text: part.text });
  }
  if (tools?.length || toolConfig) {
    supplementalParts.push({ text: JSON.stringify({ tools: tools ?? [], toolConfig: toolConfig ?? null }) });
  }

  if (supplementalParts.length) {
    countRequest.contents = [
      { role: 'user', parts: supplementalParts },
      ...countRequest.contents
    ];
  }

  return { request: countRequest };
}

function generationPayloadByteSizes(payload: GoogleCloudCodePayload, body: string) {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null');
  const callerSystemBytes = payload.request.contents.reduce((total, content) => total + content.parts.reduce((sum, part) => {
    const text = (part as any)?.text;
    return typeof text === 'string'
      && text.startsWith('<system-instructions>\n')
      && text.endsWith('\n</system-instructions>')
      ? sum + Buffer.byteLength(text)
      : sum;
  }, 0), 0);
  return {
    payload: Buffer.byteLength(body),
    contents: bytes(payload.request.contents),
    system: callerSystemBytes || bytes(payload.request.systemInstruction ?? null),
    tools: bytes({ tools: payload.request.tools ?? [], toolConfig: payload.request.toolConfig ?? null })
  };
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
  /** Minimum spacing across all accounts sharing the upstream project/egress. */
  private readonly globalMinStartIntervalMs: number;
  private readonly lastGenerationStartAt = new Map<string, number>();
  private lastGlobalGenerationStartAt = 0;
  private readonly pacingTails = new Map<string, Promise<void>>();
  private globalPacingTail: Promise<void> = Promise.resolve();

  constructor(
    private pool: AccountPool,
    private refresher: TokenRefresher,
    private config: AppConfig,
    private quotaManager?: QuotaManager,
    private readonly io: ExecutorIO = {
      request: requestUpstream,
      requestWithPing: requestUpstreamWithPing,
      wait: waitForRetry,
      jitter: jittered
    }
  ) {
    this.upstreamTimeoutMs = Math.max(60000, Number(config.upstreamTimeoutMs) || 900000);
    this.minStartIntervalMs = Math.max(0, Number(config.minRequestIntervalMs ?? 1000));
    this.globalMinStartIntervalMs = Math.max(0, Number(config.globalMinRequestIntervalMs ?? 1000));
  }

  /**
   * Serialize start reservations so simultaneous waiters cannot share a time.
   * Requests already started retain their concurrency; a cancelled waiter is removed.
   */
  private async paceAccount(account: Account, signal?: AbortSignal): Promise<void> {
    if (this.minStartIntervalMs <= 0 && this.globalMinStartIntervalMs <= 0) return;
    // Queue gates describe ordering only; request failures must stay local.
    const accountPrevious = (this.pacingTails.get(account.id) ?? Promise.resolve()).catch(() => {});
    const globalPrevious = this.globalPacingTail.catch(() => {});
    const previous = Promise.all([accountPrevious, globalPrevious]).then(() => undefined);
    let unlock!: () => void;
    const own = new Promise<void>(resolve => { unlock = resolve; });
    // This gate is independent of the rejecting request promise. Cancellation
    // resolves own in finally, while the predecessor still preserves FIFO.
    const tail = previous.then(() => own);
    this.pacingTails.set(account.id, tail);
    this.globalPacingTail = tail;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new Error('Request aborted by client.');
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(new Error('Request aborted by client.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        previous.then(resolve, reject);
      });
      if (signal?.aborted) throw new Error('Request aborted by client.');
      const now = Date.now();
      const accountWait = (this.lastGenerationStartAt.get(account.id) ?? 0) + this.minStartIntervalMs - now;
      const globalWait = this.lastGlobalGenerationStartAt + this.globalMinStartIntervalMs - now;
      const wait = Math.max(accountWait, globalWait);
      if (wait > 0) await waitForRetry(wait, signal);
      if (signal?.aborted) throw new Error('Request aborted by client.');
      const startedAt = Date.now();
      this.lastGenerationStartAt.set(account.id, startedAt);
      this.lastGlobalGenerationStartAt = startedAt;
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      unlock();
      void tail.then(() => {
        if (this.pacingTails.get(account.id) === tail) this.pacingTails.delete(account.id);
        if (this.globalPacingTail === tail) this.globalPacingTail = Promise.resolve();
      });
    }
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
    waitForBoundAccount = true,
    requestId?: string
  ): Promise<Account | null> {
    // Small pool doubles used by downstream integrations retain the old interface.
    if (this.pool.acquireAccountAsync) {
      if (signal?.aborted) throw new Error('Request aborted by client.');
      if (!waitForBoundAccount) return this.pool.acquireAccount(excludeIds, requiredFamily, sessionKey);
      return this.pool.acquireAccountAsync(excludeIds, requiredFamily, sessionKey, {
        signal, requestId, timeoutMs: this.config.accountQueueTimeoutMs,
        maxAccountQueue: this.config.maxAccountQueue, maxConversationQueue: this.config.maxConversationQueue,
        maxTotalQueue: this.config.maxTotalQueue
      });
    }
    if (signal?.aborted) throw new Error('Request aborted by client.');
    return this.pool.acquireAccount(excludeIds, requiredFamily, sessionKey);
  }

  private rejected429(body: string, delayMs: number, headers: Record<string, any> = {}): UpstreamRequestError {
    return new UpstreamRequestError(429, body, headersWithRetryAfter(headers, delayMs));
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
          if (await this.refresher.refreshSingleAccount(account, signal)) {
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
          throw this.rejected429(body, retryDelay, res.headers as Record<string, any>);
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
        if (err instanceof UpstreamRequestError || err instanceof AccountSchedulingError) throw err;
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
    requestId?: string,
    borrowed?: BorrowedCountLease
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
    const serializedCountPayload = JSON.stringify(buildCountTokensPayload(payload.request));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Token counting is an auxiliary control-plane call. It may establish
      // the request's local account lease, but it must not replace that lease
      // with another account before generation starts, and it must not queue
      // for a busy bound account: generation queues once, not twice.
      const account = borrowed?.account ?? await this.acquireRequestAccount(triedAccountIds, family, sessionKey, signal, false, requestId);
      if (!account) throw new Error(`No available ${family} account for token counting.`);
      triedAccountIds.add(account.id);
      const owned = !borrowed ? this.pool.trackLease?.(account, family, sessionKey) : undefined;
      let released = false;
      const releaseAccount = (error?: Parameters<AccountPool['releaseAccount']>[1]) => {
        if (released) return;
        released = true;
        if (borrowed) { if (error) borrowed.release(error); }
        else if (owned) owned.release(error);
        else this.pool.releaseAccount(account.id, error, family, sessionKey);
      };


      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        let ok = false;
        try {
          ok = await this.refresher.refreshSingleAccount(account, signal);
        } catch (err) {
          releaseAccount();
          throw err;
        }
        if (!ok) {
          if (account.status === 'dead') {
            releaseAccount({ code: 401, message: 'Token refresh failed during countTokens' });
          } else {
            releaseAccount();
          }
          throw new UpstreamRequestError(401, 'Token refresh failed during countTokens; account requires re-authentication.');
        }
      }

      // Count-token calls also consume upstream request-rate budget. Pace them
      // with generation starts so an Anthropic preflight cannot create a
      // second burst immediately before the actual generation request.
      try {
        await this.paceAccount(account, signal);
      } catch (err) {
        releaseAccount();
        throw err;
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
        const res = await transport.run(() => this.io.request(countUrl, {
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
          transportAttempt: transport,
          signal
        }, effectiveProxy));
        const body = await readErrorBody(res);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const parsed = JSON.parse(body);
          const totalTokens = Number(
            parsed.totalTokens ?? parsed.total_tokens ?? parsed.promptTokenCount ?? parsed.usageMetadata?.promptTokenCount
          );
          if (Number.isFinite(totalTokens)) {
            releaseAccount();
            return { totalTokens, accountUsed: account };
          }
          // Let the surrounding transport-error path release this lease once.
          // Releasing here and then again in catch would steal concurrency
          // from another request sharing the same account.
          throw new Error(`countTokens response did not include totalTokens: ${body.slice(0, 300)}`);
        }
        if (isContextOverflow(res.statusCode, body)) {
          // The generation attempt owns a borrowed slot, even on this early exit.
          releaseAccount();
          console.warn('[Executor] context_overflow req=' + (requestId ?? 'unknown')
            + ' account=' + account.id + ' model=' + payload.model + ' phase=preflight upstream=' + body.substring(0, 500));
          throw new ContextOverflowError(res.statusCode, body);
        }

        if (isLocationNotSupported(res.statusCode, body)) {
          releaseAccount();
          this.pool.clearSessionBinding(sessionKey, account.id, undefined, family, 'location_rejected');
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
            releaseAccount({
              code: 401,
              message: body || 'Repeated 401 after token refresh',
              recoverable: true
            });
            throw new UpstreamRequestError(503, `Upstream rejected a freshly refreshed account token during token counting: ${body.substring(0, 300)}`);
          }
          console.warn(`[Executor] countTokens 401 for ${account.email}; refreshing the token once before isolating it.`);
          const refreshOk = await this.refresher.refreshSingleAccount(account, signal);
          if (refreshOk) {
            releaseAccount();
            refreshedAccounts.add(account.id);
            triedAccountIds.delete(account.id);
            continue;
          }
          if (account.status === 'dead') {
            releaseAccount({ code: 401, message: 'Token refresh failed during countTokens' });
          } else {
            releaseAccount();
          }
          throw new UpstreamRequestError(503, `Upstream rejected a freshly refreshed account token during token counting: ${body.substring(0, 300)}`);
        }

        if (res.statusCode === 403) {
          const forbiddenKind = classifyForbidden(res.statusCode, body);
          if (forbiddenKind === 'policy') {
            releaseAccount({ code: 403, message: body || 'HTTP 403' });
            throw new UpstreamRequestError(res.statusCode, body, res.headers as Record<string, any>);
          }
          const forbiddenCooldown = Math.max(
            retryAfterMs(res.headers as Record<string, unknown>, body, this.config.cooldownSeconds * 1000),
            5 * 60 * 1000
          );
          console.warn(`[Executor] countTokens 403 (${forbiddenKind}) for ${account.email}; cooling down ${Math.ceil(forbiddenCooldown / 1000)}s.`);
          releaseAccount({ code: 403, message: body || 'HTTP 403', retryAfterMs: forbiddenCooldown, recoverable: true });
          throw new UpstreamRequestError(
            res.statusCode,
            body,
            headersWithRetryAfter(res.headers as Record<string, any>, forbiddenCooldown)
          );
        }

        const retryDelay = res.statusCode === 429
          ? retryAfterMs(res.headers as Record<string, unknown>, body, this.config.cooldownSeconds * 1000)
          : undefined;
        // A transient auxiliary failure does not invalidate a borrowed generation slot.
        if (!borrowed || res.statusCode < 500) releaseAccount({
          code: res.statusCode,
          message: body,
          ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay })
        });
        if (res.statusCode === 429) {
          throw this.rejected429(body, retryDelay!, res.headers as Record<string, any>);
        }
        throw new UpstreamRequestError(
          res.statusCode,
          body,
          retryDelay === undefined
            ? res.headers as Record<string, any>
            : headersWithRetryAfter(res.headers as Record<string, any>, retryDelay)
        );
      } catch (err: any) {
        if (err instanceof UpstreamRequestError || err instanceof AccountSchedulingError) throw err;
        releaseAccount();
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

  /** One account lease, one preflight, and a bounded generation retry budget. */
  public async executeWithRetry(
    payload: GoogleCloudCodePayload,
    maxRetries = 3,
    sessionKey?: string,
    signal?: AbortSignal,
    requestId?: string,
    preflight = false
  ): Promise<UpstreamExecutionResult> {
    const maxAttempts = Math.max(1, Math.min(10, Math.floor(maxRetries) || 3));
    const family = /claude|opus|sonnet|gpt|oss/i.test(payload.model || '') ? 'claude' : 'gemini';
    const account = await this.acquireRequestAccount(new Set(), family, sessionKey, signal, true, requestId);
    if (!account) throw accountUnavailableError(this.pool.getAllAccounts(), family);
    const lease = this.pool.trackLease(account, family, sessionKey);
    let released = false;
    let handedOff = false;
    let pendingError: Parameters<AccountPool['releaseAccount']>[1];
    const release = (error?: Parameters<AccountPool['releaseAccount']>[1], succeeded = false) => {
      if (released) return;
      released = true;
      lease.release(error, succeeded);
    };
    const effectiveProxy = account.proxyUrl || this.config.defaultProxyUrl;
    let waitedMs = 0;
    const maxRetryWaitMs = 15_000;
    const backoff = async (attempt: number, hintMs = 0): Promise<boolean> => {
      const delayMs = Math.max(hintMs, this.io.jitter(Math.min(4000, 1000 * 2 ** (attempt - 1))));
      if (attempt >= maxAttempts || waitedMs + delayMs > maxRetryWaitMs) return false;
      waitedMs += delayMs;
      console.info('[Executor] retry req=' + requestId + ' account=' + account.id
        + ' next_attempt=' + (attempt + 1) + '/' + maxAttempts + ' delay_ms=' + delayMs);
      await this.io.wait(delayMs, signal);
      return true;
    };

    try {
      if (signal?.aborted) throw new Error('Request aborted by client.');
      if (!account.accessToken || Date.now() >= account.accessTokenExpiresAt) {
        const ok = await this.refresher.refreshSingleAccount(account, signal);
        if (!ok) {
          pendingError = { code: account.status === 'dead' ? 401 : 503, message: 'Initial token refresh failed' };
          throw new UpstreamRequestError(503, 'Unable to refresh the upstream account token.');
        }
      }
      let inputTokenCount: number | undefined;
      if (preflight) {
        try {
          const counted = await this.countTokens(payload, 1, sessionKey, signal, requestId, { account, release });
          inputTokenCount = counted.totalTokens;
          console.info('[Executor] Preflight countTokens req=' + requestId + ' account=' + account.id + ' input=' + inputTokenCount);
        } catch (error: any) {
          if (signal?.aborted || released || error instanceof AccountSchedulingError
            || (error instanceof UpstreamRequestError && error.statusCode < 500)) throw error;
          console.warn('[Executor] countTokens unavailable req=' + requestId + '; using generation usage metadata.');
        }
      }
      // Never mutate the caller's payload when attaching an account-scoped session.
      const generationPayload = { ...payload, request: { ...payload.request } };
      if (sessionKey) attachUpstreamSessionId(generationPayload, sessionKey + '\0' + account.id, true);
      const body = JSON.stringify(generationPayload);
      const payloadBytes = generationPayloadByteSizes(generationPayload, body);
      let refreshed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw new Error('Request aborted by client.');
        await this.paceAccount(account, signal);
        const current = this.pool.getAccount(account.id);
        if (!current || !isAccountEligible(current, family) || !lease.isCurrent()) {
          throw new AccountSchedulingError('unavailable', '账号状态已变化，本次请求已停止。');
        }
        const transport = new TransportAttempt(undefined, requestId, 'http2-ping');
        let res: any;
        try {
          lease.markGeneration();
          console.info('[Executor] generation_start req=' + requestId + ' account=' + account.id
            + ' family=' + family + ' model=' + payload.model + ' attempt=' + attempt + '/' + maxAttempts
            + ' payload_bytes=' + payloadBytes.payload + ' contents_bytes=' + payloadBytes.contents
            + ' system_bytes=' + payloadBytes.system + ' tools_bytes=' + payloadBytes.tools);
          const generationRequest = this.io.requestWithPing ?? this.io.request;
          res = await transport.run(() => generationRequest(this.config.upstreamUrl, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + account.accessToken,
              'Content-Type': 'application/json',
              'User-Agent': 'antigravity/2.14.0',
              'x-goog-api-client': 'gl-node/22.7.0 grpc-web/1.0.0'
            },
            body, headersTimeout: this.upstreamTimeoutMs, bodyTimeout: this.upstreamTimeoutMs,
            connectTimeout: this.connectTimeoutMs, transportAttempt: transport, signal
          }, effectiveProxy));
        } catch (error: any) {
          if (signal?.aborted) throw error;
          const code = error.code || error.cause?.code || 'unknown';
          const detail = String(error?.message || 'transport error').slice(0, 240);
          pendingError = { code: 502, message: 'Upstream transport failed (' + code + '): ' + detail };
          console.warn('[Executor] generation_transport_error req=' + requestId + ' account=' + account.id
            + ' ' + transport.describe() + ' code=' + code + ' message=' + detail);
          // Once any request bytes may have been sent, replay is unsafe.
          if (transport.requestSent) {
            throw new UpstreamRequestError(502, 'Upstream connection failed after sending the generation request (' + code
              + '): ' + detail + '; result unknown. Automatic replay stopped.');
          }
          if (await backoff(attempt)) continue;
          throw new UpstreamRequestError(502, pendingError.message);
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          handedOff = true;
          return { statusCode: res.statusCode, headers: res.headers, bodyStream: res.body,
            accountUsed: account, inputTokenCount, release: error => release(error, !error) };
        }

        const errorBody = await readErrorBody(res);
        pendingError = { code: res.statusCode, message: errorBody || 'HTTP ' + res.statusCode };
        const classified = classifyUpstreamError(res.statusCode, errorBody);
        if (res.statusCode === 429) {
          const hintMs = retryAfterMs(res.headers, errorBody, 0);
          const cooldownMs = Math.max(1000, hintMs || this.config.cooldownSeconds * 1000);
          pendingError.retryAfterMs = cooldownMs;
          console.warn('[Executor] upstream_429 req=' + requestId + ' account=' + account.id
            + ' kind=' + classified.kind + ' reason=' + (classified.reason || 'unspecified')
            + ' payload_bytes=' + payloadBytes.payload + ' contents_bytes=' + payloadBytes.contents
            + ' system_bytes=' + payloadBytes.system + ' tools_bytes=' + payloadBytes.tools);
          if (classified.kind !== 'quota' && await backoff(attempt, hintMs)) continue;
          throw this.rejected429(errorBody, cooldownMs, res.headers);
        }
        if (res.statusCode === 401) {
          pendingError = { code: 503, message: 'Upstream token refresh pending' };
          if (!refreshed && attempt < maxAttempts) {
            refreshed = true;
            if (await this.refresher.refreshSingleAccount(account, signal)) continue;
          }
          pendingError = { code: 401, message: errorBody || 'HTTP 401', recoverable: account.status !== 'dead' };
          throw new UpstreamRequestError(503, 'Upstream account authentication failed after token refresh.');
        }
        if (classified.kind === 'location') {
          this.pool.clearSessionBinding(sessionKey, account.id, undefined, family, 'location_rejected');
          // This is a routing rejection, not evidence of a disabled account.
          pendingError = undefined;
          throw new LocationNotSupportedError(res.statusCode, errorBody);
        }
        if (res.statusCode === 403) {
          pendingError.recoverable = classified.kind !== 'policy_blocked';
          pendingError.retryAfterMs = retryAfterMs(res.headers, errorBody, this.config.cooldownSeconds * 1000);
          throw new UpstreamRequestError(403, errorBody, res.headers);
        }
        if (res.statusCode === 503 && await backoff(attempt, retryAfterMs(res.headers, errorBody, 0))) continue;
        if (isContextOverflow(res.statusCode, errorBody)) throw new ContextOverflowError(res.statusCode, errorBody);
        throw new UpstreamRequestError(res.statusCode, errorBody, res.headers);
      }
      throw new UpstreamRequestError(503, 'Generation retry budget exhausted.');
    } finally {
      if (!handedOff) release(pendingError ?? (signal?.aborted ? { code: 499, message: 'Client disconnected' } : undefined));
    }
  }
}
