export type UpstreamErrorKind =
  | 'policy_blocked'
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'location'
  | 'transient'
  | 'invalid_request'
  | 'unknown';

export interface ClassifiedUpstreamError {
  kind: UpstreamErrorKind;
  reason?: string;
  message: string;
}

function parseJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function errorFields(body: string): { reason?: string; message?: string; status?: string } {
  const parsed = parseJson(body);
  const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const details = Array.isArray(error?.details) ? error.details : [];
  const info = details.find((item: any) => item && typeof item === 'object' && item.reason) || {};
  return {
    reason: error?.reason || info.reason,
    message: error?.message || parsed?.error_description || parsed?.message,
    status: error?.status || parsed?.status
  };
}

export function isLocationError(statusCode: number, body: string): boolean {
  return (statusCode === 400 || statusCode === 403) && (
    /user location is not supported/i.test(body) ||
    /location is not supported/i.test(body) ||
    /not (?:available|supported) in your country/i.test(body) ||
    /unsupported country/i.test(body) ||
    (/failed_precondition/i.test(body) && /location/i.test(body))
  );
}

/** Upstream reasons that mean "this account is finished", not "retry later". */
const TERMINAL_POLICY_REASONS = new Set([
  'TOS_VIOLATION',
  'POLICY_VIOLATION',
  'SUSPENDED_ACCOUNT',
  'USER_SUSPENDED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_SUSPENDED',
  'ABUSE_DETECTED'
]);

/**
 * Account-level terminations arrive as 403 with a handful of shapes. Missing
 * one means the background workers keep probing an account Google has already
 * switched off, so err on the side of recognising more of them.
 */
export function isPolicyBlockedError(statusCode: number, body: string): boolean {
  if (statusCode !== 403) return false;
  const fields = errorFields(body);
  if (fields.reason && TERMINAL_POLICY_REASONS.has(fields.reason.toUpperCase())) return true;
  return /service has been disabled in this account/i.test(body) ||
    /violation of terms of service/i.test(body) ||
    /(?:this |the )account has been (?:suspended|disabled|terminated|deactivated)/i.test(body) ||
    /account (?:is )?(?:suspended|disabled|terminated)/i.test(body);
}

export function isInvalidGrantError(statusCode: number, body: string): boolean {
  return statusCode === 400 && /invalid_grant/i.test(body);
}

export function classifyUpstreamError(statusCode: number, body: string): ClassifiedUpstreamError {
  const fields = errorFields(body);
  const message = fields.message || body.slice(0, 1000);

  if (isPolicyBlockedError(statusCode, body)) {
    return { kind: 'policy_blocked', reason: fields.reason || 'TOS_VIOLATION', message };
  }
  if (isLocationError(statusCode, body)) {
    return { kind: 'location', reason: fields.reason, message };
  }
  if (statusCode === 401 || isInvalidGrantError(statusCode, body)) {
    return { kind: 'authentication', reason: fields.reason || (isInvalidGrantError(statusCode, body) ? 'invalid_grant' : undefined), message };
  }
  if (statusCode === 429) {
    const lower = body.toLowerCase();
    const kind = /quota|resource_exhausted|exhausted/i.test(lower) ? 'quota' : 'rate_limit';
    return { kind, reason: fields.reason, message };
  }
  if (statusCode === 408 || statusCode === 425 || statusCode >= 500) {
    return { kind: 'transient', reason: fields.reason, message };
  }
  if (statusCode >= 400 && statusCode < 500) {
    return { kind: 'invalid_request', reason: fields.reason, message };
  }
  return { kind: 'unknown', reason: fields.reason, message };
}

function parseDelay(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return Math.max(0, amount * multiplier);
}

/** Prefer upstream retry hints; cap them so a malformed response cannot block forever. */
export function retryAfterMs(
  headers?: Record<string, unknown>,
  body?: string,
  fallbackMs = 60_000
): number {
  const headerValue = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const headerDelay = parseDelay(headerValue);
  if (headerDelay !== undefined) return Math.min(Math.max(headerDelay, 1000), 24 * 60 * 60 * 1000);

  const parsed = body ? parseJson(body) : undefined;
  const details = parsed?.error?.details || parsed?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const delay = parseDelay(detail?.retryDelay ?? detail?.quotaResetDelay);
      if (delay !== undefined) return Math.min(Math.max(delay, 1000), 24 * 60 * 60 * 1000);
    }
  }

  return Math.min(Math.max(fallbackMs, 1000), 24 * 60 * 60 * 1000);
}
