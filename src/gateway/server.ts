import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import { AppConfig, OpenAIChatCompletionRequest } from '../types.js';
import { AccountPool } from '../pool/account-pool.js';
import { TokenRefresher } from '../pool/refresher.js';
import { ContextOverflowError, RequestExecutor, UpstreamRequestError } from '../pool/breaker.js';
import { SUPPORTED_MODELS } from './models.js';
import { convertOpenAIToCloudCode, createOpenAIChunk, extractTextFromGoogleChunk } from './adapter.js';
import { registerAdminRoutes } from '../admin/routes.js';
import { registerAnthropicRoutes } from './anthropic.js';
import { QuotaManager } from '../pool/quota-manager.js';

export async function createServer(
  config: AppConfig,
  pool: AccountPool,
  refresher: TokenRefresher,
  executor: RequestExecutor,
  quotaManager?: QuotaManager
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024, // 100MB 满足 1M 上下文大请求体
    connectionTimeout: 600000, // 10分钟长连接
    keepAliveTimeout: 300000,
    requestTimeout: 600000,
    rewriteUrl: (req): string => {
      if (req.url) {
        return req.url.replace(/^(\/v1)+(\/.*)$/, '/v1$2');
      }
      return '/';
    }
  });

  // 请求日志
  app.addHook('onRequest', async (req, reply) => {
    // Fastify assigns a stable request id; expose it to clients so upstream
    // failures can be correlated across retries and account rotations.
    reply.header('x-request-id', req.id);
    console.log(`[HTTP ${new Date().toLocaleTimeString()}] [${req.id}] ${req.method} ${req.url}`);
  });

  // 允许空的 application/json 请求体，避免 Fastify 抛出 "Body cannot be empty"
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || (typeof body === 'string' && !body.trim())) {
      return done(null, {});
    }
    try {
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err: any) {
      done(err, undefined);
    }
  });

  // 跨域支持
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  // 静态托管管理后台
  const publicDir = path.resolve(process.cwd(), 'public');
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/admin/',
    setHeaders: (res, pathName) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      if (pathName.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      } else if (pathName.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      } else if (pathName.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      }
    }
  });

  // 根路径重定向至 /admin/
  app.get('/', async (req, reply) => {
    return reply.redirect('/admin/');
  });
  app.get('/admin', async (req, reply) => {
    return reply.redirect('/admin/');
  });

  // 健康探针
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'antigravity-proxy',
      stats: pool.getStats()
    };
  });

  // 注册管理员 REST API
  registerAdminRoutes(app, pool, refresher, config, quotaManager);

  // 客户端鉴权验证中间件（支持 Authorization: Bearer 或 x-api-key）
  const verifyClientAuth = (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.apiMasterKey) return; // 未设 key 时免校验
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    if (!authHeader) {
      reply.status(401).send({ error: { message: 'Missing Authorization or x-api-key header', type: 'invalid_request_error' } });
      return;
    }
    const token = typeof authHeader === 'string'
      ? (authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : authHeader.trim())
      : '';
    if (token !== config.apiMasterKey) {
      reply.status(401).send({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
      return;
    }
  };

  // ===================== Anthropic Messages 兼容路由 (Claude Code 原生) =====================
  registerAnthropicRoutes(app, config, pool, executor, verifyClientAuth);

  // ===================== OpenAI / CC Switch 模型查询路由 =====================

  // GET /v1/models 以及 GET /models (支持 CC Switch 及各类第三方客户端发现模型列表)
  const handleGetModels = async (req: FastifyRequest, reply: FastifyReply) => {
    verifyClientAuth(req, reply);
    if (reply.sent) return;
    return {
      object: 'list',
      data: SUPPORTED_MODELS.map(m => ({
        id: m.id,
        object: 'model',
        owned_by:
          m.id.includes('claude') || m.id.includes('opus') || m.id.includes('sonnet') || m.id.includes('haiku')
            ? 'anthropic'
            : m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3') || m.id.includes('chatgpt')
              ? 'openai'
              : m.id.includes('gemini')
                ? 'google'
                : 'antigravity-proxy',
        permission: [],
        root: m.id,
        parent: null,
        context_length: m.contextLength ?? 1048576,
        max_tokens: m.contextLength ?? 1048576,
        max_output_tokens: m.maxOutputTokens ?? 65536,
        description: m.description
      }))
    };
  };

  app.get('/v1/models', handleGetModels);
  app.get('/models', handleGetModels);
  // ===================== CC Switch / OneAPI / NewAPI 用量查询路由 =====================
  const handleUserBalance = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    let token = '';
    if (typeof authHeader === 'string') {
      token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : authHeader.trim();
    }
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === 'localhost';
    if (config.apiMasterKey && token !== config.apiMasterKey && !isLocalhost) {
      return reply.status(401).send({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
    }

    const accounts = pool.getAllAccounts();
    const activeAccounts = accounts.filter(a => a.status === 'active');

    let totalClaude5h = 0;
    let claudeAccountCount = 0;
    let nearestResetTime: string | null = null;
    let nearestResetDiffMs = Infinity;
    const now = Date.now();

    for (const acc of activeAccounts) {
      if (acc.quota && typeof acc.quota.claude5hFraction === 'number') {
        totalClaude5h += acc.quota.claude5hFraction;
        claudeAccountCount++;
        if (acc.quota.claudeResetTime) {
          const resetDiff = new Date(acc.quota.claudeResetTime).getTime() - now;
          if (resetDiff > 0 && resetDiff < nearestResetDiffMs) {
            nearestResetDiffMs = resetDiff;
            nearestResetTime = acc.quota.claudeResetTime;
          }
        }
      } else {
        totalClaude5h += 1.0;
        claudeAccountCount++;
      }
    }

    const avgClaudePercent = claudeAccountCount > 0
      ? Math.round((totalClaude5h / claudeAccountCount) * 100 * 10) / 10
      : 100;

    const totalPoints = activeAccounts.length * 100;
    const remainingPoints = Math.round(totalClaude5h * 100 * 10) / 10;
    const usedPoints = Math.max(0, Math.round((totalPoints - remainingPoints) * 10) / 10);

    return {
      success: true,
      isValid: true,
      // CC Switch 自定义提取器标准属性
      remaining: avgClaudePercent,
      used: Math.round((100 - avgClaudePercent) * 10) / 10,
      total: 100,
      unit: '%',
      planName: `Antigravity (${activeAccounts.length}/${accounts.length}号在线)`,
      
      // OneAPI / NewAPI 标准兼容字段 (部分客户端模板依赖 data.quota)
      data: {
        quota: remainingPoints * 5000,
        total_quota: totalPoints * 5000,
        used_quota: usedPoints * 5000
      },

      // 仪表盘用量格式
      total_usage: usedPoints,
      total_tokens: totalPoints,

      // 扩展状态信息
      active_accounts: activeAccounts.length,
      total_accounts: accounts.length,
      claude_5h_percent: avgClaudePercent,
      nearest_reset_time: nearestResetTime,
      routing_strategy: pool.getRoutingStrategy()
    };
  };

  app.get('/v1/user/balance', handleUserBalance);
  app.get('/user/balance', handleUserBalance);
  app.get('/api/user/balance', handleUserBalance);
  app.get('/v1/dashboard/billing/usage', handleUserBalance);
  app.get('/dashboard/billing/usage', handleUserBalance);
  app.get('/v1/usage', handleUserBalance);

  // 2. POST /v1/chat/completions (流式 & 非流式核心)
  const handleChatCompletions = async (req: FastifyRequest, reply: FastifyReply) => {
    verifyClientAuth(req, reply);
    if (reply.sent) return;

    const chatReq = req.body as OpenAIChatCompletionRequest;
    if (!chatReq || !chatReq.messages || !Array.isArray(chatReq.messages)) {
      return reply.status(400).send({
        error: { message: 'Invalid request: messages array is required', type: 'invalid_request_error' }
      });
    }

    const { payload, upstreamModel } = convertOpenAIToCloudCode(chatReq);
    const isStream = Boolean(chatReq.stream);
    const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    // 提取会话唯一指纹（用于 Zero-Waste 会话粘性，最大化利用 Google 上游 Prompt Cache）
    const headerSession = (req.headers['x-session-id'] || req.headers['session-id'] || req.headers['conversation-id'] || (chatReq as any).user) as string | undefined;
    let sessionKey = headerSession;
    if (!sessionKey && chatReq.messages && chatReq.messages.length > 0) {
      const firstSys = chatReq.messages.find(m => m.role === 'system');
      const firstUser = chatReq.messages.find(m => m.role === 'user');
      const sysKey = typeof firstSys?.content === 'string' ? firstSys.content : JSON.stringify(firstSys?.content || '');
      const userKey = typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content || '');
      sessionKey = crypto.createHash('md5').update(`openai_${sysKey.substring(0, 200)}_${userKey.substring(0, 200)}`).digest('hex');
    }

    let upstreamRes: any = null;
    try {
      upstreamRes = await executor.executeWithRetry(payload, 3, sessionKey);
    } catch (err: any) {
      if (err instanceof ContextOverflowError) {
        return reply.status(400).send({
          error: { message: 'Request context exceeds the upstream limit. The client must compact its conversation and retry.', type: 'invalid_request_error' }
        });
      }
      const statusCode = err instanceof UpstreamRequestError ? err.statusCode : 503;
      const message = err instanceof UpstreamRequestError ? err.message : `Antigravity upstream unavailable: ${err.message}`;
      return reply.status(statusCode).send({
        error: { message, type: statusCode === 400 ? 'invalid_request_error' : 'api_error' }
      });
    }

    const { bodyStream, accountUsed } = upstreamRes;

    if (isStream) {
      // 开启 SSE 模式
      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');

      let buffer = '';
      const decoder = new StringDecoder('utf-8');
      let usageMetadata: any = null;
      const toolCalls: Array<{ id?: string; name: string; arguments: string }> = [];

      let released = false;
      const cleanup = (err?: any) => {
        if (released) return;
        released = true;
        pool.releaseAccount(accountUsed.id, err);
      };

      req.raw.on('close', () => cleanup());

      try {
        for await (const chunk of bodyStream) {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          // 保留最后一行（可能不完整）
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.substring(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            const { text, functionCalls = [], finishReason, usageMetadata: chunkUsage } = extractTextFromGoogleChunk(jsonStr);
            if (chunkUsage) usageMetadata = chunkUsage;
            if (text) {
              const sseChunk = createOpenAIChunk(completionId, chatReq.model, text, null);
              reply.raw.write(sseChunk);
            }
            for (const call of functionCalls) {
              const toolCall = {
                id: call.id || `call_${completionId}_${toolCalls.length}`,
                name: call.name,
                arguments: JSON.stringify(call.args || {})
              };
              toolCalls.push(toolCall);
              reply.raw.write(createOpenAIChunk(completionId, chatReq.model, '', null, [{ index: toolCalls.length - 1, ...toolCall }]));
            }
            if (finishReason) {
              const sseChunk = createOpenAIChunk(completionId, chatReq.model, '', toolCalls.length ? 'tool_calls' : finishReason);
              reply.raw.write(sseChunk);
            }
          }
        }
        buffer += decoder.end();

        // 发送终止标志
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        if (usageMetadata) pool.recordTokenUsage(usageMetadata);
      } catch (e: any) {
        console.error('[Gateway] SSE Streaming error:', e.message);
      } finally {
        cleanup();
      }
    } else {
      // 非流式，聚合文本一次性返回
      let fullText = '';
      let buffer = '';
      const decoder = new StringDecoder('utf-8');
      let usageMetadata: any = null;
      const toolCalls: Array<{ id?: string; name: string; arguments: string }> = [];

      try {
        for await (const chunk of bodyStream) {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.substring(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            const { text, functionCalls = [], usageMetadata: chunkUsage } = extractTextFromGoogleChunk(jsonStr);
            if (chunkUsage) usageMetadata = chunkUsage;
            if (text) {
              fullText += text;
            }
            for (const call of functionCalls) {
              toolCalls.push({
                id: call.id || `call_${completionId}_${toolCalls.length}`,
                name: call.name,
                arguments: JSON.stringify(call.args || {})
              });
            }
          }
        }
        buffer += decoder.end();

        pool.releaseAccount(accountUsed.id);
        if (usageMetadata) pool.recordTokenUsage(usageMetadata);

        return reply.send({
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: chatReq.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: fullText || null,
                ...(toolCalls.length ? {
                  tool_calls: toolCalls.map(call => ({
                    id: call.id,
                    type: 'function' as const,
                    function: { name: call.name, arguments: call.arguments }
                  }))
                } : {})
              },
              finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
            }
          ],
          usage: {
            prompt_tokens: usageMetadata?.promptTokenCount || 0,
            completion_tokens: usageMetadata?.candidatesTokenCount || 0,
            total_tokens: usageMetadata?.totalTokenCount || 0
          }
        });
      } catch (err: any) {
        pool.releaseAccount(accountUsed.id, { code: 500, message: err.message });
        return reply.status(500).send({
          error: { message: `Stream parsing error: ${err.message}`, type: 'api_error' }
        });
      }
    }
  };

  app.post('/v1/chat/completions', handleChatCompletions);
  app.post('/chat/completions', handleChatCompletions);
  app.post('/v1/v1/chat/completions', handleChatCompletions);

  // OpenAI Responses API compatibility for Codex and newer OpenAI clients.
  // The upstream executor remains Chat Completions-shaped internally; this
  // adapter only translates the public request and response envelopes.
  const handleResponses = async (req: FastifyRequest, reply: FastifyReply) => {
    verifyClientAuth(req, reply);
    if (reply.sent) return;

    const input = req.body as any;
    if (!input || !input.model) {
      return reply.status(400).send({
        error: { message: 'Invalid request: model is required', type: 'invalid_request_error' }
      });
    }

    const messages: any[] = [];
    if (typeof input.instructions === 'string' && input.instructions.trim()) {
      messages.push({ role: 'system', content: input.instructions });
    }
    const responseInput = input.input;
    const items = Array.isArray(responseInput) ? responseInput : [{ role: 'user', content: responseInput ?? '' }];
    for (const item of items) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item?.type === 'message' || item?.role) {
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        const content = Array.isArray(item.content)
          ? item.content.map((part: any) => part?.text ?? part?.input_text ?? part?.output_text ?? '').join('\n')
          : (item.content ?? '');
        messages.push({ role, content });
      } else if (item?.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
      } else if (item?.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }]
        });
      }
    }
    if (!messages.length) messages.push({ role: 'user', content: '' });

    const responseReq: OpenAIChatCompletionRequest = {
      model: input.model,
      messages,
      stream: Boolean(input.stream),
      temperature: input.temperature,
      max_tokens: input.max_output_tokens,
      reasoning_effort: input.reasoning?.effort || input.reasoning_effort,
      tools: Array.isArray(input.tools)
        ? input.tools.filter((t: any) => t?.type === 'function' && t.name).map((t: any) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
        : undefined,
      tool_choice: input.tool_choice
    };
    const responseFormat = input.text?.format;
    if (responseFormat?.type === 'json_schema') {
      responseReq.response_format = {
        type: 'json_schema',
        json_schema: {
          name: responseFormat.name,
          description: responseFormat.description,
          schema: responseFormat.schema,
          strict: responseFormat.strict
        }
      };
    } else if (responseFormat?.type === 'json_object') {
      responseReq.response_format = { type: 'json_object' };
    }

    const { payload } = convertOpenAIToCloudCode(responseReq);
    const responseId = `resp_${crypto.randomBytes(12).toString('hex')}`;
    const headerSession = (req.headers['x-session-id'] || req.headers['session-id'] || input.user) as string | undefined;
    const sessionKey = headerSession || crypto.createHash('md5').update(`responses_${JSON.stringify(messages.slice(0, 2))}`).digest('hex');

    let upstreamRes: any;
    try {
      upstreamRes = await executor.executeWithRetry(payload, 3, sessionKey);
    } catch (err: any) {
      if (err instanceof ContextOverflowError) {
        return reply.status(400).send({ error: { message: 'Request context exceeds the upstream limit.', type: 'invalid_request_error' } });
      }
      const statusCode = err instanceof UpstreamRequestError ? err.statusCode : 503;
      return reply.status(statusCode).send({ error: { message: err.message, type: statusCode === 400 ? 'invalid_request_error' : 'api_error' } });
    }

    const { bodyStream, accountUsed } = upstreamRes;
    let fullText = '';
    let buffer = '';
    const decoder = new StringDecoder('utf-8');
    let usageMetadata: any = null;
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const responseObject = (status: string, output: any[] = []) => ({
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      incomplete_details: null,
      model: input.model,
      output,
      instructions: input.instructions ?? null,
      tools: input.tools || [],
      tool_choice: input.tool_choice || 'auto',
      temperature: input.temperature ?? 1,
      top_p: input.top_p ?? 1,
      max_output_tokens: input.max_output_tokens ?? null,
      previous_response_id: input.previous_response_id ?? null,
      reasoning: input.reasoning || { effort: null, summary: null },
      text: input.text || { format: { type: 'text' } },
      parallel_tool_calls: input.parallel_tool_calls !== false,
      metadata: input.metadata || {},
      usage: usageMetadata ? {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        total_tokens: usageMetadata.totalTokenCount || 0
      } : null
    });
    const writeResponseEvent = (type: string, data: any) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    const buildOutput = (messageId: string) => {
      const output: any[] = [];
      if (fullText || !toolCalls.length) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: fullText, annotations: [] }]
        });
      }
      for (const call of toolCalls) {
        output.push({
          type: 'function_call',
          id: call.id,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'completed'
        });
      }
      return output;
    };
    const consumeChunk = (jsonStr: string) => {
      const parsed = extractTextFromGoogleChunk(jsonStr);
      if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;
      if (parsed.text) fullText += parsed.text;
      for (const call of parsed.functionCalls || []) {
        toolCalls.push({ id: call.id || `call_${responseId}_${toolCalls.length}`, name: call.name, arguments: JSON.stringify(call.args || {}) });
      }
      return parsed.text || '';
    };

    if (input.stream) {
      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders?.();
      writeResponseEvent('response.created', { response: responseObject('in_progress') });
      writeResponseEvent('response.in_progress', { response: responseObject('in_progress') });
      const messageId = `msg_${responseId}`;
      writeResponseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
      });
      writeResponseEvent('response.content_part.added', {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      });
      try {
        for await (const chunk of bodyStream) {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.substring(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            const delta = consumeChunk(jsonStr);
            if (delta) writeResponseEvent('response.output_text.delta', { response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, delta });
          }
        }
        buffer += decoder.end();
        pool.releaseAccount(accountUsed.id);
        if (usageMetadata) pool.recordTokenUsage(usageMetadata);
        const output = buildOutput(messageId);
        if (fullText || !toolCalls.length) {
          writeResponseEvent('response.output_text.done', { response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, text: fullText });
          writeResponseEvent('response.content_part.done', { response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } });
        }
        if (output[0]?.type === 'message') writeResponseEvent('response.output_item.done', { output_index: 0, item: output[0] });
        for (let i = output[0]?.type === 'message' ? 1 : 0; i < output.length; i++) {
          writeResponseEvent('response.output_item.added', { output_index: i, item: { ...output[i], status: 'in_progress', arguments: '' } });
          writeResponseEvent('response.function_call_arguments.delta', { item_id: output[i].id, output_index: i, delta: output[i].arguments });
          writeResponseEvent('response.function_call_arguments.done', { item_id: output[i].id, output_index: i, arguments: output[i].arguments });
          writeResponseEvent('response.output_item.done', { output_index: i, item: output[i] });
        }
        writeResponseEvent('response.completed', { response: responseObject('completed', output) });
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (err: any) {
        pool.releaseAccount(accountUsed.id, { code: 500, message: err.message });
        reply.raw.end();
      }
      return;
    }

    try {
      for await (const chunk of bodyStream) {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const jsonStr = trimmed.substring(5).trim();
            if (jsonStr && jsonStr !== '[DONE]') consumeChunk(jsonStr);
          }
        }
      }
      pool.releaseAccount(accountUsed.id);
      if (usageMetadata) pool.recordTokenUsage(usageMetadata);
      const output = buildOutput(`msg_${responseId}`);
      return reply.send({ ...responseObject('completed', output), output_text: fullText });
    } catch (err: any) {
      pool.releaseAccount(accountUsed.id, { code: 500, message: err.message });
      return reply.status(500).send({ error: { message: `Stream parsing error: ${err.message}`, type: 'api_error' } });
    }
  };

  app.post('/v1/responses', handleResponses);
  app.post('/responses', handleResponses);
  app.post('/v1/v1/responses', handleResponses);

  return app;
}
