import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Account, PoolStats, AccountStatus, RoutingStrategy } from '../types.js';
import { classifyUpstreamError, retryAfterMs } from './error-policy.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ACCOUNTS_FILE = path.resolve(DATA_DIR, 'accounts.json');

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
  private accounts: Map<string, Account> = new Map();
  private roundRobinCursor = 0;
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
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private routingStrategy: RoutingStrategy = 'zero-waste';
  private sessionBindings: Map<string, { accountId: string; lastUsedAt: number }> = new Map();
  private sessionCleanTimer: NodeJS.Timeout | null = null;
  private fileWatcher: fs.FSWatcher | null = null;

  constructor(initialStrategy: RoutingStrategy = 'zero-waste') {
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
        if (now - val.lastUsedAt > 60 * 60 * 1000) {
          this.sessionBindings.delete(key);
        }
      }
    }, 10 * 60 * 1000);
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private setupFileWatcher(): void {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      this.ensureDataDir();
      fs.writeFileSync(ACCOUNTS_FILE, '[]', 'utf-8');
    }

    try {
      this.fileWatcher = fs.watch(ACCOUNTS_FILE, (eventType) => {
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
    if (this.sessionCleanTimer) {
      clearInterval(this.sessionCleanTimer);
      this.sessionCleanTimer = null;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    this.fileWatcher?.close();
    this.fileWatcher = null;
  }

  public loadAccounts(): void {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      try {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        const list: Account[] = JSON.parse(raw);
        const live = this.accounts;
        const next = new Map<string, Account>();
        for (const acc of list) {
          const previous = live.get(acc.id);
          // The persisted file never carries concurrency. Zeroing it while
          // requests are in flight would stop counting them and over-admit the
          // account, so carry the in-memory lease count across the reload.
          const inFlight = previous?.activeConcurrency ?? 0;
          acc.activeConcurrency = Number.isFinite(inFlight) && inFlight > 0 ? inFlight : 0;
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
    try {
      this.isInternalSaving = true;
      const list = Array.from(this.accounts.values()).map(acc => ({
        ...acc,
        activeConcurrency: 0 // 持久化时不保留内存中的并发计数
      }));
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.error('[AccountPool] Failed to save accounts.json:', e);
    } finally {
      setTimeout(() => { this.isInternalSaving = false; }, 500);
    }
  }

  public getAllAccounts(): Account[] {
    return Array.from(this.accounts.values());
  }

  public getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  public getSessionBinding(sessionKey: string): { accountId: string; lastUsedAt: number } | undefined {
    return this.sessionBindings.get(sessionKey);
  }

  public clearSessionBinding(sessionKey: string | undefined, accountId?: string): void {
    if (!sessionKey) return;
    const binding = this.sessionBindings.get(sessionKey);
    if (!accountId || binding?.accountId === accountId) this.sessionBindings.delete(sessionKey);
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

  /**
   * 获取下一个可用的账号（支持零浪费智能调度、会话粘性防 Cache 穿透、临期抢救、流水线耗尽与故障转移）
   */
  public acquireAccount(
    excludeIds: Set<string> = new Set(),
    requiredFamily?: 'claude' | 'gemini',
    sessionKey?: string
  ): Account | null {
    const now = Date.now();
    const existingBinding = sessionKey ? this.sessionBindings.get(sessionKey) : undefined;
    if (existingBinding) {
      const boundAccount = this.accounts.get(existingBinding.accountId);
      if (!boundAccount || boundAccount.status === 'dead' || boundAccount.status === 'disabled') {
        this.sessionBindings.delete(sessionKey!);
      } else if (boundAccount.status === 'active' && !excludeIds.has(boundAccount.id) && boundAccount.activeConcurrency >= boundAccount.maxConcurrency) {
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
    const candidates: Account[] = [];

    for (const acc of this.accounts.values()) {
      if (excludeIds.has(acc.id)) continue;

      // 检查是否解除冷却
      if (acc.status === 'cooldown' && now >= acc.cooldownUntil) {
        acc.status = 'active';
        acc.cooldownUntil = 0;
        console.log(`[AccountPool] Account ${acc.email} (${acc.id}) cooldown expired, returned to active.`);
      }

      // 筛选健康且未满并发的账号
      if (acc.status === 'active' && acc.activeConcurrency < acc.maxConcurrency) {
        // 如果账号具备额度监控信息，检查对应模型组的额度是否已耗尽
        if (acc.quota && requiredFamily) {
          if (requiredFamily === 'claude') {
            const isWeeklyExhausted = (acc.quota.claudeWeeklyFraction <= 0.005);
            const is5hExhausted = (acc.quota.claude5hFraction <= 0.01);
            const resetTime = acc.quota.claudeWeeklyResetTime ? new Date(acc.quota.claudeWeeklyResetTime).getTime() : 0;
            const reset5hTime = acc.quota.claudeResetTime ? new Date(acc.quota.claudeResetTime).getTime() : 0;

            if (isWeeklyExhausted && resetTime > now) {
              continue;
            }
            if (is5hExhausted && reset5hTime > now) {
              continue;
            }
          } else if (requiredFamily === 'gemini') {
            const isWeeklyExhausted = (acc.quota.geminiWeeklyFraction <= 0.005);
            const is5hExhausted = (acc.quota.gemini5hFraction <= 0.01);
            const resetTime = acc.quota.geminiWeeklyResetTime ? new Date(acc.quota.geminiWeeklyResetTime).getTime() : 0;
            const reset5hTime = acc.quota.geminiResetTime ? new Date(acc.quota.geminiResetTime).getTime() : 0;

            if (isWeeklyExhausted && resetTime > now) {
              continue;
            }
            if (is5hExhausted && reset5hTime > now) {
              continue;
            }
          }
        }

        candidates.push(acc);
      }
    }

    // 兜底策略：只有在账号尚未拉取过额度信息 (!acc.quota) 时才允许兜底尝试，
    // 如果已知该家族额度已用尽 (如 claude5hFraction <= 0.01 且未到重置时间)，坚决不兜底送去撞 Google 429！
    if (candidates.length === 0 && requiredFamily) {
      for (const acc of this.accounts.values()) {
        if (!excludeIds.has(acc.id) && acc.status === 'active' && acc.activeConcurrency < acc.maxConcurrency) {
          if (!acc.quota) {
            candidates.push(acc);
          }
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    let chosen: Account | null = null;

    // ==================== 统一阶段 1: 会话粘性 (Pure Session Affinity - Cache First) ====================
    // 只要绑定账号仍健康且有空闲并发，就复用该账号。缓存命中率
    // 仍取决于上游 TTL、请求前缀和客户端是否提供稳定会话 ID，不能在
    // 调度层承诺固定比例。
    if (sessionKey && existingBinding) {
      const bound = existingBinding;
      const candidateAcc = candidates.find(c => c.id === bound.accountId);
      if (candidateAcc) {
        chosen = candidateAcc;
        this.sessionBindings.set(sessionKey, { accountId: chosen.id, lastUsedAt: now });
      }
    }

    // ==================== 阶段 2: 仅全新会话或旧账号满载失效时，才执行调度分配 ====================
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

      // 新会话首次分配，立刻建立强粘性绑定，锁死后续所有连续请求
      if (sessionKey) {
        this.sessionBindings.set(sessionKey, { accountId: chosen.id, lastUsedAt: now });
      }
    }

    chosen.activeConcurrency++;
    chosen.lastUsedAt = now;
    chosen.totalRequests++;
    this.totalRequestsServed++;

    return chosen;
  }

  /**
   * Quota exhaustion is remembered as a zeroed fraction plus a reset time.
   * When upstream never said when the window resets, the account would be
   * selected again on the very next request; fall back to the cooldown window.
   */
  private ensureFamilyBlockedUntil(acc: Account, family: 'claude' | 'gemini', retryMs: number): void {
    if (!acc.quota) return;
    const resetField = family === 'claude' ? 'claudeResetTime' : 'geminiResetTime';
    const current = acc.quota[resetField];
    const currentMs = current ? new Date(current).getTime() : 0;
    if (!Number.isFinite(currentMs) || currentMs <= Date.now()) {
      // Floor at the quota poll period: a shorter window would expire before
      // the next poll can confirm whether the quota really came back.
      acc.quota[resetField] = new Date(Date.now() + Math.max(retryMs, 3 * 60_000)).toISOString();
    }
  }

  /**
   * 释放借出的账号，并处理错误与状态更新
   */
  public releaseAccount(
    accId: string,
    error?: { code: number; message: string; retryAfterMs?: number; recoverable?: boolean },
    family?: 'claude' | 'gemini',
    sessionKey?: string
  ): void {
    const acc = this.accounts.get(accId);
    if (!acc) return;

    acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1);
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

        if (isTerminal) {
          console.warn(`[CircuitBreaker] 账号 ${acc.email} 已处于终态 (${acc.status})，忽略其迟到请求的 429，不会自动复活。`);
          this.clearSessionBinding(sessionKey, accId);
          this.saveAccounts();
          return;
        }

        if (isQuotaExhausted && family === 'claude') {
          // 仅 Claude / 3p 额度耗尽：精准置零 Claude 5h 额度，账号全局状态依然保持 active，Gemini 请求不受任何影响！
          if (acc.quota) {
            acc.quota.claude5hFraction = 0.0;
            // 只有 5h 分数的账号在重置时间缺失或已过期时会被立刻重新选中，
            // 于是反复撞上已耗尽的账号。补一个兜底重置时间，等下一次额度
            // 轮询给出真实时间再覆盖。
            this.ensureFamilyBlockedUntil(acc, 'claude', retryMs);
          }
          if (!acc.quota) {
            acc.status = 'cooldown';
            acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + retryMs);
          }
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Claude/GPT 5h 额度耗尽，已标记 Claude 耗尽，账号保持 Active 供 Gemini 继续使用。`);
        } else if (isQuotaExhausted && family === 'gemini') {
          if (acc.quota) {
            acc.quota.gemini5hFraction = 0.0;
            this.ensureFamilyBlockedUntil(acc, 'gemini', retryMs);
          }
          if (!acc.quota) {
            acc.status = 'cooldown';
            acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + retryMs);
          }
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Gemini 5h 额度耗尽，已标记 Gemini 耗尽，账号保持 Active 供 Claude 继续使用。`);
        } else {
          // 通用 RPM 频率限制（非特定模型额度用尽），遵守上游给出的冷却时间。
          // 取最大值：并发返回的多个 429 不能用一个更短的窗口覆盖更长的冷却。
          acc.status = 'cooldown';
          acc.cooldownUntil = Math.max(acc.cooldownUntil, Date.now() + retryMs);
          console.warn(`[CircuitBreaker] 账号 ${acc.email} 触发通用 429 限频，进入冷却 ${Math.ceil(retryMs / 1000)} 秒。`);
        }

        this.saveAccounts();

        // 只清理触发此次失败的会话。一个账号上的其他会话不能因为
        // 某个模型或某个会话的 429 全部失去粘性。
        this.clearSessionBinding(sessionKey, accId);
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
        this.clearSessionBinding(sessionKey, accId);
        this.saveAccounts();
      } else if (error.code === 403) {
        const classified = classifyUpstreamError(error.code, error.message);
        if (classified.kind === 'policy_blocked') {
          acc.status = 'dead';
          acc.lastError = `[POLICY_BLOCKED] ${error.message}`;
          console.error(`[CircuitBreaker] Account ${acc.email} marked as POLICY_BLOCKED; automatic retries are disabled.`);
          this.clearSessionBinding(sessionKey, accId);
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
        this.clearSessionBinding(sessionKey, accId);
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
      if (acc.status === 'active') active++;
      else if (acc.status === 'cooldown') cooldown++;
      else if (acc.status === 'dead') dead++;

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
