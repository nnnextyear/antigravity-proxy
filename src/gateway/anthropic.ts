import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AppConfig, GoogleCloudCodePayload, GoogleContent } from '../types.js';
import { AccountPool } from '../pool/account-pool.js';
import { ContextOverflowError, RequestExecutor, UpstreamRequestError } from '../pool/breaker.js';
import { resolveDynamicUpstreamModel, ThinkingEffort } from './models.js';
import { compactGoogleContents, compactSystemInstruction, compactTools } from './context-compactor.js';

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
    type?: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  tools?: any[];
  tool_choice?: any;
}

interface GoogleParsedChunk {
  text: string;
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

// 缓存 Gemini 思考签名，以便在多轮对话中回传真实 thoughtSignature
const thoughtSignatureCache = new Map<string, string>();

function parseGoogleStreamChunk(jsonStr: string): GoogleParsedChunk {
  try {
    const parsed = JSON.parse(jsonStr);
    const usageMetadata = parsed.response?.usageMetadata || parsed.usageMetadata;
    const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
    if (!candidate) return { text: '', functionCalls: [], usageMetadata };

    const parts = candidate.content?.parts;
    let text = '';
    const functionCalls: Array<{ id?: string; name: string; args: any }> = [];

    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.text && !part.thought) {
          text += part.text;
        }
        if (part.functionCall) {
          const sig = part.thoughtSignature || part.thought_signature;
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
    return { text, functionCalls, finishReason, usageMetadata };
  } catch {
    return { text: '', functionCalls: [] };
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
function sanitizeGoogleSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeGoogleSchema);

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
    else s.type = 'object';
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

  return result;
}

export function registerAnthropicRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: AccountPool,
  executor: RequestExecutor,
  verifyAuth: (req: FastifyRequest, reply: FastifyReply) => void
) {
  // Claude Code calls this before /messages to decide when its own native
  // compaction should run. Return Google's real count instead of estimating.
  const handleAnthropicCountTokens = async (req: FastifyRequest, reply: FastifyReply) => {
    verifyAuth(req, reply);
    if (reply.sent) return;
    const body = req.body as AnthropicMessageRequest;
    if (!body || !Array.isArray(body.messages)) {
      return reply.status(400).send({ type: 'error', error: { type: 'invalid_request_error', message: 'messages is required and must be an array' } });
    }

    const modelDef = resolveDynamicUpstreamModel(body.model || 'claude-sonnet-4-6', 'high');
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
      const counted = await executor.countTokens({ project: 'aicode-consumers', model: modelDef.upstreamModel, request }, 3);
      return reply.send({ input_tokens: counted.totalTokens });
    } catch (err: any) {
      const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 503;
      return reply.status(statusCode).send({ type: 'error', error: { type: statusCode === 400 ? 'invalid_request_error' : 'api_error', message: `Unable to count request tokens: ${err.message}` } });
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

    // 1. 动态思考预算检测
    let effort: ThinkingEffort = 'high';
    let budgetTokens = 0;

    if (body.thinking) {
      if (body.thinking.type === 'disabled') {
        effort = 'none';
      } else if (typeof body.thinking.budget_tokens === 'number') {
        budgetTokens = body.thinking.budget_tokens;
        if (budgetTokens <= 1500) effort = 'low';
        else if (budgetTokens <= 5000) effort = 'medium';
        else effort = 'high';
      }
    }

    // 2. 转换模型与消息
    const modelDef = resolveDynamicUpstreamModel(body.model, effort);
    const isGemini = modelDef.upstreamModel.startsWith('gemini');
    const { contents, systemFromMessages } = convertAnthropicMessages(body.messages, isGemini);

    const defaultMaxOutput = isGemini ? 65536 : 8192;
    const generationConfig: any = {
      temperature: body.temperature ?? 0.7,
      maxOutputTokens: body.max_tokens ? Math.min(body.max_tokens, defaultMaxOutput) : defaultMaxOutput
    };

    if (budgetTokens > 0) {
      generationConfig.thinkingConfig = {
        thinkingBudget: budgetTokens
      };
    }

    const innerRequest: any = {
      contents,
      generationConfig
    };

    // 3. 转换 Tools & ToolConfig
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
          innerRequest.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
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

    const isStream = Boolean(body.stream);
    const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

    // 提取会话唯一指纹（用于 Zero-Waste 会话粘性，最大化利用 Google 上游 Prompt Cache）
    const headerSession = (req.headers['x-session-id'] || req.headers['session-id'] || req.headers['conversation-id'] || (body as any).metadata?.user_id) as string | undefined;
    let sessionKey = headerSession;
    if (!sessionKey && body.messages && body.messages.length > 0) {
      const sysKey = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
      const firstUser = body.messages.find(m => m.role === 'user');
      const userKey = typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content || '');
      sessionKey = crypto.createHash('md5').update(`anthropic_${sysKey.substring(0, 200)}_${userKey.substring(0, 200)}`).digest('hex');
    }

    let upstreamRes: any;
    try {
      upstreamRes = await executor.executeWithRetry(payload, 3, sessionKey);
    } catch (err: any) {
      if (err instanceof ContextOverflowError) {
        const compactedContents = compactGoogleContents(contents);
        if (!compactedContents) {
          return reply.status(400).send({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Request context exceeds the upstream 1,048,576-token limit and contains no compactable message content.' }
          });
        }
        try {
          // The original request is never changed. Retry only after Google confirms overflow.
          payload.request.contents = compactedContents;
          payload.request.systemInstruction = compactSystemInstruction(payload.request.systemInstruction);
          payload.request.tools = compactTools(payload.request.tools);
          console.warn(`[AnthropicGateway] Google context overflow confirmed; retrying with compacted history and tool schemas (${contents.length} -> ${compactedContents.length} contents).`);
          upstreamRes = await executor.executeWithRetry(payload, 1, undefined);
        } catch (retryErr: any) {
          if (retryErr instanceof ContextOverflowError) {
            return reply.status(400).send({
              type: 'error',
              error: { type: 'invalid_request_error', message: 'Request context exceeds the upstream 1,048,576-token limit even after automatic history compaction. Split the latest message or tool result into smaller requests.' }
            });
          }
          return reply.status(retryErr instanceof UpstreamRequestError ? retryErr.statusCode : 503).send({
            type: 'error',
            error: { type: retryErr instanceof UpstreamRequestError ? 'invalid_request_error' : 'api_error', message: retryErr.message }
          });
        }
      }
      // A successful compaction retry sets upstreamRes. Continue into the normal
      // response streaming path instead of returning the original overflow error.
      if (!upstreamRes) {
        const statusCode = err instanceof UpstreamRequestError ? err.statusCode : 503;
        const message = err instanceof ContextOverflowError
          ? 'Request context exceeds the upstream 1,048,576-token limit. Reduce the request history and retry.'
          : err instanceof UpstreamRequestError
            ? err.message
            : `Antigravity upstream unavailable: ${err.message}`;
        return reply.status(statusCode).send({
          type: 'error',
          error: { type: statusCode === 400 ? 'invalid_request_error' : 'api_error', message }
        });
      }
    }

    const { bodyStream, accountUsed } = upstreamRes;

    if (isStream) {
      // Anthropic SSE 流式协议
      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');

      let released = false;
      const cleanup = (err?: any) => {
        if (released) return;
        released = true;
        pool.releaseAccount(accountUsed.id, err);
      };
      req.raw.on('close', () => cleanup());

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
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        };
        reply.raw.write(`event: message_start\ndata: ${JSON.stringify(startMsg)}\n\n`);

        let buffer = '';
        const decoder = new StringDecoder('utf-8');
        let currentBlockIndex = 0;
        let isTextBlockOpen = false;
        let textBlockStarted = false;
        let hasToolUse = false;
        let lastUsageMetadata: any = null;
        const seenToolCalls = new Set<string>();

        for await (const chunk of bodyStream) {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.substring(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            const { text, functionCalls, usageMetadata } = parseGoogleStreamChunk(jsonStr);
            if (usageMetadata) lastUsageMetadata = usageMetadata;

            // 处理文本流
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

            // 处理原生 Function Call
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

        // 如果流结束时文本块仍开启，关闭它
        if (isTextBlockOpen) {
          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: currentBlockIndex
          })}\n\n`);
          isTextBlockOpen = false;
        }

        // 兜底：既无文本也无 tool_use，补一个空 text 块
        if (!textBlockStarted && !hasToolUse) {
          reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          })}\n\n`);
          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0
          })}\n\n`);
        }

        // 4. message_delta
        const msgDelta = {
          type: 'message_delta',
          delta: {
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            stop_sequence: null
          },
          // Google only emits usageMetadata in the terminal stream chunk. Include the
          // real prompt count here so clients that update usage at message_delta time
          // can adjust their own automatic compaction threshold.
          usage: {
            input_tokens: lastUsageMetadata?.promptTokenCount ?? 0,
            output_tokens: lastUsageMetadata?.candidatesTokenCount ?? 0
          }
        };
        reply.raw.write(`event: message_delta\ndata: ${JSON.stringify(msgDelta)}\n\n`);

        // 5. message_stop
        reply.raw.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        reply.raw.end();

        if (lastUsageMetadata) pool.recordTokenUsage(lastUsageMetadata);
      } catch (err: any) {
        console.error('[AnthropicGateway] Stream error:', err.message);
      } finally {
        cleanup();
      }
    } else {
      // 非流式 Anthropic JSON
      let fullText = '';
      const contentParts: any[] = [];
      const seenToolCalls = new Set<string>();
      let hasToolUse = false;
      let buffer = '';
      const decoder = new StringDecoder('utf-8');
      let lastUsageMetadata: any = null;

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

            const { text, functionCalls, usageMetadata } = parseGoogleStreamChunk(jsonStr);
            if (usageMetadata) lastUsageMetadata = usageMetadata;
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

        pool.releaseAccount(accountUsed.id);

        if (lastUsageMetadata) pool.recordTokenUsage(lastUsageMetadata);

        if (fullText) {
          contentParts.unshift({ type: 'text', text: fullText });
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
            input_tokens: lastUsageMetadata?.promptTokenCount ?? 0,
            output_tokens: lastUsageMetadata?.candidatesTokenCount ?? 0
          }
        });
      } catch (err: any) {
        pool.releaseAccount(accountUsed.id, { code: 500, message: err.message });
        return reply.status(500).send({
          type: 'error',
          error: { type: 'api_error', message: `Stream parsing error: ${err.message}` }
        });
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
