import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastify from 'fastify';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';
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
    countTokens: async () => ({ totalTokens: 42 }),
    executeWithRetry: async (payload: GoogleCloudCodePayload) => {
      captured = payload;
      return {
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
