import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Account, PoolStats, AccountStatus, RoutingStrategy } from '../types.js';
import { classifyUpstreamError, retryAfterMs } from './error-policy.js';
import { clearLegacyQuotaResetTimes, reconcileQuotaState } from './quota-state.js';
import { AccountAcquireOptions, AccountSchedulingError, accountUnavailableError, hasFamilyQuota, ModelFamily } from './scheduling.js';

interface AccountWaiter {
  excludeIds: Set<string>;
  family: ModelFamily;
  sessionKey?: string;
  root: string;
  createdAt: number;
  deadline: number;
  requestId?: string;
  maxAccountQueue: number;
  maxConversationQueue: number;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  resolve: (account: Account | null) => void;
  reject: (error: Error) => void;
}

interface SessionBinding {
  sessionKey: string;
  family?: ModelFamily;
  accountId: string;
  lastUsedAt: number;
  version: number;
  generationStarted: boolean;
}

/**
 * Google may expose the same cache metric under different field names, and
 * streaming responses do not always repeat every usage field in every chunk.
 * Keep the richest value seen so one sparse final chunk cannot erase an
 * earlier cache count.
 */
export function mergeUsageMetadata<T extends Record<string, any>>(
  previous: T | null | undefined,
  next: T
): T {
  const merged: Record<string, any> = { ...(previous || {}), ...next };
  const finiteValues = (...values: unknown[]) => values
    .map(Number)
    .filter(Number.isFinite) as number[];
  const maxValue = (...values: unknown[]) => {
    const numbers = finiteValues(...values);
    return numbers.length ? Math.max(...numbers) : undefined;
  };

  // Some terminal chunks omit or zero prompt usage after an earlier chunk
  // supplied it. Losing that value prevents clients from tracking context.
  const prompt = maxValue(previous?.promptTokenCount, next.promptTokenCount);
  if (prompt !== undefined) merged.promptTokenCount = prompt;

  const cacheRead = maxValue(
    previous?.cachedContentTokenCount,
    previous?.cacheReadInputTokenCount,
    previous?.cache_read_input_tokens,
    next.cachedContentTokenCount,
    next.cacheReadInputTokenCount,
    next.cache_read_input_tokens
  );
  if (cacheRead !== undefined) {
    merged.cachedContentTokenCount = cacheRead;
    merged.cacheReadInputTokenCount = cacheRead;
    merged.cache_read_input_tokens = cacheRead;
  }

  const cacheCreation = maxValue(
    previous?.cacheCreationInputTokenCount,
    previous?.cache_creation_input_tokens,
    next.cacheCreationInputTokenCount,
    next.cache_creation_input_tokens
  );
  if (cacheCreation !== undefined) {
    merged.cacheCreationInputTokenCount = cacheCreation;
    merged.cache_creation_input_tokens = cacheCreation;
  }

  return merged as T;
}

export class AccountPool {
  private readonly dataDirectory: string;
  private readonly accountsFile: string;
  private accounts: Map<string, Account> = new Map();
  private startTime = Date.now();
  private totalRequestsServed = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalCachedTokens = 0;
  private totalCacheCreationTokens = 0;
  private totalCacheReadTokens = 0;
  private totalTokens = 0;
  private hasTokenUsage = false;
  private isInternalSaving = false;
  private internalSaveTimer: NodeJS.Timeout | null = null;
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private routingStrategy: RoutingStrategy = 'zero-waste';
  private sessionBindings = new Map<string, SessionBinding>();
  private bindingVersion = 0;
  private sessionLeases = new Map<string, number>();
  private activeConversationTtlMs: number;
  private sessionCleanTimer: NodeJS.Timeout | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private waiters: AccountWaiter[] = [];
  private readyRoots = new Map<string, string[]>();
  private queueTimer?: NodeJS.Timeout;
  private draining = false;
  private disposed = false;

  constructor(initialStrategy: RoutingStrategy = 'zero-waste', storageDirectory = path.resolve(process.cwd(), 'data'), activeConversationTtlMs = 15 * 60_000) {
    this.activeConversationTtlMs = Math.max(1000, activeConversationTtlMs);
    this.dataDirectory = path.resolve(storageDirectory);
    this.accountsFile = path.join(this.dataDirectory, 'accounts.json');
    this.routingStrategy = initialStrategy;
    this.ensureDataDir();
    this.loadAccounts();
    this.setupFileWatcher();
    this.setupSessionCleaner();
  }

