import {
  OpenAIChatCompletionRequest,
  GoogleCloudCodePayload,
  GoogleContent,
  OpenAIChatCompletionChunk
} from '../types.js';
import {
  resolveDynamicUpstreamModel,
  resolveFrameworkThinking,
  resolveThinkingConfig,
  isGemini3Model,
  LiveModelCatalog
} from './models.js';

import { sanitizeGoogleSchema } from './anthropic.js';

/**
 * 将 OpenAI 格式的 chat completions 请求转换为 Google CloudCode / Gemini 内部 payload
 * 自动检测客户端（CC / Codex）随时传入的 thinking / reasoning_effort，动态控制底层思考强度
 */
export function convertOpenAIToCloudCode(req: OpenAIChatCompletionRequest, catalog?: LiveModelCatalog): {
  payload: GoogleCloudCodePayload;
  upstreamModel: string;
  pool: 'cli' | 'sandbox';
} {
  // 1. 动态检测客户端随请求传入的思考强度控制
  const { effort, budgetTokens } = resolveFrameworkThinking(req);
  const modelDef = resolveDynamicUpstreamModel(req.model, catalog, effort);
  const isGemini = modelDef.upstreamModel.startsWith('gemini');
  const contents: GoogleContent[] = [];
  let systemInstruction: { role: 'user'; parts: { text: string }[] } | undefined = undefined;
  const toolCallIds = new Map<string, string>();

  const normalizeToolName = (name: string) =>
    (name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'tool';

  const appendContentPart = (parts: any[], part: any) => {
    if (typeof part === 'string') {
      if (part) parts.push({ text: part });
    } else if (part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') {
      if (part.text) parts.push({ text: part.text });
    } else if (part?.type === 'image_url' || part?.type === 'input_image') {
      const image = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const dataUri = typeof image === 'string'
        ? image.match(/^data:([^;,]+);base64,(.+)$/s)
        : null;
      if (dataUri) {
        parts.push({ inlineData: { mimeType: dataUri[1], data: dataUri[2] } });
      } else if (image) {
        // The CloudCode payload cannot dereference arbitrary remote URLs. Keep
        // the URL visible to the model instead of silently dropping the part.
        parts.push({ text: `[image input URL: ${image}]` });
      }
    }
  };

  const contentToParts = (content: unknown): any[] => {
    const parts: any[] = [];
    if (typeof content === 'string') appendContentPart(parts, content);
    else if (Array.isArray(content)) content.forEach(part => appendContentPart(parts, part));
    return parts;
  };

  for (const msg of req.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const systemParts = contentToParts(msg.content);
      systemInstruction = {
        role: 'user',
        parts: systemParts.length ? systemParts : [{ text: '' }]
      };
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];
      contentToParts(msg.content).forEach(part => parts.push(part));
      for (const call of msg.tool_calls || []) {
        const name = normalizeToolName(call.function?.name);
        const id = call.id || `call_${contents.length}_${parts.length}`;
        toolCallIds.set(id, name);
        let args: any = {};
        const rawArguments: any = call.function?.arguments;
        if (rawArguments && typeof rawArguments === 'object') {
          args = rawArguments;
        } else {
          try { args = JSON.parse(String(rawArguments || '{}')); } catch { args = { raw_arguments: String(rawArguments || '') }; }
        }
        // Gemini 3.x rejects a functionCall in a later turn unless the part
        // carries the thought signature from the original model response.
        // OpenAI/Codex does not expose that field in its chat-shaped history,
        // so retain a supplied signature when available and otherwise use the
        // documented compatibility sentinel accepted by CloudCode.
        const thoughtSignature = (call as any).thought_signature || (call as any).thoughtSignature;
        parts.push({
          functionCall: { id, name, args },
          ...(isGemini ? { thoughtSignature: thoughtSignature || 'skip_thought_signature_validator' } : {})
        });
      }
      contents.push({
        role: 'model',
        parts: parts.length ? parts : [{ text: '' }]
      });
    } else if (msg.role === 'tool') {
      const name = msg.name || toolCallIds.get(msg.tool_call_id || '') || 'tool';
      const output = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { id: msg.tool_call_id, name: normalizeToolName(name), response: { output } } }]
      });
    } else {
      const parts = contentToParts(msg.content);
      contents.push({
        role: 'user',
        parts: parts.length ? parts : [{ text: '' }]
      });
    }
  }

  // 必须保证至少有一个 user content
  if (contents.length === 0) {
    contents.push({
      role: 'user',
      parts: [{ text: 'Hello' }]
    });
  }

  const defaultMaxOutput = Number(modelDef.info?.maxOutputTokens ?? modelDef.info?.outputTokenLimit)
    || (isGemini ? 65536 : 64000);
  const generationConfig: any = {
    maxOutputTokens: req.max_tokens === undefined
      ? defaultMaxOutput
      : Math.min(Math.max(1, Math.floor(req.max_tokens)), defaultMaxOutput)
  };
  // Gemini 3+ removed the legacy sampling controls. Sending them to 3.8
  // causes compatibility failures even when they have their default values.
  if (!isGemini3Model(modelDef.upstreamModel)) {
    generationConfig.temperature = typeof req.temperature === 'number' ? req.temperature : 1;
    generationConfig.topP = typeof req.top_p === 'number' ? req.top_p : 1;
  }
  if (typeof req.presence_penalty === 'number') generationConfig.presencePenalty = req.presence_penalty;
  if (typeof req.frequency_penalty === 'number') generationConfig.frequencyPenalty = req.frequency_penalty;
  if (typeof req.stop === 'string' && req.stop) generationConfig.stopSequences = [req.stop];
  else if (Array.isArray(req.stop)) generationConfig.stopSequences = req.stop.filter((value): value is string => typeof value === 'string' && value.length > 0);

  // Responses API structured output, used by Codex's automatic approval
  // reviewer, maps to Gemini's JSON MIME type and response schema.
  if (req.response_format?.type === 'json_schema' && req.response_format.json_schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = sanitizeGoogleSchema(req.response_format.json_schema.schema || {
      type: 'object',
      properties: {}
    });
  } else if (req.response_format?.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }

  const thinkingConfig = resolveThinkingConfig(modelDef.upstreamModel, effort, budgetTokens, modelDef.info, generationConfig.maxOutputTokens);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

  const innerRequest: any = {
    contents,
    generationConfig
  };

  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }

  if (Array.isArray(req.tools) && req.tools.length) {
    const functionDeclarations: any[] = [];
    for (const tool of req.tools) {
      const t = tool as any;
      const rawName = t?.function?.name || t?.name || (typeof t?.type === 'string' && t.type.startsWith('web_search') ? 'web_search' : '');
      if (!rawName) continue;
      const name = normalizeToolName(rawName);
      const rawDesc = t?.function?.description || t?.description;
      const description = (typeof rawDesc === 'string' && rawDesc.trim()) || `Tool ${name}`;
      const rawParams = t?.function?.parameters || t?.parameters || t?.input_schema || { type: 'object', properties: {} };
      functionDeclarations.push({
        name,
        description,
        parameters: sanitizeGoogleSchema(rawParams)
      });
    }
    if (functionDeclarations.length > 0) {
      innerRequest.tools = [{ functionDeclarations }];
    }
  }
  if (req.tool_choice && req.tool_choice !== 'auto') {
    if (req.tool_choice === 'none') {
      delete innerRequest.tools;
    } else {
      const targetName = req.tool_choice?.function?.name || req.tool_choice?.name;
      const mode = isGemini
        ? (req.tool_choice === 'required' ? 'ANY' : 'AUTO')
        : 'VALIDATED';
      innerRequest.toolConfig = {
        functionCallingConfig: {
          mode,
          ...(targetName ? { allowedFunctionNames: [normalizeToolName(targetName)] } : {})
        }
      };
    }
  }
  const payload: GoogleCloudCodePayload = {
    project: 'aicode-consumers',
    model: modelDef.upstreamModel,
    request: innerRequest
  };

  return {
    payload,
    upstreamModel: modelDef.upstreamModel,
    pool: modelDef.pool
  };
}

