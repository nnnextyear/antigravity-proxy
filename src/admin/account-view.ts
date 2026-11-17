import type { Account } from '../types.js';

/** Explicit response boundary: OAuth credentials never leave account storage. */
export function publicAccount(account: Account | null | undefined) {
  if (!account) return null;
  return {
    id: account.id, email: account.email, status: account.status,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
    cooldownUntil: account.cooldownUntil, activeConcurrency: account.activeConcurrency,
    maxConcurrency: account.maxConcurrency, totalRequests: account.totalRequests,
    failedRequests: account.failedRequests, proxyUrl: account.proxyUrl,
    lastUsedAt: account.lastUsedAt, createdAt: account.createdAt,
    lastError: account.lastError, quota: account.quota, quotaBlockedUntil: account.quotaBlockedUntil,
    validationUrl: account.validationUrl, validationRequired: account.validationRequired,
    rateLimitHits: account.rateLimitHits, lastRateLimitAt: account.lastRateLimitAt,
    rateLimitStreak: account.rateLimitStreak, forbiddenCount: account.forbiddenCount,
    refreshTokenMasked: account.refreshToken ? '********' : '',
    accessTokenMasked: account.accessToken ? '********' : ''
  };
}
