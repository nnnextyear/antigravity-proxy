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
  const modelDef = resolveDynamicUpstreamModel(req.model, catalog);
  const isGemini = modelDef.upstreamModel.startsWith('gemini');
  const contents: GoogleContent[] = [];
  let systemInstruction: { parts: { text: string }[] } | undefined = undefined;
  const toolCallIds = new Map<string, string>();

  const normalizeToolName = (name: string) =>
    (name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'tool';

  const appendContentPart = (parts: any[], part: any) => {
    if (typeof part === 'string') {
      if (part) parts.push({ text: part });
    } else if (part?.type === 'text' && typeof part.text === 'string') {
      if (part.text) parts.push({ text: part.text });
    } else if (part?.type === 'image_url') {
      // Google CloudCode models used by this adapter do not accept OpenAI image
      // blocks reliably; preserve a clear textual marker instead of silently
      // dropping the user's input.
      parts.push({ text: `[image input: ${part.image_url?.url || 'unavailable'}]` });
    }
  };

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      const textContent = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')
          : String(msg.content || '');
      systemInstruction = {
        parts: [{ text: textContent }]
      };
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];
      if (typeof msg.content === 'string') appendContentPart(parts, msg.content);
      else if (Array.isArray(msg.content)) msg.content.forEach(part => appendContentPart(parts, part));
      for (const call of msg.tool_calls || []) {
        const name = normalizeToolName(call.function?.name);
        const id = call.id || `call_${contents.length}_${parts.length}`;
        toolCallIds.set(id, name);
        let args: any = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = { raw_arguments: call.function?.arguments || '' }; }
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
      const parts: any[] = [];
      if (typeof msg.content === 'string') appendContentPart(parts, msg.content);
      else if (Array.isArray(msg.content)) msg.content.forEach(part => appendContentPart(parts, part));
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
    temperature: req.temperature ?? 0.7,
    topP: req.top_p ?? 0.95,
    maxOutputTokens: req.max_tokens ? Math.min(req.max_tokens, defaultMaxOutput) : defaultMaxOutput
  };

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
    return { text, functionCalls, finishReason: finishReason === 'STOP' ? 'stop' : finishReason, usageMetadata };
  } catch {
    return { text: '', functionCalls: [] };
  }
}