/**
 * 创建标准的 OpenAI Chat Completion Chunk
 */
export function createOpenAIChunk(
  id: string,
  model: string,
  contentDelta: string,
  finishReason: string | null = null,
  toolCalls?: Array<{ index: number; id?: string; name: string; arguments: string }>
): string {
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: contentDelta
          ? { content: contentDelta }
          : toolCalls?.length
            ? { tool_calls: toolCalls.map(call => ({
                index: call.index,
                ...(call.id ? { id: call.id } : {}),
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments }
              })) }
            : {},
        finish_reason: finishReason
      }
    ]
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Standard first SSE frame for Chat Completions clients. */
export function createOpenAIRoleChunk(id: string, model: string): string {
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    usage: null
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Optional usage frame requested by OpenAI's stream_options.include_usage. */
export function createOpenAIUsageChunk(
  id: string,
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): string {
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function normalizeOpenAIFinishReason(reason?: string | null): string | null {
  switch (String(reason || '').toUpperCase()) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII': return 'content_filter';
    case 'RECITATION': return 'content_filter';
    default: return reason || null;
  }
}

/**
 * 解析 Google 上游返回的单行 SSE 数据，提取文本片段
 */
export function extractTextFromGoogleChunk(rawJson: string): {
  text: string;
  finishReason?: string | null;
  functionCalls?: Array<{ id?: string; name: string; args: any }>;
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
} {
  try {
    const parsed = JSON.parse(rawJson);
    const usageMetadata = parsed.response?.usageMetadata || parsed.usageMetadata;
    const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
    if (!candidate) return { text: '', functionCalls: [], usageMetadata };

    const parts = candidate.content?.parts;
    let text = '';
    const functionCalls: Array<{ id?: string; name: string; args: any }> = [];
    if (Array.isArray(parts)) {
      for (const part of parts) {
        // 过滤思维链（thought）部分，只返回最终输出
        if (part.text && !part.thought) {
          text += part.text;
        }
        if (part.functionCall) {
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
