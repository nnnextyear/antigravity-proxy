import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastify from 'fastify';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';
import { UpstreamRequestError } from '../src/pool/breaker.js';
import type { AppConfig, GoogleCloudCodePayload } from '../src/types.js';

const verdictSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    impossible: { type: 'boolean' }
  },
  required: ['ok', 'reason'],
  additionalProperties: false
};

test('Claude Code /goal JSON schema reaches the Google generation request', async () => {
  const app = fastify();
  let captured: GoogleCloudCodePayload | undefined;
  const executor = {
    fetchAvailableModels: async () => ({ models: { 'claude-sonnet-4-6': { maxOutputTokens: 64000 } } }),
    executeWithRetry: async (payload: GoogleCloudCodePayload, _retries: number, _key: string, _signal: AbortSignal, _id: string, preflight: boolean) => {
      assert.equal(preflight, true);
      captured = payload;
      return {
        inputTokenCount: 42,
        accountUsed: { id: 'test' },
        bodyStream: (async function* () {
          yield Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"{\\"ok\\":true,\\"reason\\":\\"Done\\"}"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":10}}}\n\n');
        })()
      };
    }
  };
  registerAnthropicRoutes(
    app,
    {} as AppConfig,
    { releaseAccount: () => {}, recordTokenUsage: () => {} } as any,
    executor as any,
    () => {}
  );

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/v1/messages?beta=true',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Evaluate the goal' }],
        stream: false,
        output_config: { effort: 'max', format: { type: 'json_schema', schema: verdictSchema } }
      }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(captured?.request.generationConfig?.thinkingConfig, { thinkingBudget: 32768 });
    assert.equal(captured?.request.generationConfig?.responseMimeType, 'application/json');
    assert.deepEqual(captured?.request.generationConfig?.responseSchema, {
      type: 'object',
      properties: verdictSchema.properties,
      required: verdictSchema.required
    });
    assert.deepEqual(JSON.parse(response.json().content[0].text), { ok: true, reason: 'Done' });

    const normalResponse = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hello' }] }
    });
    assert.equal(normalResponse.statusCode, 200, normalResponse.body);
    assert.equal(captured?.request.generationConfig?.responseMimeType, undefined);
    assert.equal(captured?.request.generationConfig?.responseSchema, undefined);

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        output_config: { format: { type: 'unsupported' } }
      }
    });
    assert.equal(invalidResponse.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('Anthropic gateway preserves a policy error from the executor preflight', async () => {
  const app = fastify();
  let executionCalls = 0;
  const executor = {
    fetchAvailableModels: async () => ({ models: { 'claude-sonnet-4-6': { maxOutputTokens: 64000 } } }),
    executeWithRetry: async (_payload: unknown, _retries: number, _key: string, _signal: AbortSignal, _id: string, preflight: boolean) => {
      assert.equal(preflight, true);
      executionCalls++;
      throw new UpstreamRequestError(403, JSON.stringify({
        error: {
          code: 403,
          reason: 'TOS_VIOLATION',
          message: 'This service has been disabled in this account for violation of Terms of Service.'
        }
      }));
    }
  };

  registerAnthropicRoutes(
    app,
    {} as AppConfig,
    { releaseAccount: () => {}, recordTokenUsage: () => {} } as any,
    executor as any,
    () => {}
  );

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }]
      }
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(executionCalls, 1);
    assert.match(response.body, /TOS_VIOLATION/);
  } finally {
    await app.close();
  }
});

test('Anthropic stream corrects input usage for subagents when preflight is unavailable and a terminal chunk is sparse', async () => {
  const app = fastify();
  const executor = {
    fetchAvailableModels: async () => ({ models: { 'gemini-test': {} } }),
    executeWithRetry: async () => ({
      accountUsed: { id: 'test' },
      inputTokenCount: undefined,
      bodyStream: (async function* () {
        yield Buffer.from('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 950000, candidatesTokenCount: 1, cachedContentTokenCount: 800000 } } }) + '\n\n');
        yield Buffer.from('data: ' + JSON.stringify({ response: { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 2 } } }) + '\n\n');
      })()
    })
  };
  let recorded: any;
  registerAnthropicRoutes(app, {} as AppConfig, { releaseAccount() {}, recordTokenUsage(usage: any) { recorded = usage; } } as any, executor as any, () => {});
  try {
    for (const stream of [true, false]) {
      const response = await app.inject({ method: 'POST', url: '/v1/messages', payload: { model: 'gemini-test[1M]', stream,
        metadata: { user_id: JSON.stringify({ session_id: 'parent', agent_id: 'child' }) }, messages: [{ role: 'user', content: 'Continue task' }] } });
      assert.equal(response.statusCode, 200, response.body);
      if (stream) {
        const frames = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
        assert.equal(frames.find(frame => frame.type === 'message_start').message.usage.input_tokens, 0);
        assert.equal(frames.find(frame => frame.type === 'message_delta').usage.input_tokens, 950000);
        assert.equal(frames.find(frame => frame.type === 'message_delta').usage.output_tokens, 2);
      } else assert.equal(response.json().usage.input_tokens, 950000);
      assert.equal(recorded.promptTokenCount, 950000);
      assert.equal(recorded.cachedContentTokenCount, 800000);
    }
  } finally { await app.close(); }
});
