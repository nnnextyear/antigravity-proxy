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

/** Match prompt/context exhaustion without treating output-budget or schema errors as it. */
export function isContextOverflow(statusCode: number, body: string): boolean {
  if (statusCode !== 400 && statusCode !== 413) return false;
  const fields = errorFields(body);
  return /context_length_exceeded|context_window_exceeded|prompt_too_long/i.test([fields.reason, fields.status].join(' '))
    || /prompt is too long|input is too long for requested model/i.test(fields.message || body)
    || /(?:input|prompt) token (?:count|length).{0,100}(?:exceeds?|too (?:long|large))/i.test(fields.message || body)
    || /input length and [`']?max_tokens[`']? exceed context limit/i.test(fields.message || body)
    || /(?:context (?:length|window|limit).{0,60}(?:exceed|too (?:long|large))|exceed.{0,60}context (?:length|window|limit))/i.test(fields.message || body);
}

/** Claude Code uses these native phrases to enter its context recovery path. */
export function contextOverflowMessage(body: string): string {
  const message = (errorFields(body).message || body).trim();
  if (/input length and [`']?max_tokens[`']? exceed context limit/i.test(message)) {
    return 'input length and `max_tokens` exceed context limit';
  }
  const counts = message.match(/(?:prompt is too long|input token count)[^0-9]*(\d+)\s*(?:tokens?\s*)?>\s*(\d+)/i)
    || message.match(/input token count[^0-9]*(\d+)[^0-9]+(?:maximum number of tokens|context limit)[^0-9]*(\d+)/i);
  return counts ? `prompt is too long: ${counts[1]} tokens > ${counts[2]} maximum`
    : 'prompt is too long: input exceeds the upstream model context window';
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
    // RESOURCE_EXHAUSTED is also used for short-term RPM throttling. Only
    // explicit quota signals permit an account-local quota failover.
    const kind = fields.reason?.toUpperCase() === 'QUOTA_EXHAUSTED'
      || /individual quota reached|quota (?:has been |is )?(?:exhausted|reached)/i.test(message)
      ? 'quota' : 'rate_limit';
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
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gi)];
  if (!parts.length || parts.map(part => part[0]).join('') !== trimmed) return undefined;
  return parts.reduce((sum, part) => sum + Number(part[1]) *
    ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[part[2].toLowerCase()] ?? 0), 0);
}

/** Quota resets are a lower bound even when Retry-After asks for a shorter wait. */
export function retryAfterMs(
  headers?: Record<string, unknown>,
  body?: string,
  fallbackMs = 60_000
): number {
  const headerValue = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const headerDelay = parseDelay(headerValue);
  const explicitQuota = !!body && classifyUpstreamError(429, body).kind === 'quota';
  if (headerDelay !== undefined && !explicitQuota) return Math.min(Math.max(headerDelay, 1000), 24 * 60 * 60 * 1000);

  const parsed = body ? parseJson(body) : undefined;
  const details = parsed?.error?.details || parsed?.details;
  if (Array.isArray(details)) {
    const delays = details.flatMap((detail: any) => [detail?.retryDelay, detail?.quotaResetDelay,
      detail?.metadata?.quotaResetTimeStamp, detail?.metadata?.quotaResetDelay])
      .map(parseDelay).filter((delay: number | undefined): delay is number => delay !== undefined);
    if (delays.length) return Math.min(Math.max(...delays, headerDelay ?? 0, 1000), 24 * 60 * 60 * 1000);
  }

  return Math.min(Math.max(headerDelay ?? fallbackMs, 1000), 24 * 60 * 60 * 1000);
}
