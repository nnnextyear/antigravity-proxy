import type { Account } from '../types.js';

export type ModelFamily = 'claude' | 'gemini';
export type SchedulingReason = 'account_busy' | 'queue_full' | 'queue_timeout' | 'quota_exhausted' | 'rate_limited' | 'unavailable';

/** Local admission errors are distinct from a decision returned by Google. */
export class AccountSchedulingError extends Error {
  readonly statusCode = 503;
  constructor(public readonly code: SchedulingReason, message: string, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'AccountSchedulingError';
  }
}

export interface AccountAcquireOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAccountQueue?: number;
  maxConversationQueue?: number;
  maxTotalQueue?: number;
  requestId?: string;
}

export function hasFamilyQuota(account: Account, family?: ModelFamily, now = Date.now()): boolean {
  if (family && (account.quotaBlockedUntil?.[family] ?? 0) > now) return false;
  if (!family || !account.quota) return true;
  const quota = account.quota;
  const weekly = family === 'claude' ? quota.claudeWeeklyFraction : quota.geminiWeeklyFraction;
  const short = family === 'claude' ? quota.claude5hFraction : quota.gemini5hFraction;
  const weeklyReset = family === 'claude' ? quota.claudeWeeklyResetTime : quota.geminiWeeklyResetTime;
  const shortReset = family === 'claude' ? quota.claudeResetTime : quota.geminiResetTime;
  // Small positive balances are still usable; only an exhausted window or
  // an explicit upstream rejection may displace an established conversation.
  return !((weekly ?? 1) <= 0 && Date.parse(weeklyReset || '') > now)
    && !((short ?? 1) <= 0 && Date.parse(shortReset || '') > now);
}

export function accountUnavailableError(accounts: Account[], family: ModelFamily, excludeIds = new Set<string>()): AccountSchedulingError {
  const now = Date.now();
  const healthy = accounts.filter(account => !excludeIds.has(account.id)
    && (account.status === 'active' || (account.status === 'cooldown' && account.cooldownUntil <= now)));
  if (healthy.some(account => hasFamilyQuota(account, family, now))) {
    return new AccountSchedulingError('account_busy', '可用账号当前并发或等待队列已满，请稍后重试。');
  }
  if (healthy.length > 0 && healthy.every(account => !hasFamilyQuota(account, family, now))) {
    const readyAt = healthy.map(account => {
      const quota = account.quota;
      const weekly = family === 'claude' ? quota?.claudeWeeklyFraction : quota?.geminiWeeklyFraction;
      const short = family === 'claude' ? quota?.claude5hFraction : quota?.gemini5hFraction;
      const weeklyReset = family === 'claude' ? quota?.claudeWeeklyResetTime : quota?.geminiWeeklyResetTime;
      const shortReset = family === 'claude' ? quota?.claudeResetTime : quota?.geminiResetTime;
      return Math.max(account.quotaBlockedUntil?.[family] ?? 0,
        (weekly ?? 1) <= 0 ? Date.parse(weeklyReset || '') || 0 : 0,
        (short ?? 1) <= 0 ? Date.parse(shortReset || '') || 0 : 0);
    });
    return new AccountSchedulingError('quota_exhausted', '当前可选账号的 ' + family + ' 额度已耗尽，请等待额度恢复。',
      Math.max(1, Math.ceil((Math.min(...readyAt) - now) / 1000)));
  }
  return new AccountSchedulingError('unavailable', '当前没有可用账号：账号可能处于冷却、禁用、认证失败或本次重试已排除的状态。');
}
