import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUpstreamError, retryAfterMs } from '../src/pool/error-policy.js';

test('classifies Google policy, auth, quota, and location failures separately', () => {
  const policy = classifyUpstreamError(403, JSON.stringify({
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      reason: 'TOS_VIOLATION',
      message: 'This service has been disabled in this account for violation of Terms of Service.'
    }
  }));
  assert.equal(policy.kind, 'policy_blocked');

  assert.equal(classifyUpstreamError(400, '{"error":"invalid_grant"}').kind, 'authentication');
  assert.equal(classifyUpstreamError(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}').kind, 'quota');
  assert.equal(classifyUpstreamError(429, '{"error":{"message":"rate limit exceeded"}}').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(403, 'User location is not supported').kind, 'location');
});

test('prefers Retry-After and Google retry details over the default cooldown', () => {
  assert.equal(retryAfterMs({ 'retry-after': '7' }, undefined), 7000);
  assert.equal(retryAfterMs(undefined, JSON.stringify({ error: {
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }]
  } }), 60000), 2000);
  assert.equal(retryAfterMs(undefined, undefined, 0), 1000);
});
