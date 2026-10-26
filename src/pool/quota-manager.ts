import { request } from 'undici';
import { Account, AccountQuota, AppConfig } from '../types.js';
import { AccountPool } from './account-pool.js';
import { getOrCreateDispatcher } from './dispatcher.js';
import { isPolicyBlockedError, retryAfterMs } from './error-policy.js';
import { jittered } from './transport.js';

/** How often a validation-flagged account is re-probed before giving up. */
const VALIDATION_RECHECK_MS = 30 * 60 * 1000;

function parseFraction(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000 : undefined;
}

export interface QuotaPollGate {
  /** Timestamp until which the quota endpoint asked us to stay away. */
  pausedUntil?: number;
  /** Last time we actually tried to poll this account. */
  lastAttemptAt?: number;
  /** Operator-initiated refresh: bypasses cooldown/pause/validation waits. */
  force?: boolean;
}

/**
 * Background quota polling must never touch an account the request path is
 * deliberately resting: dead/disabled accounts, accounts inside their 429
 * cooldown, accounts the quota endpoint asked us to pause, and accounts whose
 * token is stale.
 *
 * A validation-flagged account is the exception: its flag is only ever cleared
 * by a successful poll, so skipping it forever would freeze its quota forever.
 * Re-probe it on a slow cadence instead.
 */
export function shouldPollQuota(acc: Account, now: number, gate: QuotaPollGate = {}): boolean {
  if (acc.status === 'dead' || acc.status === 'disabled') return false;
  if (!gate.force) {
    if (acc.status === 'cooldown' && now < acc.cooldownUntil) return false;
    if (now < (gate.pausedUntil ?? 0)) return false;
    if (acc.validationUrl && now - (gate.lastAttemptAt ?? 0) < VALIDATION_RECHECK_MS) return false;
  }
  if (!acc.accessToken || now >= acc.accessTokenExpiresAt) return false;
  return true;
}

