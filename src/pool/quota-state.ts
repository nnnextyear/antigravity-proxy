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

/** Expire local admission blocks without changing Google's quota snapshot. */
export function reconcileQuotaState(account: Account, now = Date.now()): void {
  for (const family of ['gemini', 'claude'] as const) {
    const blockedUntil = account.quotaBlockedUntil?.[family] ?? 0;
    if (blockedUntil && blockedUntil <= now) delete account.quotaBlockedUntil![family];
  }
}
