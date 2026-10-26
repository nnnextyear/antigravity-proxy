import type { Account } from '../types.js';

/** Older versions persisted retry deadlines in the 5h reset field. Unknown is
 * safer than repeating that claim; the next quota poll supplies the real reset. */
export function clearLegacyQuotaResetTimes(account: Account): void {
  if (!account.quota) return;
  for (const family of ['gemini', 'claude'] as const) {
    const resetField = family === 'claude' ? 'claudeResetTime' : 'geminiResetTime';
    const blockedUntil = account.quotaBlockedUntil?.[family];
    // ISO timestamps retain milliseconds; retry delays can contain fractions.
    if (blockedUntil && Math.abs(Date.parse(account.quota[resetField] || '') - blockedUntil) < 1) {
      account.quota = { ...account.quota, [resetField]: undefined };
    }
  }
}

/** An explicit quota rejection remains authoritative until its recovery time. */
export function reconcileQuotaState(account: Account, now = Date.now()): void {
  if (!account.quota) return;
  for (const family of ['gemini', 'claude'] as const) {
    const blockedUntil = account.quotaBlockedUntil?.[family] ?? 0;
    const weeklyField = family === 'claude' ? 'claudeWeeklyFraction' : 'geminiWeeklyFraction';
    const weeklyResetField = family === 'claude' ? 'claudeWeeklyResetTime' : 'geminiWeeklyResetTime';
    const weekly = account.quota[weeklyField];
    const weeklyReset = account.quota[weeklyResetField];
    const fractionField = family === 'claude' ? 'claude5hFraction' : 'gemini5hFraction';

    // 当周额度耗尽且重置时间在未来时，上游 5h 限额暂停适用，有效可用 5h 水位实质归零
    const isWeeklyBlocked = weekly === 0 && (!weeklyReset || Date.parse(weeklyReset) > now);
    if (blockedUntil > now || isWeeklyBlocked) {
      // Clone the snapshot: callers may still hold the poll response object.
      // A retry deadline is not the upstream's 5h quota reset time. Keep it in
      // quotaBlockedUntil so dashboards never mistake a daily/weekly block for 5h.
      account.quota = { ...account.quota, [fractionField]: 0 };
    }
  }
}
