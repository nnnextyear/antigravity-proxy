import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AppConfig, GoogleCloudCodePayload, GoogleContent } from '../types.js';
import { AccountPool, mergeUsageMetadata } from '../pool/account-pool.js';
import { ContextOverflowError, getRetryAfterHeader, LocationNotSupportedError, RequestExecutor, UpstreamRequestError } from '../pool/breaker.js';
import { AccountSchedulingError } from '../pool/scheduling.js';
import {
  ModelRequestError,
  ResolvedModel,
  resolveDynamicUpstreamModel,
  resolveFrameworkThinking,
  resolveThinkingConfig,
} from './models.js';
import { attachUpstreamSessionId, extractSessionKey, extractSessionIdentity, logSessionIdentity } from './session.js';
import { anthropicErrorType, prepareSseResponse, sendGatewayError, startRequestLifecycle } from './streaming.js';

interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | any[];
}

interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessageParam[];
  system?: string | { type: string; text: string }[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: {
    type?: 'enabled' | 'disabled' | 'adaptive';
    budget_tokens?: number;
  };
  tools?: any[];
  tool_choice?: any;
  output_config?: {
    effort?: string;
    format?: { type: string; schema?: Record<string, unknown> };
  };
}

interface GoogleParsedChunk {
  text: string;
  thoughtText: string;
  thoughtSignature?: string;
  functionCalls: Array<{
    id?: string;
    name: string;
    args: any;
  }>;
  finishReason?: string | null;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    cacheReadInputTokenCount?: number;
    cacheCreationInputTokenCount?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// 工具名称规范化：Google/Claude 严格要求 tool name 符合 ^[a-zA-Z0-9_-]{1,128}$
function sanitizeToolName(name: string): string {
  return (name || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 128) || 'tool';
}

/**
 * 稳健提取会话指纹 SessionKey (参考 gemini-balance 缓存亲和调度):
 * 优先取显式 Header/Metadata；若无，则稳定取首轮用户消息内容生成 Hash，
 * 绝不能把动态可变的 system prompt 卷入 hash，确保长对话过程中 sessionKey 永不漂移。
 */
export function extractSessionKeyFromAnthropic(req: FastifyRequest, body: AnthropicMessageRequest): string | undefined {
  return extractSessionKey(req.headers as Record<string, unknown>, body, 'anthropic');
}

// 缓存 Gemini 思考签名，以便在多轮对话中回传真实 thoughtSignature
const thoughtSignatureCache = new Map<string, string>();

function parseGoogleStreamChunk(jsonStr: string): GoogleParsedChunk {
  try {
    const parsed = JSON.parse(jsonStr);
    const usageMetadata = parsed.response?.usageMetadata || parsed.usageMetadata;
    const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
    if (!candidate) return { text: '', thoughtText: '', functionCalls: [], usageMetadata };

    const parts = candidate.content?.parts;
    let text = '';
    let thoughtText = '';
    let thoughtSignature: string | undefined;
    const functionCalls: Array<{ id?: string; name: string; args: any }> = [];

    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.thought) {
          if (typeof part.text === 'string') {
            thoughtText += part.text;
          }
          if (part.thoughtSignature || part.thought_signature) {
            thoughtSignature = part.thoughtSignature || part.thought_signature;
          }
        } else if (part.text) {
          text += part.text;
        }

        if (part.functionCall) {
          const sig = part.thoughtSignature || part.thought_signature || thoughtSignature;
          if (part.functionCall.id && sig) {
            thoughtSignatureCache.set(part.functionCall.id, sig);
            if (thoughtSignatureCache.size > 1000) {
              const first = thoughtSignatureCache.keys().next().value;
              if (first) thoughtSignatureCache.delete(first);
            }
          }
          functionCalls.push({
            id: part.functionCall.id,
            name: part.functionCall.name,
            args: part.functionCall.args || {}
          });
        }
      }
    }

    const finishReason = candidate.finishReason || null;
    return { text, thoughtText, thoughtSignature, functionCalls, finishReason, usageMetadata };
  } catch {
    return { text: '', thoughtText: '', functionCalls: [] };
  }
}

