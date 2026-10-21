import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUpstreamError, contextOverflowMessage, isContextOverflow, retryAfterMs } from '../src/pool/error-policy.js';

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
  assert.equal(classifyUpstreamError(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(429, '{"error":{"message":"Resource has been exhausted"}}').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(429, '{"error":{"message":"Individual quota reached"}}').kind, 'quota');
  assert.equal(classifyUpstreamError(429, JSON.stringify({ error: { details: [{ reason: 'QUOTA_EXHAUSTED' }] } })).kind, 'quota');
  assert.equal(classifyUpstreamError(429, '{"error":{"message":"rate limit exceeded"}}').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(403, 'User location is not supported').kind, 'location');
});

test('context exhaustion maps to Claude Code native recovery phrases without confusing output limits', () => {
  const google = JSON.stringify({ error: { message: 'The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).' } });
  assert.equal(isContextOverflow(400, google), true);
  assert.equal(contextOverflowMessage(google), 'prompt is too long: 1050000 tokens > 1048576 maximum');
  assert.equal(isContextOverflow(400, '{"error":{"reason":"CONTEXT_LENGTH_EXCEEDED"}}'), true);
  assert.equal(isContextOverflow(413, 'prompt is too long'), true);
  assert.equal(isContextOverflow(400, 'Input is too long for requested model'), true);
  assert.equal(isContextOverflow(400, 'input length and `max_tokens` exceed context limit'), true);
  assert.equal(contextOverflowMessage('input length and `max_tokens` exceed context limit'), 'input length and `max_tokens` exceed context limit');
  assert.equal(isContextOverflow(400, 'maxOutputTokens exceeds maximum number of tokens allowed'), false);
  assert.equal(isContextOverflow(400, 'Invalid tool schema: maximum number of tokens allowed'), false);
  assert.equal(isContextOverflow(429, 'prompt is too long'), false);
});

test('prefers Retry-After and Google retry details over the default cooldown', () => {
  assert.equal(retryAfterMs({ 'retry-after': '7' }, undefined), 7000);
  assert.equal(retryAfterMs(undefined, JSON.stringify({ error: {
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }]
  } }), 60000), 2000);
  assert.equal(retryAfterMs(undefined, undefined, 0), 1000);
  const quotaBody = JSON.stringify({ error: { message: 'Individual quota reached', details: [
    { metadata: { quotaResetDelay: '2h42m55.780266816s' } }, { retryDelay: '9775.780266816s' }
  ] } });
  assert.equal(retryAfterMs({ 'retry-after': '7' }, quotaBody), 9775780.266816);
});
