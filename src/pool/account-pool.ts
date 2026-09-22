import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Account, PoolStats, AccountStatus, RoutingStrategy } from '../types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ACCOUNTS_FILE = path.resolve(DATA_DIR, 'accounts.json');

export class AccountPool {
  private accounts: Map<string, Account> = new Map();
  private roundRobinCursor = 0;
  private startTime = Date.now();
  private totalRequestsServed = 0;
  private isInternalSaving = false;
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private routingStrategy: RoutingStrategy = 'zero-waste';
  private sessionBindings: Map<string, { accountId: string; lastUsedAt: number }> = new Map();
  private sessionCleanTimer: NodeJS.Timeout | null = null;

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
        if (now - val.lastUsedAt > 30 * 60 * 1000) {
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
      fs.watch(ACCOUNTS_FILE, (eventType) => {
        if (this.isInternalSaving) return;
        if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
        this.reloadDebounceTimer = setTimeout(() => {
          console.log('[AccountPool] Detected external change to accounts.json, reloading from disk...');
          this.loadAccounts();
        }, 300);
      });
    } catch (e: any) {
      console.error('[AccountPool] Error setting up accounts.json watcher:', e.message);
    }
  }

  public loadAccounts(): void {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      try {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        const list: Account[] = JSON.parse(raw);
        this.accounts.clear();
        for (const acc of list) {
          // 重置瞬态状态
          acc.activeConcurrency = 0;
          this.accounts.set(acc.id, acc);
        }
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

    let chosen: Account;

    if (this.routingStrategy === 'zero-waste') {
      // ==================== 策略 1: 零浪费智能融合调度 (Zero-Waste Hybrid) ====================

      // 阶段 1: 会话粘性优先 (Session Affinity) -> 保证同一会话命中 Google 上游 Prompt Cache，省下 80%~90% 上下文 Token
      let sessionStickyAccount: Account | null = null;
      if (sessionKey && this.sessionBindings.has(sessionKey)) {
        const bound = this.sessionBindings.get(sessionKey)!;
        const candidateAcc = candidates.find(c => c.id === bound.accountId);
        if (candidateAcc) {
          // 检查该粘性账号是否健康且配额没有到达警戒线 (< 3%)
          const isLowQuota = (requiredFamily === 'claude' && candidateAcc.quota && candidateAcc.quota.claude5hFraction < 0.03) ||
                             (requiredFamily === 'gemini' && candidateAcc.quota && candidateAcc.quota.gemini5hFraction < 0.03);
          if (!isLowQuota) {
            sessionStickyAccount = candidateAcc;
          }
        }
      }

      if (sessionStickyAccount) {
        chosen = sessionStickyAccount;
        this.sessionBindings.set(sessionKey!, { accountId: chosen.id, lastUsedAt: now });
      } else {
        // 阶段 2: 临期抢救优先 (Time-to-Reset Expiration Harvesting)
        // 如果有账号在 45 分钟内即将重置 5 小时额度，且目前剩余额度 > 8%，必须优先用它，防止重置清零浪费！
        const imminentCandidates = candidates.filter(acc => {
          if (!acc.quota) return false;
          const resetTimeStr = (requiredFamily === 'claude' ? acc.quota.claudeResetTime : acc.quota.geminiResetTime);
          const fraction = (requiredFamily === 'claude' ? acc.quota.claude5hFraction : acc.quota.gemini5hFraction) ?? 1;
          if (!resetTimeStr || fraction <= 0.08) return false;
          const diffMs = new Date(resetTimeStr).getTime() - now;
          return diffMs > 0 && diffMs <= 45 * 60 * 1000; // 45分钟内即将重置
        });

        if (imminentCandidates.length > 0) {
          // 临近重置者中，剩余时间最近且额度最多的优先
          imminentCandidates.sort((a, b) => {
            const timeA = new Date(requiredFamily === 'claude' ? a.quota!.claudeResetTime! : a.quota!.geminiResetTime!).getTime();
            const timeB = new Date(requiredFamily === 'claude' ? b.quota!.claudeResetTime! : b.quota!.geminiResetTime!).getTime();
            if (Math.abs(timeA - timeB) > 5 * 60 * 1000) return timeA - timeB; // 时间差大于5分钟，先救最近的
            const fracA = (requiredFamily === 'claude' ? a.quota!.claude5hFraction : a.quota!.gemini5hFraction) ?? 0;
            const fracB = (requiredFamily === 'claude' ? b.quota!.claude5hFraction : b.quota!.gemini5hFraction) ?? 0;
            return fracB - fracA; // 额度多的先用
          });
          chosen = imminentCandidates[0];
          console.log(`[AccountPool] 🎯 [Zero-Waste 临期抢救] 优先调度账号 ${chosen.email} (5h额度即将重置，抢救剩余额度)`);
        } else {
          // 阶段 3: 流水线深度耗尽 (Sequential Pipeline)
          // 优先集中消耗当前的主力活跃账号（最近 15 分钟内被活跃调用的账号），直到其 5h 额度用透再切下一个，让前序账号拥有完整的 5 小时回满时间！
          candidates.sort((a, b) => {
            // 首先排除周额度极度危险的账号（< 3%）
            const aWeekly = (requiredFamily === 'claude' ? a.quota?.claudeWeeklyFraction : a.quota?.geminiWeeklyFraction) ?? 1;
            const bWeekly = (requiredFamily === 'claude' ? b.quota?.claudeWeeklyFraction : b.quota?.geminiWeeklyFraction) ?? 1;
            if (aWeekly <= 0.03 && bWeekly > 0.03) return 1;
            if (bWeekly <= 0.03 && aWeekly > 0.03) return -1;

            // 优先锁定当前主力号（最近有活跃使用 且 5h 剩余 > 5% 且并发未饱和）
            const aIsActiveDrain = (now - a.lastUsedAt < 15 * 60 * 1000) && ((requiredFamily === 'claude' ? a.quota?.claude5hFraction : a.quota?.gemini5hFraction) ?? 1) > 0.05;
            const bIsActiveDrain = (now - b.lastUsedAt < 15 * 60 * 1000) && ((requiredFamily === 'claude' ? b.quota?.claude5hFraction : b.quota?.gemini5hFraction) ?? 1) > 0.05;

            if (aIsActiveDrain && !bIsActiveDrain) return -1;
            if (bIsActiveDrain && !aIsActiveDrain) return 1;

            // 多个同类候选时，优先并发小的
            if (a.activeConcurrency !== b.activeConcurrency) {
              return a.activeConcurrency - b.activeConcurrency;
            }

            // 5h 额度充裕的优先接棒
            const a5h = (requiredFamily === 'claude' ? a.quota?.claude5hFraction : a.quota?.gemini5hFraction) ?? 1;
            const b5h = (requiredFamily === 'claude' ? b.quota?.claude5hFraction : b.quota?.gemini5hFraction) ?? 1;
            return b5h - a5h;
          });
          chosen = candidates[0];
        }

        // 建立新的会话粘性
        if (sessionKey) {
          this.sessionBindings.set(sessionKey, { accountId: chosen.id, lastUsedAt: now });
        }
      }

    } else if (this.routingStrategy === 'sequential-drain') {
      // ==================== 策略 2: 流水线顺序耗尽模式 (Sequential Drain) ====================
      // 严格按照账号列表顺序，打满一个再切下一个
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

    chosen.activeConcurrency++;
    chosen.lastUsedAt = now;
    chosen.totalRequests++;
    this.totalRequestsServed++;

    return chosen;
  }

  /**
   * 释放借出的账号，并处理错误与状态更新
   */
  public releaseAccount(accId: string, error?: { code: number; message: string }, family?: 'claude' | 'gemini'): void {
    const acc = this.accounts.get(accId);
    if (!acc) return;

    acc.activeConcurrency = Math.max(0, acc.activeConcurrency - 1);

    if (error) {
      acc.failedRequests++;
      acc.lastError = `[HTTP ${error.code}] ${error.message}`;

      if (error.code === 429) {
        // 判断是否属于特定模型族的额度用尽 (如 RESOURCE_EXHAUSTED / Quota exceeded / limit)
        const errMsg = error.message.toLowerCase();
        const isQuotaExhausted = errMsg.includes('resource_exhausted') ||
                                 errMsg.includes('quota') ||
                                 errMsg.includes('exhausted') ||
                                 errMsg.includes('limit');

        if (isQuotaExhausted && family === 'claude') {
          // 仅 Claude / 3p 额度耗尽：精准置零 Claude 5h 额度，账号全局状态依然保持 active，Gemini 请求不受任何影响！
          if (acc.quota) {
            acc.quota.claude5hFraction = 0.0;
          }
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Claude/GPT 5h 额度耗尽，已标记 Claude 耗尽，账号保持 Active 供 Gemini 继续使用。`);
        } else if (isQuotaExhausted && family === 'gemini') {
          if (acc.quota) {
            acc.quota.gemini5hFraction = 0.0;
          }
          console.warn(`[CircuitBreaker] 账号 ${acc.email} Gemini 5h 额度耗尽，已标记 Gemini 耗尽，账号保持 Active 供 Claude 继续使用。`);
        } else {
          // 通用 RPM 频率限制（非特定模型额度用尽），账号进入 60 秒常规冷却
          acc.status = 'cooldown';
          acc.cooldownUntil = Date.now() + 60 * 1000;
          console.warn(`[CircuitBreaker] 账号 ${acc.email} 触发通用 429 限频，进入冷却 60 秒。`);
        }

        this.saveAccounts();

        // 清理绑定在该账号上的会话粘性，使后续请求自动平滑漂移至健康备用账号
        for (const [sKey, binding] of this.sessionBindings.entries()) {
          if (binding.accountId === accId) {
            this.sessionBindings.delete(sKey);
          }
        }
      } else if (error.code === 401) {
        // 凭证过期，需刷新
        console.warn(`[CircuitBreaker] Account ${acc.email} returned 401, token will be refreshed.`);
      } else if (error.code === 403) {
        // 权限或封禁，标记为 dead
        acc.status = 'dead';
        console.error(`[CircuitBreaker] Account ${acc.email} marked as DEAD due to 403 Forbidden.`);
        for (const [sKey, binding] of this.sessionBindings.entries()) {
          if (binding.accountId === accId) {
            this.sessionBindings.delete(sKey);
          }
        }
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
      uptimeSeconds: Math.floor((now - this.startTime) / 1000),
      routingStrategy: this.routingStrategy
    };
  }
}