function convertAnthropicMessages(
  messages: AnthropicMessageParam[],
  isGemini: boolean = false
): {
  contents: GoogleContent[];
  systemFromMessages: string[];
} {
  const contents: GoogleContent[] = [];
  const systemFromMessages: string[] = [];
  const toolCallIdToName = new Map<string, string>();

  // 1. 搜集所有 tool_use 的 id -> name 映射
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === 'tool_use' && part.id && part.name) {
          toolCallIdToName.set(part.id, part.name);
        }
      }
    }
  }

  // 2. 转换各轮次消息为 Google CloudCode contents
  for (const msg of messages) {
    if ((msg.role as any) === 'system') {
      const sysText = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')
          : String(msg.content || '');
      if (sysText.trim()) systemFromMessages.push(sysText);
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part) continue;
        if (typeof part === 'string') {
          if (part.length > 0) parts.push({ text: part });
        } else if (part.type === 'text') {
          if (typeof part.text === 'string' && part.text.length > 0) {
            parts.push({ text: part.text });
          }
        } else if (part.type === 'tool_use') {
          const functionCallPart: any = {
            functionCall: {
              id: part.id,
              name: sanitizeToolName(part.name),
              args: part.input || {}
            }
          };
          // Gemini 3.x 模型在多轮 tool_use 中严格要求 thought_signature，否则报 HTTP 400
          if (isGemini) {
            const cachedSig = (part.id && thoughtSignatureCache.get(part.id)) || 'skip_thought_signature_validator';
            functionCallPart.thoughtSignature = cachedSig;
          }
          parts.push(functionCallPart);
        } else if (part.type === 'tool_result') {
          const contentStr = typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? part.content.map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c))).join('\n')
              : JSON.stringify(part.content ?? '');

          const toolName = toolCallIdToName.get(part.tool_use_id) || 'tool';
          parts.push({
            functionResponse: {
              id: part.tool_use_id,
              name: sanitizeToolName(toolName),
              response: {
                output: contentStr
              }
            }
          });
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return { contents, systemFromMessages };
}

/**
 * 递归清洗 JSON Schema，剔除 Google CloudCode / Gemini 严格 Proto 不支持的字段
 * （如 $schema, propertyNames, exclusiveMinimum, anyOf/oneOf/allOf, patternProperties 等），
 * 转换为 Google Protobuf Schema 严格兼容的 OpenAPI 3.0 子集。
 */
