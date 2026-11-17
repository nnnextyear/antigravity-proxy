import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';

for (const model of ['gemini-3.8-flash', 'claude-sonnet-4-6']) {
  test(`${model}: preserve instructions, history, tools and count envelope`, async () => {
    const app = Fastify();
    let generated: any;
    let counted: any;
    const catalog = { models: { [model]: {} } };
    const executor = {
      fetchAvailableModels: async () => catalog,
      executeWithRetry: async (payload: any) => {
        generated = payload;
        throw new Error('Captured before network');
      },
      countTokens: async (payload: any) => {
        counted = payload;
        return { totalTokens: 123 };
      }
    };
    registerAnthropicRoutes(app, { streamKeepaliveMs: 15000 } as any,
      { clearSessionBinding() {} } as any, executor as any, () => {});
    const body = {
      model, stream: false, max_tokens: 1024,
      system: [
        { type: 'text', text: 'Keep the application rules.' },
        { type: 'text', text: 'Keep the second application rule block separate.' }
      ],
      messages: [
        { role: 'system', content: [
          { type: 'text', text: 'Keep the runtime rules too.' },
          { type: 'text', text: 'Keep this runtime rule in its own block.' }
        ] },
        { role: 'user', content: 'Remember this.' },
        { role: 'assistant', content: 'Remembered.' },
        { role: 'user', content: '你好' }
      ],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]
    };
    try {
      await app.inject({ method: 'POST', url: '/v1/messages?beta=true', payload: body });
      const count = await app.inject({ method: 'POST', url: '/v1/messages/count_tokens', payload: body });
      assert.equal(count.statusCode, 200);
      assert.equal(count.json().input_tokens, 123);
      assert.deepEqual(counted.request.contents, generated.request.contents);
      assert.deepEqual(counted.request.systemInstruction, generated.request.systemInstruction);
      assert.equal(generated.request.systemInstruction, undefined);
      assert.equal(generated.request.contents[0].parts[0].text, '<system-instructions>\nKeep the runtime rules too.\n\nKeep this runtime rule in its own block.\n\nKeep the application rules.\n\nKeep the second application rule block separate.\n</system-instructions>');
      assert.equal(generated.request.contents[0].parts[1].text, 'Remember this.');
      assert.equal(generated.request.tools[0].functionDeclarations[0].name, 'Read');
      assert.equal(generated.request.contents.at(-1).parts[0].text, '你好');
      assert.equal(generated.request.contents.length, 3);
    } finally { await app.close(); }
  });
}

test('caller system prompt starts a separate user turn before model or tool-result history', async () => {
  for (const firstMessage of [
    { role: 'assistant', content: 'Earlier assistant turn.' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Tool output.' }] }
  ]) {
    const app = Fastify();
    let generated: any;
    const executor = {
      fetchAvailableModels: async () => ({ models: { 'gemini-3.8-flash': {} } }),
      executeWithRetry: async (payload: any) => {
        generated = payload;
        throw new Error('Captured before network');
      }
    };
    registerAnthropicRoutes(app, { streamKeepaliveMs: 15000 } as any,
      { clearSessionBinding() {} } as any, executor as any, () => {});
    try {
      await app.inject({ method: 'POST', url: '/v1/messages?beta=true', payload: {
        model: 'gemini-3.8-flash', stream: false, max_tokens: 32,
        system: 'Caller instructions stay intact.',
        messages: [firstMessage]
      } });
      assert.equal(generated.request.contents[0].role, 'user');
      assert.equal(generated.request.contents[0].parts[0].text, '<system-instructions>\nCaller instructions stay intact.\n</system-instructions>');
      assert.equal(generated.request.contents.length, 2);
      assert.deepEqual(generated.request.contents[1].role, firstMessage.role === 'assistant' ? 'model' : 'user');
      if (firstMessage.role === 'user') assert.ok(generated.request.contents[1].parts[0].functionResponse);
    } finally { await app.close(); }
  }
});

test('caller identity terms are scrubbed only in the moved system prompt', async () => {
  const app = Fastify();
  let generated: any;
  const executor = {
    fetchAvailableModels: async () => ({ models: { 'gemini-3.8-flash': {} } }),
    executeWithRetry: async (payload: any) => {
      generated = payload;
      throw new Error('Captured before network');
    }
  };
  registerAnthropicRoutes(app, { streamKeepaliveMs: 15000 } as any,
    { clearSessionBinding() {} } as any, executor as any, () => {});
  try {
    await app.inject({ method: 'POST', url: '/v1/messages?beta=true', payload: {
      model: 'gemini-3.8-flash', stream: false, max_tokens: 32,
      system: "You are Claude Code, Anthropic's CLI. Hermes Agent and Nous Research are included.",
      messages: [{ role: 'user', content: 'Claude Code should stay unchanged here.' }]
    } });
    assert.equal(generated.request.contents[0].parts[0].text,
      '<system-instructions>\nYou are the assistant, the vendor\'s CLI. the assistant and the assistant team are included.\n</system-instructions>');
    assert.equal(generated.request.contents[0].parts[1].text, 'Claude Code should stay unchanged here.');
  } finally { await app.close(); }
});