  private setupSessionCleaner(): void {
    this.sessionCleanTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, val] of this.sessionBindings.entries()) {
        if (now - val.lastUsedAt > 60 * 60 * 1000
          && !(this.accounts.get(val.accountId)?.activeConcurrency)
          && !this.waiters.some(waiter => waiter.sessionKey === val.sessionKey && waiter.family === val.family)) {
          this.sessionBindings.delete(key);
        }
      }
    }, 10 * 60 * 1000);
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDirectory)) {
      fs.mkdirSync(this.dataDirectory, { recursive: true });
    }
  }

  private setupFileWatcher(): void {
    if (!fs.existsSync(this.accountsFile)) {
      this.ensureDataDir();
      fs.writeFileSync(this.accountsFile, '[]', 'utf-8');
    }

    try {
      this.fileWatcher = fs.watch(this.accountsFile, (eventType) => {
        if (this.isInternalSaving) return;
        if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
        this.reloadDebounceTimer = setTimeout(() => {
          // Re-check at fire time: our own write may have been slow to surface.
          if (this.isInternalSaving) return;
          console.log('[AccountPool] Detected external change to accounts.json, reloading from disk...');
          this.loadAccounts();
        }, 300);
      });
    } catch (e: any) {
      console.error('[AccountPool] Error setting up accounts.json watcher:', e.message);
    }
  }

  /** Stop the maintenance timers and the file watcher (shutdown and tests). */
  public dispose(): void {
    this.disposed = true;
    for (const waiter of [...this.waiters]) {
      this.finishWaiter(waiter, new AccountSchedulingError('unavailable', '账号池已停止。'));
    }
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = undefined;
    if (this.sessionCleanTimer) {
      clearInterval(this.sessionCleanTimer);
      this.sessionCleanTimer = null;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    if (this.internalSaveTimer) {
      clearTimeout(this.internalSaveTimer);
      this.internalSaveTimer = null;
    }
    this.isInternalSaving = false;
    this.fileWatcher?.close();
    this.fileWatcher = null;
  }

  public loadAccounts(): void {
    if (fs.existsSync(this.accountsFile)) {
      try {
        const raw = fs.readFileSync(this.accountsFile, 'utf-8');
        const list: Account[] = JSON.parse(raw);
        const live = this.accounts;
        const next = new Map<string, Account>();
        for (const acc of list) {
          clearLegacyQuotaResetTimes(acc);
          const previous = live.get(acc.id);
          // The persisted file never carries concurrency. Zeroing it while
          // requests are in flight would stop counting them and over-admit the
          // account, so carry the in-memory lease count across the reload.
          const inFlight = previous?.activeConcurrency ?? 0;
          acc.activeConcurrency = Number.isFinite(inFlight) && inFlight > 0 ? inFlight : 0;
          for (const family of ['gemini', 'claude'] as const) {
            const blocked = previous?.quotaBlockedUntil?.[family] ?? 0;
            if (blocked > Date.now()) {
              acc.quotaBlockedUntil = { ...acc.quotaBlockedUntil, [family]: Math.max(blocked, acc.quotaBlockedUntil?.[family] ?? 0) };
            }
          }
          if ((previous?.quota?.lastCheckedAt ?? 0) > (acc.quota?.lastCheckedAt ?? 0)) acc.quota = previous!.quota;
          reconcileQuotaState(acc);
          // A terminal in-memory state must never be undone by reloading a
          // stale copy of the file.
          if (previous && (previous.status === 'dead' || previous.status === 'disabled') && acc.status !== previous.status) {
            acc.status = previous.status;
            acc.lastError = previous.lastError;
            acc.validationUrl = previous.validationUrl;
          }
          // An unexpired cooldown is the main anti-ban throttle. A stale file
          // copy (an editor tab, a second process) must not erase it.
          if (previous
            && previous.status === 'cooldown'
            && previous.cooldownUntil > Date.now()
            && (acc.status !== 'cooldown' || acc.cooldownUntil < previous.cooldownUntil)) {
            acc.status = 'cooldown';
            acc.cooldownUntil = previous.cooldownUntil;
          }
          next.set(acc.id, acc);
        }
        this.accounts = next;
        console.log(`[AccountPool] Loaded ${this.accounts.size} account(s) from storage.`);
      } catch (e) {
        console.error('[AccountPool] Failed to load accounts.json:', e);
      }
    } else {
      this.saveAccounts();
    }
  }

  public saveAccounts(): void {
    // Only the latest save may end the self-write suppression window.
    if (this.internalSaveTimer) clearTimeout(this.internalSaveTimer);
    this.internalSaveTimer = null;
    try {
      this.isInternalSaving = true;
      const list = Array.from(this.accounts.values()).map(acc => ({
        ...acc,
        activeConcurrency: 0 // 持久化时不保留内存中的并发计数
      }));
      fs.writeFileSync(this.accountsFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.error('[AccountPool] Failed to save accounts.json:', e);
    } finally {
      this.internalSaveTimer = setTimeout(() => {
        this.internalSaveTimer = null;
        this.isInternalSaving = false;
      }, 500);
    }
  }

  public getAllAccounts(): Account[] {
    return Array.from(this.accounts.values());
  }

  public getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  private sessionBindingKey(sessionKey: string, family?: ModelFamily): string {
    return (family ?? 'any') + '::' + sessionKey;
  }

  public getSessionBinding(sessionKey: string, family?: ModelFamily): SessionBinding | undefined {
    if (family) return this.sessionBindings.get(this.sessionBindingKey(sessionKey, family));
    // Keep the inspection API usable for integrations that only use one family.
    return this.sessionBindings.get(this.sessionBindingKey(sessionKey, 'gemini'))
      ?? this.sessionBindings.get(this.sessionBindingKey(sessionKey, 'claude'))
      ?? this.sessionBindings.get(this.sessionBindingKey(sessionKey));
  }

  public clearSessionBinding(sessionKey: string | undefined, accountId?: string, version?: number,
    family?: ModelFamily, reason = 'explicit_clear'): void {
    if (!sessionKey) return;
    const families = family ? [family] : ['gemini', 'claude', undefined] as const;
    for (const targetFamily of families) {
      const key = this.sessionBindingKey(sessionKey, targetFamily);
      const binding = this.sessionBindings.get(key);
      if (binding && (!accountId || binding.accountId === accountId) && (version === undefined || binding.version === version)) {
        this.sessionBindings.delete(key);
        console.info('[Scheduler] unbound root=' + crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0, 12)
          + ' family=' + (targetFamily ?? 'any') + ' account=' + binding.accountId + ' reason=' + reason);
      }
    }
  }

  /** A request owns exactly one release, including preflight and generation. */
  public trackLease(account: Account, family: ModelFamily, sessionKey?: string) {
    const key = sessionKey ? this.sessionBindingKey(sessionKey, family) : undefined;
    const binding = key ? this.sessionBindings.get(key) : undefined;
    const version = binding?.version;
    if (key) this.sessionLeases.set(key, (this.sessionLeases.get(key) ?? 0) + 1);
    let released = false;
    return {
      isCurrent: () => !key || (this.sessionBindings.get(key)?.version === version
        && this.sessionBindings.get(key)?.accountId === account.id),
      markGeneration: () => {
        const current = key ? this.sessionBindings.get(key) : undefined;
        if (current && current.version === version && current.accountId === account.id) current.generationStarted = true;
      },
      release: (error?: Parameters<AccountPool['releaseAccount']>[1]) => {
        if (released) return;
        released = true;
        if (key) {
          const remaining = Math.max(0, (this.sessionLeases.get(key) ?? 1) - 1);
          if (remaining) this.sessionLeases.set(key, remaining); else this.sessionLeases.delete(key);
          const current = this.sessionBindings.get(key);
          if (current && current.version === version && current.accountId === account.id) {
            current.lastUsedAt = Date.now();
            if (!remaining && !current.generationStarted) this.sessionBindings.delete(key);
          }
        }
        this.releaseAccount(account.id, error, family, sessionKey, version);
      }
    };
  }

  public addAccount(params: {
    email: string;
    refreshToken: string;
    accessToken?: string;
    expiresInSeconds?: number;
    proxyUrl?: string;
    maxConcurrency?: number;
  }): Account {
    const id = `acc_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const newAcc: Account = {
      id,
      email: params.email,
      refreshToken: params.refreshToken,
      accessToken: params.accessToken || '',
      accessTokenExpiresAt: params.accessToken ? now + (params.expiresInSeconds || 3600) * 1000 : 0,
      status: 'active',
      cooldownUntil: 0,
      activeConcurrency: 0,
      maxConcurrency: params.maxConcurrency || 5,
      totalRequests: 0,
      failedRequests: 0,
      proxyUrl: params.proxyUrl?.trim() || undefined,
      lastUsedAt: 0,
      createdAt: now
    };

    this.accounts.set(id, newAcc);
    this.saveAccounts();
    return newAcc;
  }

  public updateAccount(id: string, updates: Partial<Account>): Account | null {
    const acc = this.accounts.get(id);
    if (!acc) return null;

    Object.assign(acc, updates);
    reconcileQuotaState(acc);
    if (updates.proxyUrl === undefined && 'proxyUrl' in updates) {
      delete (acc as any).proxyUrl;
    }
    this.saveAccounts();
    return acc;
  }

  public removeAccount(id: string): boolean {
    const deleted = this.accounts.delete(id);
    if (deleted) {
      for (const [key, val] of this.sessionBindings.entries()) {
        if (val.accountId === id) {
          this.sessionBindings.delete(key);
        }
      }
      this.saveAccounts();
    }
    return deleted;
  }

  public getRoutingStrategy(): RoutingStrategy {
    return this.routingStrategy;
  }

  public setRoutingStrategy(strategy: RoutingStrategy): void {
    console.log(`[AccountPool] Switching routing strategy from ${this.routingStrategy} to ${strategy}`);
    this.routingStrategy = strategy;
  }

  private waiterLane(waiter: Pick<AccountWaiter, 'sessionKey' | 'family'>): string {
    const binding = waiter.sessionKey ? this.getSessionBinding(waiter.sessionKey, waiter.family)
      ?? this.getSessionBinding(waiter.sessionKey) : undefined;
    const account = binding ? this.accounts.get(binding.accountId) : undefined;
    return account && this.isEligible(account, waiter.family) ? account.id : '*';
  }

  private isEligible(account: Account, family?: ModelFamily, now = Date.now()): boolean {
    return (account.status === 'active' || (account.status === 'cooldown' && account.cooldownUntil <= now))
      && hasFamilyQuota(account, family, now);
  }

  private queueDepth(accountId: string): number {
    return this.waiters.filter(waiter => this.waiterLane(waiter) === accountId).length;
  }

  private hasQueuedPriority(sessionKey?: string, family?: ModelFamily): boolean {
    const lane = sessionKey && (this.getSessionBinding(sessionKey, family) ?? this.getSessionBinding(sessionKey))?.accountId;
    return this.waiters.some(waiter => this.waiterLane(waiter) === '*' || (lane && this.waiterLane(waiter) === lane));
  }

  private finishWaiter(waiter: AccountWaiter, error?: Error, account?: Account | null): void {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (error) {
      console.warn('[Scheduler] rejected req=' + (waiter.requestId ?? 'unknown') + ' reason='
        + (error instanceof AccountSchedulingError ? error.code : 'cancelled')
        + ' wait=' + (Date.now() - waiter.createdAt) + 'ms');
      waiter.reject(error);
    } else waiter.resolve(account ?? null);
    if (this.waiters.length === 0) {
      if (this.queueTimer) clearInterval(this.queueTimer);
      this.queueTimer = undefined;
      this.readyRoots.clear();
    }
  }

  /** FIFO within a root conversation; round robin between roots on each account. */
  private drainQueue(): void {
    if (this.draining || this.disposed || !this.waiters.length) return;
    this.draining = true;
    try {
      const lanes = new Map<string, AccountWaiter[]>();
      for (const waiter of [...this.waiters]) {
        if (waiter.signal?.aborted) {
          this.finishWaiter(waiter, new Error('Request aborted by client.'));
          continue;
        }
        if (Date.now() >= waiter.deadline) {
          this.finishWaiter(waiter, new AccountSchedulingError('queue_timeout', '账号并发等待超时，本次请求未因繁忙而切换账号。'));
          continue;
        }
        const unavailable = accountUnavailableError(this.getAllAccounts(), waiter.family, waiter.excludeIds);
        if (unavailable.code !== 'account_busy') {
          this.finishWaiter(waiter, unavailable);
          continue;
        }
        const lane = this.waiterLane(waiter);
        const group = lanes.get(lane) ?? [];
        if (group.length >= waiter.maxAccountQueue
          || group.filter(item => item.root === waiter.root).length >= waiter.maxConversationQueue) {
          this.finishWaiter(waiter, new AccountSchedulingError('queue_full', '绑定变化后的账号或对话等待队列已满，请稍后重试。'));
          continue;
        }
        group.push(waiter);
        lanes.set(lane, group);
      }
      for (const lane of this.readyRoots.keys()) if (!lanes.has(lane)) this.readyRoots.delete(lane);
      // Bound queues have priority over cold conversations seeking any account.
      for (const [lane, group] of [...lanes].sort(([a], [b]) => a === '*' ? 1 : b === '*' ? -1 : 0)) {
        const roots = [...new Set(group.map(waiter => waiter.root))];
        const ring = (this.readyRoots.get(lane) ?? []).filter(root => roots.includes(root));
        for (const root of roots) if (!ring.includes(root)) ring.push(root);
        this.readyRoots.set(lane, ring);
        let misses = 0;
        while (ring.length && misses < ring.length) {
          const root = ring.shift()!;
          ring.push(root);
          const waiter = group.find(item => item.root === root && this.waiters.includes(item));
          if (!waiter) {
            ring.pop();
            continue;
          }
          // A cold first request may have established the binding for its siblings.
          if (lane === '*' && this.waiterLane(waiter) !== '*') { misses++; continue; }
          const excluded = new Set(waiter.excludeIds);
          if (lane === '*') {
            for (const [boundLane, boundGroup] of lanes) {
              if (boundLane !== '*' && boundGroup.some(item => this.waiters.includes(item))) excluded.add(boundLane);
            }
          }
          const account = this.tryAcquireAccount(excluded, waiter.family, waiter.sessionKey);
          if (!account) { misses++; continue; }
          misses = 0;
          console.info('[Scheduler] acquired req=' + (waiter.requestId ?? 'unknown')
            + ' account=' + account.id + ' family=' + waiter.family + ' root=' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)
            + ' wait=' + (Date.now() - waiter.createdAt) + 'ms queued=' + (this.waiters.length - 1));
          this.finishWaiter(waiter, undefined, account);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  public acquireAccountAsync(excludeIds: Set<string>, family: ModelFamily, sessionKey?: string,
    options: AccountAcquireOptions = {}): Promise<Account | null> {
    if (options.signal?.aborted) return Promise.reject(new Error('Request aborted by client.'));
    if (this.disposed) return Promise.reject(new AccountSchedulingError('unavailable', '账号池已停止。'));
    this.drainQueue();
    const immediate = this.acquireAccount(excludeIds, family, sessionKey);
    if (immediate) return Promise.resolve(immediate);
    const unavailable = accountUnavailableError(this.getAllAccounts(), family, excludeIds);
    if (unavailable.code !== 'account_busy') return Promise.reject(unavailable);
    const lane = this.waiterLane({ sessionKey, family });
    const root = sessionKey || 'request:' + crypto.randomUUID();
    const inLane = this.waiters.filter(waiter => this.waiterLane(waiter) === lane);
    const own = inLane.filter(waiter => waiter.root === root).length;
    if (this.waiters.length >= (options.maxTotalQueue ?? 1000)
      || inLane.length >= (options.maxAccountQueue ?? 100)
      || own >= (options.maxConversationQueue ?? 32)) {
      return Promise.reject(new AccountSchedulingError('queue_full', '账号或对话等待队列已满，请稍后重试。'));
    }
    const timeoutMs = Math.max(1, options.timeoutMs ?? 120000);
    return new Promise((resolve, reject) => {
      const waiter: AccountWaiter = { excludeIds: new Set(excludeIds), family, sessionKey, root,
        createdAt: Date.now(), deadline: Date.now() + timeoutMs, requestId: options.requestId,
        signal: options.signal, maxAccountQueue: options.maxAccountQueue ?? 100,
        maxConversationQueue: options.maxConversationQueue ?? 32, resolve, reject };
      waiter.onAbort = () => { this.finishWaiter(waiter, new Error('Request aborted by client.')); this.drainQueue(); };
      waiter.timer = setTimeout(() => {
        this.finishWaiter(waiter, new AccountSchedulingError('queue_timeout', '账号并发等待超时（' + timeoutMs + 'ms），本次请求未因繁忙而切换账号。'));
        this.drainQueue();
      }, timeoutMs);
      this.waiters.push(waiter);
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      console.info('[Scheduler] queued req=' + (options.requestId ?? 'unknown') + ' reason=account_busy'
        + ' account=' + lane + ' family=' + family + ' depth=' + (inLane.length + 1));
      this.queueTimer ??= setInterval(() => this.drainQueue(), 100);
      this.drainQueue();
    });
  }

  /**
   * 获取下一个可用的账号（支持零浪费智能调度、会话粘性防 Cache 穿透、临期抢救、流水线耗尽与故障转移）
   */
  public acquireAccount(
    excludeIds: Set<string> = new Set(),
    requiredFamily?: 'claude' | 'gemini',
    sessionKey?: string
  ): Account | null {
    if (this.disposed || this.hasQueuedPriority(sessionKey, requiredFamily)) return null;
    const excluded = new Set(excludeIds);
    if (!sessionKey || !this.getSessionBinding(sessionKey, requiredFamily)) {
      for (const waiter of this.waiters) {
        const lane = this.waiterLane(waiter);
        if (lane !== '*') excluded.add(lane);
      }
    }
    return this.tryAcquireAccount(excluded, requiredFamily, sessionKey);
  }

  private tryAcquireAccount(excludeIds: Set<string>, requiredFamily?: ModelFamily, sessionKey?: string): Account | null {
    const now = Date.now();
    let existingBinding = sessionKey ? this.getSessionBinding(sessionKey, requiredFamily) : undefined;
    if (existingBinding) {
      const boundAccount = this.accounts.get(existingBinding.accountId);
      if (!boundAccount || !this.isEligible(boundAccount, requiredFamily, now)) {
        const reason = !boundAccount ? 'account_removed'
          : !hasFamilyQuota(boundAccount, requiredFamily, now) ? 'quota_exhausted' : 'account_' + boundAccount.status;
        this.clearSessionBinding(sessionKey, existingBinding.accountId, existingBinding.version, requiredFamily, reason);
        existingBinding = undefined;
      } else if (!excludeIds.has(boundAccount.id)
        && hasFamilyQuota(boundAccount, requiredFamily, now) && boundAccount.activeConcurrency >= boundAccount.maxConcurrency) {
        // A bound conversation waits for its own lease. Never borrow another
        // account merely because the bound account is momentarily full.
        return null;
      } else if (excludeIds.has(boundAccount.id)) {
        // The executor must clear a permanent failure before asking for a new
        // account. This guard prevents an accidental retry exclusion from
        // silently overwriting a healthy conversation binding.
        return null;
      }
    }

    // A family's first request also waits for the conversation's usable home.
    // Do not create a cold binding until a real lease is acquired.
    const relatedBinding = !existingBinding && sessionKey ? this.getSessionBinding(sessionKey) : undefined;
    const related = relatedBinding ? this.accounts.get(relatedBinding.accountId) : undefined;
    const relatedAccount = related && !excludeIds.has(related.id) && this.isEligible(related, requiredFamily, now) ? related : undefined;
    if (relatedAccount && relatedAccount.activeConcurrency >= relatedAccount.maxConcurrency) return null;

    const candidates: Account[] = [];

    for (const acc of this.accounts.values()) {
      if (excludeIds.has(acc.id)) continue;

      // 检查是否解除冷却
      if (acc.status === 'cooldown' && now >= acc.cooldownUntil) {
        acc.status = 'active';
        acc.cooldownUntil = 0;
        console.log(`[AccountPool] Account ${acc.email} (${acc.id}) cooldown expired, returned to active.`);
      }

      if (acc.status === 'active' && acc.activeConcurrency < acc.maxConcurrency
        && hasFamilyQuota(acc, requiredFamily, now)) {
        candidates.push(acc);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Reserve unused conversation homes first. Once all homes are shared,
    // actual capacity pressure precedes conversation counts.
    if (!existingBinding && !relatedAccount && sessionKey) {
      const sessionsByAccount = new Map<string, Set<string>>();
      for (const [key, binding] of this.sessionBindings) {
        // Match the cleaner's idle window; request-scoped preflight leases
        // are not persistent conversations.
        if (binding.sessionKey.startsWith('request:')) continue;
        if (now - binding.lastUsedAt > this.activeConversationTtlMs
          && !this.sessionLeases.has(key) && !this.waiters.some(waiter => waiter.sessionKey === binding.sessionKey && waiter.family === binding.family)) continue;
        const sessions = sessionsByAccount.get(binding.accountId) ?? new Set<string>();
        sessions.add(binding.sessionKey);
        sessionsByAccount.set(binding.accountId, sessions);
      }
      const sessionCounts = new Map([...sessionsByAccount].map(([id, sessions]) => [id, sessions.size]));
      const load = (acc: Account) => (acc.activeConcurrency + this.queueDepth(acc.id)) / Math.max(1, acc.maxConcurrency);
      if (candidates.some(acc => !sessionCounts.get(acc.id))) {
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (sessionCounts.get(candidates[i].id)) candidates.splice(i, 1);
        }
      }
      const minLoad = Math.min(...candidates.map(load));
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (load(candidates[i]) > minLoad + Number.EPSILON) candidates.splice(i, 1);
      }
      const minBoundSessions = Math.min(...candidates.map(acc => sessionCounts.get(acc.id) ?? 0));
      for (let i = candidates.length - 1; i >= 0; i--) {
        if ((sessionCounts.get(candidates[i].id) ?? 0) > minBoundSessions) candidates.splice(i, 1);
      }
    }

    let chosen: Account | null = relatedAccount ?? null;

    // ==================== 统一阶段 1: 会话粘性 (Pure Session Affinity - Cache First) ====================
    // 只要绑定账号仍健康且有空闲并发，就复用该账号。缓存命中率
    // 仍取决于上游 TTL、请求前缀和客户端是否提供稳定会话 ID，不能在
    // 调度层承诺固定比例。
    if (sessionKey && existingBinding) {
      const bound = existingBinding;
      const candidateAcc = candidates.find(c => c.id === bound.accountId);
      if (candidateAcc) {
        chosen = candidateAcc;
        existingBinding.lastUsedAt = now;
      }
    }

    // ==================== 阶段 2: 仅全新会话或旧账号不可用时，才执行调度分配 ====================
    if (!chosen) {
      if (this.routingStrategy === 'zero-waste') {
        // ==================== 策略 1: 零浪费智能调度 (新会话临期抢救 + 流水线耗尽) ====================
        // 步骤 2.1: 临期抢救优先 (Time-to-Reset Expiration Harvesting)
        // 如果有账号在 45 分钟内即将重置 5 小时额度，且目前剩余额度 > 8%，将新会话优先分配给它，抢救剩余额度！
        const imminentCandidates = candidates.filter(acc => {
          if (!acc.quota) return false;
          const resetTimeStr = (requiredFamily === 'claude' ? acc.quota.claudeResetTime : acc.quota.geminiResetTime);
          const fraction = (requiredFamily === 'claude' ? acc.quota.claude5hFraction : acc.quota.gemini5hFraction) ?? 1;
          if (!resetTimeStr || fraction <= 0.08) return false;
          const diffMs = new Date(resetTimeStr).getTime() - now;
          return diffMs > 0 && diffMs <= 45 * 60 * 1000;
        });

        if (imminentCandidates.length > 0) {
          imminentCandidates.sort((a, b) => {
            const timeA = new Date(requiredFamily === 'claude' ? a.quota!.claudeResetTime! : a.quota!.geminiResetTime!).getTime();
            const timeB = new Date(requiredFamily === 'claude' ? b.quota!.claudeResetTime! : b.quota!.geminiResetTime!).getTime();
            if (Math.abs(timeA - timeB) > 5 * 60 * 1000) return timeA - timeB;
            const fracA = (requiredFamily === 'claude' ? a.quota!.claude5hFraction : a.quota!.gemini5hFraction) ?? 0;
            const fracB = (requiredFamily === 'claude' ? b.quota!.claude5hFraction : b.quota!.gemini5hFraction) ?? 0;
            return fracB - fracA;
          });
          chosen = imminentCandidates[0];
          console.log(`[AccountPool] 🎯 [Zero-Waste 临期抢救] 新会话分配至账号 ${chosen.email} (5h额度即将重置，抢救剩余额度)`);
        } else {
          // 步骤 2.2: 流水线深度耗尽 (Sequential Pipeline)
          // 优先集中消耗当前的主力活跃账号，直到其 5h 额度用透再切下一个，让前序账号拥有完整的 5 小时回满时间！
          candidates.sort((a, b) => {
            // 排除周额度极度危险的账号（< 3%）
            const aWeekly = (requiredFamily === 'claude' ? a.quota?.claudeWeeklyFraction : a.quota?.geminiWeeklyFraction) ?? 1;
            const bWeekly = (requiredFamily === 'claude' ? b.quota?.claudeWeeklyFraction : b.quota?.geminiWeeklyFraction) ?? 1;
            if (aWeekly <= 0.03 && bWeekly > 0.03) return 1;
            if (bWeekly <= 0.03 && aWeekly > 0.03) return -1;

            const getResetDelay = (account: Account, weekly: boolean): number => {
              if (!account.quota) return Infinity;
              const resetTime = weekly
                ? (requiredFamily === 'claude' ? account.quota.claudeWeeklyResetTime : account.quota.geminiWeeklyResetTime)
                : (requiredFamily === 'claude' ? account.quota.claudeResetTime : account.quota.geminiResetTime);
              if (!resetTime) return Infinity;
              const timestamp = new Date(resetTime).getTime();
              const delay = timestamp - now;
              return Number.isFinite(delay) && delay > 0 ? delay : Infinity;
            };

            if (requiredFamily) {
              const aWeeklyReset = getResetDelay(a, true);
              const bWeeklyReset = getResetDelay(b, true);
              const weeklyResetGap = Math.abs(aWeeklyReset - bWeeklyReset);
              if (weeklyResetGap > 24 * 60 * 60 * 1000) {
                return aWeeklyReset - bWeeklyReset;
              }

              const a5hReset = getResetDelay(a, false);
              const b5hReset = getResetDelay(b, false);
              if (a5hReset !== b5hReset) {
                return a5hReset - b5hReset;
              }
            }

            // 多个同类候选时，优先按并发数均衡
            if (a.activeConcurrency !== b.activeConcurrency) {
              return a.activeConcurrency - b.activeConcurrency;
            }

            // 保持主力活跃号集中消耗
            const aIsActiveDrain = (now - a.lastUsedAt < 15 * 60 * 1000) && ((requiredFamily === 'claude' ? a.quota?.claude5hFraction : a.quota?.gemini5hFraction) ?? 1) > 0.05;
            const bIsActiveDrain = (now - b.lastUsedAt < 15 * 60 * 1000) && ((requiredFamily === 'claude' ? b.quota?.claude5hFraction : b.quota?.gemini5hFraction) ?? 1) > 0.05;
            if (aIsActiveDrain && !bIsActiveDrain) return -1;
            if (bIsActiveDrain && !aIsActiveDrain) return 1;

            const a5h = (requiredFamily === 'claude' ? a.quota?.claude5hFraction : a.quota?.gemini5hFraction) ?? 1;
            const b5h = (requiredFamily === 'claude' ? b.quota?.claude5hFraction : b.quota?.gemini5hFraction) ?? 1;
            return b5h - a5h;
          });
          chosen = candidates[0];
        }

      } else if (this.routingStrategy === 'sequential-drain') {
        // ==================== 策略 2: 流水线顺序耗尽模式 (Sequential Drain) ====================
        candidates.sort((a, b) => {
          if (a.activeConcurrency === 0 && b.activeConcurrency > 0) return -1;
          if (b.activeConcurrency === 0 && a.activeConcurrency > 0) return 1;
          return a.createdAt - b.createdAt;
        });
        chosen = candidates[0];

      } else {
        // ==================== 策略 3: 传统均衡轮询模式 (Round-Robin) ====================
        candidates.sort((a, b) => {
          if (a.activeConcurrency !== b.activeConcurrency) {
            return a.activeConcurrency - b.activeConcurrency;
          }
          return a.lastUsedAt - b.lastUsedAt;
        });
        chosen = candidates[0];
      }

    }

    // Each family binds once, including when it shares the sibling's account.
    if (sessionKey && !existingBinding) {
      this.sessionBindings.set(this.sessionBindingKey(sessionKey, requiredFamily), { sessionKey, family: requiredFamily,
        accountId: chosen.id, lastUsedAt: now,
        version: ++this.bindingVersion, generationStarted: false });
      console.info('[Scheduler] bound root=' + crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0, 12)
        + ' family=' + (requiredFamily ?? 'any') + ' account=' + chosen.id + ' reason=new_placement');
    }
    chosen.activeConcurrency++;
    chosen.lastUsedAt = now;
    chosen.totalRequests++;
    this.totalRequestsServed++;

    return chosen;
  }

  /**
   * 释放借出的账号，并处理错误与状态更新
   */
  public releaseAccount(
    accId: string,
    error?: { code: number; message: string; retryAfterMs?: number; recoverable?: boolean },
    family?: 'claude' | 'gemini',
    sessionKey?: string,
    bindingVersion?: number
  ): void {
    const acc = this.accounts.get(accId);
    if (!acc) return;

    acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1);
    queueMicrotask(() => this.drainQueue());
    // A completed request proves the account is usable again: clear the
    // escalation counter used for unrecognised 403s.
    if (!error) acc.forbiddenCount = 0;

    if (error) {
      acc.failedRequests++;
      acc.lastError = `[HTTP ${error.code}] ${error.message}`;
      // A late 429 from a request that was already in flight must not downgrade
      // an account that has since been judged terminal back into a recoverable
      // state (cooldown expires by itself, dead does not).
      const isTerminal = acc.status === 'dead' || acc.status === 'disabled';

      if (error.code === 429) {
        acc.rateLimitHits = (acc.rateLimitHits ?? 0) + 1;
        acc.lastRateLimitAt = Date.now();
        // Only a quota exhaustion response may affect one model family.
        // A plain rate-limit response must cool the whole account.
        const isQuotaExhausted = classifyUpstreamError(error.code, error.message).kind === 'quota';
        const retryMs = error.retryAfterMs ?? retryAfterMs(undefined, error.message, 60 * 1000);
        if (isQuotaExhausted && family) {
          const resetTime = family === 'claude' ? acc.quota?.claudeResetTime : acc.quota?.geminiResetTime;
          const waitMs = Date.parse(resetTime || '') > Date.now() ? retryMs : Math.max(retryMs, 3 * 60_000);
          acc.quotaBlockedUntil = { ...acc.quotaBlockedUntil,
            // Keep the previous three-minute probe floor without inventing a
            // quota reset timestamp. Polling cannot confirm recovery sooner.
            [family]: Math.max(acc.quotaBlockedUntil?.[family] ?? 0, Date.now() + waitMs) };
        }

        if (isTerminal) {
          reconcileQuotaState(acc);
          console.warn(`[CircuitBreaker] 账号 ${acc.email} 已处于终态 (${acc.status})，忽略其迟到请求的 429，不会自动复活。`);
          this.clearSessionBinding(sessionKey, accId, bindingVersion, family, 'terminal_429');
          this.saveAccounts();
          return;
        }

        if (isQuotaExhausted && family === 'claude') {
          // Keep the effective balance at zero until the rejection expires.
          if (acc.quota) {
            acc.quota.claude5hFraction = 0.0;
          }
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Claude/GPT 额度受限，已暂停该家族调度，账号保持 Active 供 Gemini 继续使用。`);
        } else if (isQuotaExhausted && family === 'gemini') {
          if (acc.quota) {
            acc.quota.gemini5hFraction = 0.0;
          }
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Gemini 额度受限，已暂停该家族调度，账号保持 Active 供 Claude 继续使用。`);
        } else {
          // 通用 RPM 频率限制（非特定模型额度用尽），遵守上游给出的冷却时间。
          // 取最大值：并发返回的多个 429 不能用一个更短的窗口覆盖更长的冷却。
          acc.status = 'cooldown';
          acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + retryMs);
          console.warn(`[CircuitBreaker] 账号 ${acc.email} 触发通用 429 限频，进入冷却 ${Math.ceil(retryMs / 1000)} 秒。`);
        }

        const claudeUsable = hasFamilyQuota(acc, 'claude');
        const geminiUsable = hasFamilyQuota(acc, 'gemini');
        if (!claudeUsable && !geminiUsable && !isTerminal) {
          const now = Date.now();
          const claudeReset = Date.parse(acc.quota?.claudeResetTime || '') || Date.parse(acc.quota?.claudeWeeklyResetTime || '') || (now + retryMs);
          const geminiReset = Date.parse(acc.quota?.geminiResetTime || '') || Date.parse(acc.quota?.geminiWeeklyResetTime || '') || (now + retryMs);
          const earliestReset = Math.min(
            claudeReset > now ? claudeReset : Infinity,
            geminiReset > now ? geminiReset : Infinity
          );
          const cooldownTime = Number.isFinite(earliestReset) ? earliestReset : now + Math.max(retryMs, 5 * 60_000);
          acc.status = 'cooldown';
          acc.cooldownUntil = Math.max(acc.cooldownUntil, cooldownTime);
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Claude 与 Gemini 双额度均已耗尽，已自动进入冷却状态，预计冷却至 ${new Date(cooldownTime).toLocaleTimeString()}。`);
        }

        reconcileQuotaState(acc);
        this.saveAccounts();

        // 只清理触发此次失败的会话。一个账号上的其他会话不能因为
        // 某个模型或某个会话的 429 全部失去粘性。
        this.clearSessionBinding(sessionKey, accId, bindingVersion, family, isQuotaExhausted ? 'quota_429' : 'rate_limit_429');
      } else if (error.code === 401) {
        if (error.recoverable) {
          // A freshly minted token was rejected (auth replication lag, a
          // hiccup on Google's side). Park the account instead of killing it:
          // a repeated offender still escalates to dead below.
          const strikes = (acc.forbiddenCount ?? 0) + 1;
          acc.forbiddenCount = strikes;
          if (strikes >= 3) {
            acc.status = 'dead';
            acc.lastError = `[UNAUTHORIZED_REPEATED] ${error.message}`;
            console.error(`[CircuitBreaker] Account ${acc.email} 连续 ${strikes} 次拒绝新 token，已隔离。`);
          } else {
            const parkedMs = Math.max(error.retryAfterMs ?? 0, 15 * 60 * 1000 * strikes);
            acc.status = 'cooldown';
            acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + parkedMs);
            console.warn(`[CircuitBreaker] Account ${acc.email} 第 ${strikes} 次拒绝新 token，停车 ${Math.ceil(parkedMs / 60000)} 分钟。`);
          }
        } else {
          // 凭证失效。只允许上层执行一次刷新，失败后账号保持隔离，不能在后台循环重试。
          acc.status = 'dead';
          console.warn(`[CircuitBreaker] Account ${acc.email} returned 401 and was isolated until manual re-authentication.`);
        }
        this.clearSessionBinding(sessionKey, accId, bindingVersion, family, 'authentication_401');
        this.saveAccounts();
      } else if (error.code === 403) {
        const classified = classifyUpstreamError(error.code, error.message);
        if (classified.kind === 'policy_blocked') {
          acc.status = 'dead';
          acc.lastError = `[POLICY_BLOCKED] ${error.message}`;
          console.error(`[CircuitBreaker] Account ${acc.email} marked as POLICY_BLOCKED; automatic retries are disabled.`);
          this.clearSessionBinding(sessionKey, accId, bindingVersion, family, 'policy_403');
          this.saveAccounts();
          return;
        }
        if (error.recoverable) {
          // Unknown/recoverable 403 (permission, quota-flavoured, unrecognised
          // wording). Park it, but escalate: an account that keeps answering
          // 403 must not be re-probed every cooldown window forever.
          const strikes = (acc.forbiddenCount ?? 0) + 1;
          acc.forbiddenCount = strikes;
          if (strikes >= 3) {
            acc.status = 'dead';
            acc.lastError = `[FORBIDDEN_REPEATED] ${error.message}`;
            console.error(`[CircuitBreaker] Account ${acc.email} 连续 ${strikes} 次 403，已判定为终止状态，停止继续探测。`);
          } else {
            const parkedMs = Math.max(error.retryAfterMs ?? 0, 5 * 60 * 1000 * strikes);
            acc.status = 'cooldown';
            acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + parkedMs);
            console.warn(`[CircuitBreaker] Account ${acc.email} 第 ${strikes} 次可恢复 403，停车 ${Math.ceil(parkedMs / 1000)}s。`);
          }
        } else {
          // 政策类 403 和其他权限类 403 都是终止状态。不能继续轮换账号探测。
          acc.status = 'dead';
          console.error(`[CircuitBreaker] Account ${acc.email} marked as DEAD due to 403 Forbidden.`);
        }
        this.clearSessionBinding(sessionKey, accId, bindingVersion, family, 'permission_403');
        this.saveAccounts();
      }
    }
  }

  public getStats(): PoolStats {
    const now = Date.now();
    let active = 0;
    let cooldown = 0;
    let dead = 0;
    let currentConcurrency = 0;

    for (const acc of this.accounts.values()) {
      if (acc.status === 'cooldown' && now >= acc.cooldownUntil) {
        acc.status = 'active';
      }
      const isDead = acc.status === 'dead' || acc.status === 'disabled';
      const claudeUsable = hasFamilyQuota(acc, 'claude', now);
      const geminiUsable = hasFamilyQuota(acc, 'gemini', now);
      const isExhausted = !claudeUsable && !geminiUsable;

      if (isDead) dead++;
      else if (acc.status === 'cooldown' || isExhausted) cooldown++;
      else active++;

      currentConcurrency += acc.activeConcurrency;
    }

    return {
      totalAccounts: this.accounts.size,
      activeAccounts: active,
      cooldownAccounts: cooldown,
      deadAccounts: dead,
      currentTotalConcurrency: currentConcurrency,
      totalRequestsServed: this.totalRequestsServed,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalCachedTokens: this.totalCachedTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalTokens: this.totalTokens,
      hasTokenUsage: this.hasTokenUsage,
      uptimeSeconds: Math.floor((now - this.startTime) / 1000),
      routingStrategy: this.routingStrategy
    };
  }

  public recordTokenUsage(usage: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    cacheReadInputTokenCount?: number;
    cacheCreationInputTokenCount?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    const readNumber = (...values: unknown[]) => {
      const numbers = values.map(Number).filter(Number.isFinite) as number[];
      return numbers.length ? Math.max(...numbers) : 0;
    };
    const prompt = readNumber(usage.promptTokenCount);
    const completion = readNumber(usage.candidatesTokenCount);
    const total = readNumber(usage.totalTokenCount) || prompt + completion;
    const cacheRead = readNumber(usage.cachedContentTokenCount, usage.cacheReadInputTokenCount, usage.cache_read_input_tokens);
    const cacheCreation = readNumber(usage.cacheCreationInputTokenCount, usage.cache_creation_input_tokens);
    const hasAnyUsage = [usage.promptTokenCount, usage.candidatesTokenCount, usage.totalTokenCount, usage.cachedContentTokenCount, usage.cacheReadInputTokenCount, usage.cacheCreationInputTokenCount, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].some(value => Number.isFinite(Number(value)));
    if (!hasAnyUsage) return;
    this.totalPromptTokens += prompt;
    this.totalCompletionTokens += completion;
    this.totalCachedTokens += cacheRead;
    this.totalCacheReadTokens += cacheRead;
    this.totalCacheCreationTokens += cacheCreation;
    this.totalTokens += total;
    this.hasTokenUsage = true;
  }
}