export class QuotaManager {
  private pollTimer: NodeJS.Timeout | null = null;
  private quotaInFlight = new Map<string, Promise<AccountQuota | null>>();
  private quotaLastAttemptAt = new Map<string, number>();
  /** Per-account quiet period requested by the quota endpoint itself. */
  private quotaPausedUntil = new Map<string, number>();
  private sweepRunning = false;
  private sweepPromise: Promise<void> | null = null;
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
        const effectiveProxy = account.proxyUrl || this.config?.defaultProxyUrl;
    let res: any;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const dispatcher = effectiveProxy ? getOrCreateDispatcher(effectiveProxy, { timeoutMs: 30000 }) : undefined;
        // Antigravity 配额查询端点
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
          await new Promise(r => setTimeout(r, jittered(1500)));
          continue;
        }
        console.warn(`[QuotaManager] Network error fetching quota for ${account.email} (transient socket drop, will retry next cycle):`, err.message);
        return null;
      }
    }

      if (res.statusCode !== 200) {
        let errText = '';
        try {
          errText = await res.body.text();
        } catch {
          errText = '';
        }
        console.warn(`[QuotaManager] Failed to fetch quota for ${account.email} (HTTP ${res.statusCode}): ${errText.substring(0, 100)}`);
        // Honour the endpoint's own pacing signal instead of coming back at a
        // fixed 3-minute cadence against an account it just throttled.
        if (res.statusCode === 429 || res.statusCode === 503) {
          const delay = retryAfterMs(
            res.headers as Record<string, unknown>,
            errText,
            (this.config?.cooldownSeconds ?? 60) * 1000
          );
          this.quotaPausedUntil.set(account.id, Date.now() + delay);
          console.warn(`[QuotaManager] Quota endpoint throttled ${account.email}; pausing quota polling for ${Math.ceil(delay / 1000)}s.`);
          return null;
        }
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

      let geminiWeekly: number | undefined;
      let gemini5h: number | undefined;
      let geminiResetTime = '';
      let geminiWeeklyResetTime = '';
      let gemini5hDesc = '';
      let geminiWeeklyDesc = '';

      let claudeWeekly: number | undefined;
      let claude5h: number | undefined;
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
              geminiWeekly = parseFraction(b.remainingFraction);
              if (b.resetTime) geminiWeeklyResetTime = b.resetTime;
              if (b.description) geminiWeeklyDesc = b.description;
            }
            if (b.window === '5h' || b.bucketId === 'gemini-5h') {
              gemini5h = parseFraction(b.remainingFraction);
              if (b.resetTime) geminiResetTime = b.resetTime;
              if (b.description) gemini5hDesc = b.description;
            }
          }
        } else if (dName.includes('claude') || dName.includes('gpt')) {
          for (const b of buckets) {
            if (b.window === 'weekly' || b.bucketId === '3p-weekly') {
              claudeWeekly = parseFraction(b.remainingFraction);
              if (b.resetTime) claudeWeeklyResetTime = b.resetTime;
              if (b.description) claudeWeeklyDesc = b.description;
            }
            if (b.window === '5h' || b.bucketId === '3p-5h') {
              claude5h = parseFraction(b.remainingFraction);
              if (b.resetTime) claudeResetTime = b.resetTime;
              if (b.description) claude5hDesc = b.description;
            }
          }
        }
      }

      // 当周额度耗尽时，上游 5h 限额暂停适用（upstream 返回 "the 5-hour limit does not currently apply"）
      // 此时可用 5h 额度实质归零，不能将未经调用的 5h 剩余量当作 100% 满格展示或调度
      if (geminiWeekly === 0) {
        gemini5h = 0;
      }
      if (claudeWeekly === 0) {
        claude5h = 0;
      }

      const quota: AccountQuota = {
        geminiWeeklyFraction: geminiWeekly,
        gemini5hFraction: gemini5h,
        geminiResetTime: geminiResetTime || undefined,
        geminiWeeklyResetTime: geminiWeeklyResetTime || undefined,
        gemini5hDesc: gemini5hDesc || undefined,
        geminiWeeklyDesc: geminiWeeklyDesc || undefined,
        claudeWeeklyFraction: claudeWeekly,
        claude5hFraction: claude5h,
        claudeResetTime: claudeResetTime || undefined,
        claudeWeeklyResetTime: claudeWeeklyResetTime || undefined,
        claude5hDesc: claude5hDesc || undefined,
        claudeWeeklyDesc: claudeWeeklyDesc || undefined,
        lastCheckedAt: Date.now()
      };

      // A file reload can replace the account object while this poll is in flight.
      // Commit against live state so a new quota rejection cannot be overwritten.
      const current = this.pool.getAccount(account.id);
      if (!current) return null;
      const now = Date.now();
      const claudeEmpty = ((quota.claude5hFraction ?? 1) <= 0.01 && Date.parse(quota.claudeResetTime || '') > now)
        || ((quota.claudeWeeklyFraction ?? 1) <= 0.005 && Date.parse(quota.claudeWeeklyResetTime || '') > now);
      const geminiEmpty = ((quota.gemini5hFraction ?? 1) <= 0.01 && Date.parse(quota.geminiResetTime || '') > now)
        || ((quota.geminiWeeklyFraction ?? 1) <= 0.005 && Date.parse(quota.geminiWeeklyResetTime || '') > now);
      let newStatus = current.status;
      let newCooldownUntil = current.cooldownUntil;
      if (current.status !== 'dead' && current.status !== 'disabled') {
        if (claudeEmpty && geminiEmpty) {
          const resets = [quota.claudeResetTime, quota.claudeWeeklyResetTime, quota.geminiResetTime, quota.geminiWeeklyResetTime]
            .map(t => Date.parse(t || '')).filter(t => Number.isFinite(t) && t > now);
          const earliest = resets.length ? Math.min(...resets) : now + 5 * 60_000;
          newStatus = 'cooldown';
          newCooldownUntil = Math.max(newCooldownUntil, earliest);
        } else if (current.status === 'cooldown' && (!claudeEmpty || !geminiEmpty) && now >= current.cooldownUntil) {
          newStatus = 'active';
          newCooldownUntil = 0;
        }
      }
      const preserveReason = current.status === 'dead' || current.status === 'disabled'
        || Object.values(current.quotaBlockedUntil ?? {}).some(until => until > Date.now());
      const updated = this.pool.updateAccount(account.id, {
        quota,
        validationUrl: undefined,
        status: newStatus,
        cooldownUntil: newCooldownUntil,
        ...(preserveReason ? {} : { lastError: undefined })
      });
      return updated?.quota ?? null;
    } catch (err: any) {
      console.error(`[QuotaManager] Error fetching quota for ${account.email}:`, err.message);
      return null;
    }
  }

  /**
   * 刷新账号池内所有活跃账号的额度
   *
   * A background tick must not overlap the previous sweep (that would probe
   * every account far more often than the nominal interval), but an explicit
   * operator refresh must never be silently dropped: it waits for the running
   * sweep and then runs its own pass.
   */
  public async fetchAllQuotas(options: { forceRefresh?: boolean } = {}): Promise<{ ran: boolean }> {
    if (this.sweepRunning) {
      await this.sweepPromise?.catch(() => {});
      if (!options.forceRefresh) {
        console.log('[QuotaManager] Previous quota sweep still running; skipping this tick.');
        return { ran: false };
      }
    }
    const sweep = this.runSweep(options);
    this.sweepPromise = sweep;
    try {
      await sweep;
      return { ran: true };
    } finally {
      if (this.sweepPromise === sweep) this.sweepPromise = null;
    }
  }

  private async runSweep(options: { forceRefresh?: boolean }): Promise<void> {
    this.sweepRunning = true;
    try {
      for (const acc of this.pool.getAllAccounts()) {
        // Re-read the clock per account: a long pool sweep must notice an
        // account that went into cooldown (or lost its token) mid-sweep.
        const now = Date.now();
        if (!shouldPollQuota(acc, now, {
          pausedUntil: this.quotaPausedUntil.get(acc.id) ?? 0,
          lastAttemptAt: this.quotaLastAttemptAt.get(acc.id) ?? acc.quota?.lastCheckedAt ?? 0,
          force: options.forceRefresh
        })) continue;
        await this.fetchQuotaForAccount(acc, options);
        // 适度防抖
        await new Promise(r => setTimeout(r, jittered(600)));
      }
    } finally {
      this.sweepRunning = false;
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