export function sanitizeGoogleSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  // Google Schema requires array.items to be a concrete Schema object. JSON
  // Schema may omit it or provide tuple items, so use the first item and a
  // string fallback rather than emitting an empty Proto message.
  if (Array.isArray(schema)) return sanitizeGoogleSchema(schema[0] || { type: 'string' });

  let s = { ...schema };

  // 1. 处理 anyOf / oneOf
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const branches = s.anyOf || s.oneOf;
    const hasNull = branches.some((b: any) => b && (b.type === 'null' || b.type === 'NULL'));
    if (hasNull) s.nullable = true;
    const nonNullBranch = branches.find((b: any) => b && b.type !== 'null' && b.type !== 'NULL') || branches[0] || {};
    delete s.anyOf;
    delete s.oneOf;
    s = { ...s, ...nonNullBranch };
  }

  // 2. 处理 allOf
  if (Array.isArray(s.allOf)) {
    const allOfBranches = s.allOf;
    delete s.allOf;
    for (const branch of allOfBranches) {
      if (branch && typeof branch === 'object') {
        s = { ...s, ...branch };
      }
    }
  }

  // 3. 处理 type 数组 (如 ['string', 'null'])
  if (Array.isArray(s.type)) {
    if (s.type.includes('null')) s.nullable = true;
    s.type = s.type.find((t: string) => t !== 'null') || 'string';
  }

  // 4. 处理 exclusiveMinimum / exclusiveMaximum (草案 7 数字转为 minimum / maximum)
  if (typeof s.exclusiveMinimum === 'number') {
    s.minimum = s.exclusiveMinimum;
  }
  if (typeof s.exclusiveMaximum === 'number') {
    s.maximum = s.exclusiveMaximum;
  }

  // 5. 处理 const (转为 enum)
  if (s.const !== undefined) {
    s.enum = [s.const];
  }

  // 6. 补全缺失的 type
  if (!s.type) {
    if (s.properties) s.type = 'object';
    else if (s.items) s.type = 'array';
    else if (s.enum) s.type = 'string';
    else s.type = 'string';
  }

  // 7. Google Schema Proto 允许字段白名单
  const allowedKeys = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'properties',
    'required',
    'items',
    'title',
    'maxItems',
    'minItems',
    'maxLength',
    'minLength',
    'pattern',
    'maximum',
    'minimum',
    'default'
  ]);

  const result: any = {};
  for (const [key, val] of Object.entries(s)) {
    if (!allowedKeys.has(key)) continue;

    if (key === 'properties' && val && typeof val === 'object') {
      const cleanProps: any = {};
      for (const [pKey, pVal] of Object.entries(val)) {
        cleanProps[pKey] = sanitizeGoogleSchema(pVal);
      }
      result.properties = cleanProps;
    } else if (key === 'items' && val && typeof val === 'object') {
      result.items = sanitizeGoogleSchema(val);
    } else if (key === 'required' && Array.isArray(val)) {
      result.required = val.filter((r) => typeof r === 'string');
    } else {
      result[key] = val;
    }
  }

  if (result.type === 'object' && !result.properties) {
    result.properties = {};
  }
  if (!result.type) {
    result.type = result.properties ? 'object' : result.items ? 'array' : result.enum ? 'string' : 'string';
  }
  if (result.type === 'array') {
    result.items = sanitizeGoogleSchema(result.items || { type: 'string' });
  }

  return result;
}

