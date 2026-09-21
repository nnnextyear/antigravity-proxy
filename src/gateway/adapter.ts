import {
  OpenAIChatCompletionRequest,
  GoogleCloudCodePayload,
  GoogleContent,
  OpenAIChatCompletionChunk
} from '../types.js';
import { resolveDynamicUpstreamModel, ThinkingEffort } from './models.js';

/**
 * 将 OpenAI 格式的 chat completions 请求转换为 Google CloudCode / Gemini 内部 payload
 * 自动检测客户端（CC / Codex）随时传入的 thinking / reasoning_effort，动态控制底层思考强度
 */
export function convertOpenAIToCloudCode(req: OpenAIChatCompletionRequest): {
  payload: GoogleCloudCodePayload;
  upstreamModel: string;
  pool: 'cli' | 'sandbox';
} {
  // 1. 动态检测客户端随请求传入的思考强度控制
  let effort: ThinkingEffort = 'high';
  let budgetTokens: number | undefined = undefined;

  if (req.reasoning_effort) {
    effort = req.reasoning_effort;
  } else if (req.thinking) {
    if (req.thinking.type === 'disabled') {
      effort = 'none';
    } else if (typeof req.thinking.budget_tokens === 'number') {
      budgetTokens = req.thinking.budget_tokens;
      if (budgetTokens <= 1500) effort = 'low';
      else if (budgetTokens <= 5000) effort = 'medium';
      else effort = 'high';
    }
  } else if (req.thinking_budget !== undefined || req.thinkingBudget !== undefined) {
    budgetTokens = req.thinking_budget ?? req.thinkingBudget;
    if (budgetTokens! <= 1500) effort = 'low';
    else if (budgetTokens! <= 5000) effort = 'medium';
    else effort = 'high';
  }

  const modelDef = resolveDynamicUpstreamModel(req.model, effort);
  const contents: GoogleContent[] = [];
  let systemInstruction: { parts: { text: string }[] } | undefined = undefined;

  for (const msg of req.messages) {
    const textContent = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')
        : String(msg.content || '');

    if (msg.role === 'system') {
      systemInstruction = {
        parts: [{ text: textContent }]
      };
    } else if (msg.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: [{ text: textContent }]
      });
    } else {
      // user 或 其他
      contents.push({
        role: 'user',
        parts: [{ text: textContent }]
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

  const isGemini = modelDef.upstreamModel.startsWith('gemini');
  const defaultMaxOutput = isGemini ? 65536 : 8192;
  const generationConfig: any = {
    temperature: req.temperature ?? 0.7,
    topP: req.top_p ?? 0.95,
    maxOutputTokens: req.max_tokens ? Math.min(req.max_tokens, defaultMaxOutput) : defaultMaxOutput
  };

  // 如果客户端指定了具体的思考 Token 预算，透传给上游
  if (budgetTokens !== undefined && budgetTokens > 0) {
    generationConfig.thinkingConfig = {
      thinkingBudget: budgetTokens
    };
  }

  const innerRequest: any = {
    contents,
    generationConfig
  };

  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
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
  finishReason: string | null = null
): string {
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: contentDelta ? { content: contentDelta } : {},
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
} {
  try {
    const parsed = JSON.parse(rawJson);
    const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
    if (!candidate) return { text: '' };

    const parts = candidate.content?.parts;
    let text = '';
    if (Array.isArray(parts)) {
      for (const part of parts) {
        // 过滤思维链（thought）部分，只返回最终输出
        if (part.text && !part.thought) {
          text += part.text;
        }
      }
    }

    const finishReason = candidate.finishReason || null;
    return { text, finishReason: finishReason === 'STOP' ? 'stop' : finishReason };
  } catch {
    return { text: '' };
  }
}