export function registerAnthropicRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: AccountPool,
  executor: RequestExecutor,
  verifyAuth: (req: FastifyRequest, reply: FastifyReply) => void
) {
  const applyRetryAfter = (reply: FastifyReply, error: unknown) => {
    const retryAfter = getRetryAfterHeader(error);
    if (retryAfter) reply.header('Retry-After', retryAfter);
  };

  // Claude Code calls this before /messages to decide when its own native
  // compaction should run. Return Google's real count instead of estimating.
  const handleAnthropicCountTokens = async (req: FastifyRequest, reply: FastifyReply) => {
    verifyAuth(req, reply);
    if (reply.sent) return;
    const body = req.body as AnthropicMessageRequest;
    if (!body || !Array.isArray(body.messages)) {
      return reply.status(400).send({ type: 'error', error: { type: 'invalid_request_error', message: 'messages is required and must be an array' } });
    }

    // Start the lifecycle before model discovery: that wait must be covered
    // by the keepalive and cancelled when the client goes away.
    const lifecycle = startRequestLifecycle(req, reply, false);
    let modelDef: ResolvedModel;
    try {
      modelDef = resolveDynamicUpstreamModel(body.model, await executor.fetchAvailableModels(3, {}, lifecycle.signal));
    } catch (err: any) {
      const statusCode = err instanceof ModelRequestError ? 400 : err instanceof UpstreamRequestError ? err.statusCode : 503;
      applyRetryAfter(reply, err);
      return reply.status(statusCode).send({ type: 'error', error: { type: statusCode === 400 ? 'invalid_request_error' : 'api_error', message: err.message } });
    }
    const converted = convertAnthropicMessages(body.messages, modelDef.upstreamModel.startsWith('gemini'));
    const systemTexts = [...converted.systemFromMessages];
    if (body.system) {
      systemTexts.push(typeof body.system === 'string'
        ? body.system
        : body.system.map((part: any) => typeof part === 'string' ? part : part.text || '').join('\n'));
    }
    const request: any = { contents: converted.contents };
    if (systemTexts.length) request.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
    if (Array.isArray(body.tools) && body.tools.length) {
      request.tools = [{ functionDeclarations: body.tools.map((tool: any) => ({
        name: sanitizeToolName(tool.name),
        description: tool.description || '',
        parameters: sanitizeGoogleSchema(tool.input_schema || tool.parameters || { type: 'object', properties: {} })
      })) }];
    }

    try {
      const sessionKey = extractSessionKeyFromAnthropic(req, body);
      const counted = await executor.countTokens({ project: 'aicode-consumers', model: modelDef.upstreamModel, request }, 3, sessionKey, lifecycle.signal, req.id);
      return reply.send({ input_tokens: counted.totalTokens });
    } catch (err: any) {
      if (err instanceof ContextOverflowError) {
        return sendGatewayError(reply, 400, { type: 'error',
          error: { type: 'invalid_request_error', code: err.code, message: err.clientMessage } }, 'anthropic');
      }
      const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 503;
      applyRetryAfter(reply, err);
      return sendGatewayError(reply, statusCode, {
        type: 'error',
        error: { type: anthropicErrorType(statusCode), message: `Unable to count request tokens: ${err.message}`,
          ...(err instanceof AccountSchedulingError ? { code: err.code } : {}) }
      }, 'anthropic', { retryAfterSeconds: getRetryAfterHeader(err) });
    }
  };

  const handleAnthropicMessages = async (req: FastifyRequest, reply: FastifyReply) => {
    verifyAuth(req, reply);
    if (reply.sent) return;

    const body = req.body as AnthropicMessageRequest;
    if (!body || !body.messages || !Array.isArray(body.messages)) {
      return reply.status(400).send({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages is required and must be an array' }
      });
    }

    // The lifecycle starts here so the keepalive covers model discovery too
    // (and a disconnected client cancels it).
    const isStream = Boolean(body.stream);
    const lifecycle = startRequestLifecycle(req, reply, isStream, config.streamKeepaliveMs);

    // 1. 动态思考预算检测
    let thinking: ReturnType<typeof resolveFrameworkThinking>;
    let modelDef: ResolvedModel;
    try {
      thinking = resolveFrameworkThinking(body);
      modelDef = resolveDynamicUpstreamModel(body.model, await executor.fetchAvailableModels(3, {}, lifecycle.signal));
    } catch (err: any) {
      const statusCode = err instanceof ModelRequestError ? 400 : err instanceof UpstreamRequestError ? err.statusCode : 503;
      applyRetryAfter(reply, err);
      // Model discovery can outlive the first keepalive, so this must not use
      // reply.send(): on a hijacked reply it is a silent no-op that leaves the
      // client on an endless 200 SSE stream.
      return sendGatewayError(reply, statusCode, {
        type: 'error',
        error: { type: anthropicErrorType(statusCode), message: err.message }
      }, 'anthropic', { retryAfterSeconds: getRetryAfterHeader(err) });
    }
    const { effort, budgetTokens } = thinking;

    // 2. 转换模型与消息
    const isGemini = modelDef.upstreamModel.startsWith('gemini');
    const { contents, systemFromMessages } = convertAnthropicMessages(body.messages, isGemini);

    const defaultMaxOutput = Number(modelDef.info?.maxOutputTokens ?? modelDef.info?.outputTokenLimit)
      || (isGemini ? 65536 : 64000);
    const generationConfig: any = {
      temperature: body.temperature ?? 0.7,
      maxOutputTokens: body.max_tokens ? Math.min(body.max_tokens, defaultMaxOutput) : defaultMaxOutput
    };

    const thinkingConfig = resolveThinkingConfig(modelDef.upstreamModel, effort, budgetTokens, modelDef.info, generationConfig.maxOutputTokens);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    // Claude Code uses this for its built-in /goal Stop hook. The hook expects
    // a JSON verdict; silently dropping the format makes it return prose and
    // then fail JSON validation in the client.
    const outputFormat = body.output_config?.format;
    if (outputFormat) {
      if (outputFormat.type !== 'json_schema' || !outputFormat.schema || typeof outputFormat.schema !== 'object' || Array.isArray(outputFormat.schema)) {
        return sendGatewayError(reply, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Unsupported output_config.format; expected json_schema with an object schema' }
        }, 'anthropic');
      }
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = sanitizeGoogleSchema(outputFormat.schema);
    }

    const innerRequest: any = {
      contents,
      generationConfig
    };

    // 3. 转换 Tools & ToolConfig。CloudCode v1internal 支持
    // 原生函数调用策略（放在 innerRequest.toolConfig 内部）。
    const toolNameMapping = new Map<string, string>();
    if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
      const functionDeclarations = body.tools.map((t: any) => {
        const cleanName = sanitizeToolName(t.name);
        toolNameMapping.set(cleanName, t.name);
        return {
          name: cleanName,
          description: t.description || '',
          parameters: sanitizeGoogleSchema(t.input_schema || t.parameters || { type: 'object', properties: {} })
        };
      });

      if (functionDeclarations.length > 0) {
        innerRequest.tools = [{ functionDeclarations }];
      }
      if (body.tool_choice) {
        if (body.tool_choice.type === 'any') {
          innerRequest.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
          innerRequest.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [sanitizeToolName(body.tool_choice.name)]
            }
          };
        } else if (body.tool_choice.type === 'none') {
          delete innerRequest.tools;
        } else {
          innerRequest.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        }
      }
    }

    // 4. 系统提示词
    const sysParts: string[] = [];
    if (systemFromMessages.length > 0) {
      sysParts.push(...systemFromMessages);
    }
    if (body.system) {
      const sysText = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map(s => (typeof s === 'string' ? s : s.text || '')).join('\n')
          : String(body.system);
      if (sysText.trim()) sysParts.push(sysText);
    }
    if (sysParts.length > 0) {
      innerRequest.systemInstruction = {
        parts: [{ text: sysParts.join('\n\n') }]
      };
    }

    const payload: GoogleCloudCodePayload = {
      project: 'aicode-consumers',
      model: modelDef.upstreamModel,
      request: innerRequest
    };

    const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

    // 提取稳定会话唯一指纹（用于强会话粘性，最大化利用 Google 上游 Prompt Cache）
    const sessionIdentity = extractSessionIdentity(req.headers as Record<string, unknown>, body, 'anthropic');
    const sessionKey = sessionIdentity?.rootKey;
    logSessionIdentity(sessionIdentity, req.id);
    // Even clients without a conversation identifier must use one account for
    // the countTokens preflight and the following generation request. The
    // ephemeral lease key is only used by the local account pool; it is never
    // sent upstream as a session identifier.
    const accountLeaseKey = sessionKey || `request:${crypto.randomUUID()}`;
    const clearEphemeralAccountLease = () => {
      if (!sessionKey) (pool as any).clearSessionBinding?.(accountLeaseKey);
    };
    attachUpstreamSessionId(payload, sessionKey);

    let upstreamRes: any;
    try {
      // Hold one concurrency slot through preflight, generation and response consumption.
      upstreamRes = await executor.executeWithRetry(payload, 3, accountLeaseKey, lifecycle.signal, req.id, true);
    } catch (err: any) {
      clearEphemeralAccountLease();
      if (lifecycle.signal.aborted) return;
      if (err instanceof ContextOverflowError) {
        // Claude Code recognizes native prompt-too-long wording in both main
        // and child sessions. A custom instruction to compact is not recognized.
        applyRetryAfter(reply, err);
        return sendGatewayError(reply, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', code: err.code, message: err.clientMessage }
        }, 'anthropic', { retryAfterSeconds: getRetryAfterHeader(err) });
      }
      if (err instanceof LocationNotSupportedError) {
        applyRetryAfter(reply, err);
        return sendGatewayError(reply, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Google Upstream 拒绝访问：当前代理出口 IP 地区不受支持 (User location is not supported for the API use)。请在代理软件（如 Clash）中将节点切换至美国(US)、日本(JP)、新加坡(SG)等 Google 支持的地区，避免使用香港(HK)节点或直连。'
          }
        }, 'anthropic', { retryAfterSeconds: getRetryAfterHeader(err) });
      }
      const statusCode = err instanceof UpstreamRequestError ? err.statusCode : 503;
      const message = err instanceof UpstreamRequestError ? err.message : `Antigravity upstream unavailable: ${err.message}`;
      applyRetryAfter(reply, err);
      return sendGatewayError(reply, statusCode, {
        type: 'error',
        error: { type: anthropicErrorType(statusCode), message, ...(err instanceof AccountSchedulingError ? { code: err.code } : {}) }
      }, 'anthropic', { retryAfterSeconds: getRetryAfterHeader(err) });
    }

    const { bodyStream, accountUsed } = upstreamRes;
    const inputTokenCount = upstreamRes.inputTokenCount ?? 0;

    if (isStream) {
      // Anthropic SSE 流式协议
      prepareSseResponse(reply);

      let released = false;
      const cleanup = (err?: any) => {
        if (released) return;
        released = true;
        if (upstreamRes.release) upstreamRes.release(err);
        else pool.releaseAccount(accountUsed.id, err);
        clearEphemeralAccountLease();
      };
      try {
        // 1. message_start
        const startMsg = {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokenCount, output_tokens: 0 }
          }
        };
        reply.raw.write(`event: message_start\ndata: ${JSON.stringify(startMsg)}\n\n`);

        let buffer = '';
        const decoder = new StringDecoder('utf-8');
        let currentBlockIndex = 0;
        let isThinkingBlockOpen = false;
        let isTextBlockOpen = false;
        let textBlockStarted = false;
        let hasToolUse = false;
        let lastUsageMetadata: any = null;
        let lastSignature: string | undefined;
        const seenToolCalls = new Set<string>();
        const clientRequestedThinking = effort !== undefined && effort !== 'none';

        for await (const chunk of bodyStream) {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.substring(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            const { text, thoughtText, thoughtSignature, functionCalls, usageMetadata } = parseGoogleStreamChunk(jsonStr);
            if (thoughtSignature) lastSignature = thoughtSignature;
            if (usageMetadata) lastUsageMetadata = mergeUsageMetadata(lastUsageMetadata, usageMetadata);

            // 1. 处理思考流 (Anthropic Extended Thinking 规范)
            if (thoughtText) {
              if (clientRequestedThinking) {
                if (!isThinkingBlockOpen) {
                  reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: { type: 'thinking', thinking: '' }
                  })}\n\n`);
                  isThinkingBlockOpen = true;
                }
                reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'thinking_delta', thinking: thoughtText }
                })}\n\n`);
              } else {
                // 客户端未开启 thinking 参数，发送 SSE 保活注释避免底层 TCP/HTTP 读取超时中断
                reply.raw.write(`: keepalive\n\n`);
              }
            }

            // 2. 如果收到正式文本或函数调用，且思考块仍未关闭，先安全关闭思考块
            if ((text || functionCalls.length > 0) && isThinkingBlockOpen) {
              if (lastSignature) {
                reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'signature_delta', signature: lastSignature }
                })}\n\n`);
              }
              reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: currentBlockIndex
              })}\n\n`);
              isThinkingBlockOpen = false;
              currentBlockIndex++;
            }

            // 3. 处理文本流
            if (text) {
              if (!isTextBlockOpen) {
                reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })}\n\n`);
                isTextBlockOpen = true;
                textBlockStarted = true;
              }

              reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: { type: 'text_delta', text }
              })}\n\n`);
            }

            // 4. 处理原生 Function Call
            if (functionCalls.length > 0) {
              if (isTextBlockOpen) {
                // 如果当前文本块仍在开启状态，先结束文本块
                reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: currentBlockIndex
                })}\n\n`);
                isTextBlockOpen = false;
                currentBlockIndex++;
              }

              for (const fn of functionCalls) {
                const callKey = `${fn.id || ''}_${fn.name}_${JSON.stringify(fn.args)}`;
                if (seenToolCalls.has(callKey)) continue;
                seenToolCalls.add(callKey);

                hasToolUse = true;
                const toolBlockIndex = currentBlockIndex++;
                const toolId = fn.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;

                reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: toolBlockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: toolId,
                    name: toolNameMapping.get(fn.name) || fn.name,
                    input: {}
                  }
                })}\n\n`);

                const argsJson = JSON.stringify(fn.args || {});
                reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: toolBlockIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: argsJson
                  }
                })}\n\n`);

                reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: toolBlockIndex
                })}\n\n`);

              }
            }
          }
        }

        // 如果流结束时思考块仍开启，关闭它
        if (isThinkingBlockOpen) {
          if (lastSignature) {
            reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'signature_delta', signature: lastSignature }
            })}\n\n`);
          }
          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: currentBlockIndex
          })}\n\n`);
          isThinkingBlockOpen = false;
          currentBlockIndex++;
        }

        // 如果流结束时文本块仍开启，关闭它
        if (isTextBlockOpen) {
          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: currentBlockIndex
          })}\n\n`);
          isTextBlockOpen = false;
        }

        // 兜底：既无文本也无 tool_use 且没有 thinking，补一个空 text 块
        if (!textBlockStarted && !hasToolUse && !clientRequestedThinking) {
          reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'text', text: '' }
          })}\n\n`);
          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: currentBlockIndex
          })}\n\n`);
        }

        // 4. message_delta
        const msgDelta = {
          type: 'message_delta',
          delta: {
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            stop_sequence: null
          },
          // Preflight can fail transiently. Correct the initial zero/estimate
          // with upstream usage so clients can trigger automatic compaction.
          usage: { input_tokens: lastUsageMetadata?.promptTokenCount ?? inputTokenCount,
            output_tokens: lastUsageMetadata?.candidatesTokenCount ?? 0 }
        };
        reply.raw.write(`event: message_delta\ndata: ${JSON.stringify(msgDelta)}\n\n`);

        // 5. message_stop
        reply.raw.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        reply.raw.end();
        const inTokens = lastUsageMetadata?.promptTokenCount ?? inputTokenCount;
        const outTokens = lastUsageMetadata?.candidatesTokenCount ?? 0;
        const cachedTokens = lastUsageMetadata?.cachedContentTokenCount ?? 0;
        console.info(`[AnthropicGateway] ✅ 流式响应成功交付 (req: ${req.id}, 输入: ${inTokens} tokens, 产出: ${outTokens} tokens, 缓存命中: ${cachedTokens} tokens)`);

        if (lastUsageMetadata) pool.recordTokenUsage(lastUsageMetadata);
      } catch (err: any) {
        console.error('[AnthropicGateway] Stream error:', err.message);
        const statusCode = err instanceof UpstreamRequestError ? err.statusCode : 502;
        sendGatewayError(reply, statusCode, {
          type: 'error',
          error: { type: anthropicErrorType(statusCode), message: `Upstream stream failed: ${err.message}` }
        }, 'anthropic', { retryAfterSeconds: getRetryAfterHeader(err) });
      } finally {
        // Capture the disconnect state before abort() flips it for every exit.
        const clientGone = lifecycle.signal.aborted;
        lifecycle.abort();
        cleanup(clientGone ? { code: 499, message: 'Client disconnected' } : undefined);
      }
    } else {
      // 非流式 Anthropic JSON
      let nonStreamReleased = false;
      const releaseNonStream = (err?: any) => {
        if (nonStreamReleased) return;
        nonStreamReleased = true;
        if (upstreamRes.release) upstreamRes.release(err);
        else pool.releaseAccount(accountUsed.id, err);
        clearEphemeralAccountLease();
      };
      let fullText = '';
      let fullThinking = '';
      let lastSignature: string | undefined;
      const contentParts: any[] = [];
      const seenToolCalls = new Set<string>();
      let hasToolUse = false;
      let buffer = '';
      const decoder = new StringDecoder('utf-8');
      let lastUsageMetadata: any = null;
      const clientRequestedThinking = effort !== undefined && effort !== 'none';

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

            const { text, thoughtText, thoughtSignature, functionCalls, usageMetadata } = parseGoogleStreamChunk(jsonStr);
            if (thoughtSignature) lastSignature = thoughtSignature;
            if (usageMetadata) lastUsageMetadata = mergeUsageMetadata(lastUsageMetadata, usageMetadata);
            if (thoughtText) fullThinking += thoughtText;
            if (text) fullText += text;

            for (const fn of functionCalls) {
              const callKey = `${fn.id || ''}_${fn.name}_${JSON.stringify(fn.args)}`;
              if (seenToolCalls.has(callKey)) continue;
              seenToolCalls.add(callKey);

              hasToolUse = true;
              contentParts.push({
                type: 'tool_use',
                id: fn.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                name: toolNameMapping.get(fn.name) || fn.name,
                input: fn.args || {}
              });
            }
          }
        }

        releaseNonStream();

        if (lastUsageMetadata) pool.recordTokenUsage(lastUsageMetadata);

        const inTokens = lastUsageMetadata?.promptTokenCount ?? inputTokenCount;
        const outTokens = lastUsageMetadata?.candidatesTokenCount ?? 0;
        const cachedTokens = lastUsageMetadata?.cachedContentTokenCount ?? 0;
        console.info(`[AnthropicGateway] ✅ 响应成功交付 (req: ${req.id}, 输入: ${inTokens} tokens, 产出: ${outTokens} tokens, 缓存命中: ${cachedTokens} tokens)`);

        if (fullThinking && clientRequestedThinking) {
          contentParts.push({
            type: 'thinking',
            thinking: fullThinking,
            ...(lastSignature ? { signature: lastSignature } : {})
          });
        }

        if (fullText) {
          contentParts.push({ type: 'text', text: fullText });
        }

        if (contentParts.length === 0) {
          contentParts.push({ type: 'text', text: '' });
        }

        return reply.send({
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: contentParts,
          stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: lastUsageMetadata?.promptTokenCount ?? inputTokenCount,
            output_tokens: lastUsageMetadata?.candidatesTokenCount ?? 0
          }
        });
      } catch (err: any) {
        releaseNonStream(lifecycle.signal.aborted
          ? { code: 499, message: 'Client disconnected' }
          : { code: 500, message: err.message });
        return sendGatewayError(reply, 500, {
          type: 'error',
          error: { type: 'api_error', message: `Stream parsing error: ${err.message}` }
        }, 'anthropic');
      }
    }
  };

  // 同时监听 /v1/messages, /messages 以及客户端由于 baseURL 拼错产生的 /v1/v1/messages
  app.post('/v1/messages', handleAnthropicMessages);
  app.post('/messages', handleAnthropicMessages);
  app.post('/v1/v1/messages', handleAnthropicMessages);
  app.post('/v1/messages/count_tokens', handleAnthropicCountTokens);
  app.post('/messages/count_tokens', handleAnthropicCountTokens);
  app.post('/v1/v1/messages/count_tokens', handleAnthropicCountTokens);
}
