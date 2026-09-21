export interface ModelDefinition {
  id: string;
  name: string;
  pool: 'cli' | 'sandbox';
  description: string;
  contextLength?: number;
  maxOutputTokens?: number;
}

/**
 * 严格基于 Anthropic 官方标准版本命名与 Google Antigravity 实机底座的模型列表
 * 绝无人为编造的无号模型 (如去掉 claude-opus / claude-sonnet)，绝无冗余的 -high/-medium/-low 思考后缀
 * 思考级别完全由 CC (Claude Code /effort) 与 Codex 框架按需动态控制
 */
export const SUPPORTED_MODELS: ModelDefinition[] = [
  // ==================== 1. Anthropic 官方正统版本 (与 CC Switch 槽位严格一致) ====================
  {
    id: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    pool: 'sandbox',
    description: 'Anthropic 官方最新旗舰编程模型 (映射 claude-sonnet-4-6)',
    contextLength: 1048576,
    maxOutputTokens: 8192
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    pool: 'sandbox',
    description: 'Anthropic 官方主力编程模型 (CC Switch 推荐标准名，映射 claude-sonnet-4-6)',
    contextLength: 1048576,
    maxOutputTokens: 8192
  },
  {
    id: 'claude-3-opus',
    name: 'Claude 3 Opus',
    pool: 'sandbox',
    description: 'Anthropic 官方 Claude 3 Opus 旗舰模型 (映射 claude-opus-4-6-thinking)',
    contextLength: 1048576,
    maxOutputTokens: 8192
  },
  {
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    pool: 'sandbox',
    description: 'Anthropic 官方轻量快速模型 (映射高速 Sonnet 底座)',
    contextLength: 1048576,
    maxOutputTokens: 8192
  },

  // ==================== 2. Google Gemini 纯净模型 (思考级别完全由 CC/Codex 框架动态控制) ====================
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    pool: 'cli',
    description: 'Google 官方 Gemini 3.8 Flash (思考强度由 CC/Codex 框架动态控制)',
    contextLength: 1048576,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    pool: 'cli',
    description: 'Google 官方 Gemini 3.7 Flash (思考强度由 CC/Codex 框架动态控制)',
    contextLength: 1048576,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    pool: 'cli',
    description: 'Google 官方 Gemini 3.6 Flash (思考强度由 CC/Codex 框架动态控制)',
    contextLength: 1048576,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    pool: 'cli',
    description: 'Google 官方 Gemini 3.1 Pro 深度推理与 Agent 底座',
    contextLength: 1048576,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    pool: 'cli',
    description: 'Google 官方 Gemini 2.5 Pro 经典模型',
    contextLength: 1048576,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    pool: 'cli',
    description: 'Google 官方 Gemini 2.5 Flash 极速模型',
    contextLength: 1048576,
    maxOutputTokens: 65536
  },

  // ==================== 3. OpenAI / 开源旗舰标准名 ====================
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    pool: 'sandbox',
    description: 'OpenAI 官方 GPT-4o 旗舰标识 (映射 Google 120B 开源底座)',
    contextLength: 128000,
    maxOutputTokens: 8192
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    pool: 'sandbox',
    description: 'OpenAI 官方 GPT-4o Mini 轻量标识',
    contextLength: 128000,
    maxOutputTokens: 8192
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    pool: 'sandbox',
    description: 'Google Antigravity 官方开源 120B 旗舰模型',
    contextLength: 128000,
    maxOutputTokens: 8192
  },

  // ==================== 4. Google Antigravity 原生内部底座名 (供高级直选) ====================
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 (Thinking)',
    pool: 'sandbox',
    description: 'Google Antigravity 内部 Claude Opus 原生底座名',
    contextLength: 1048576,
    maxOutputTokens: 8192
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    pool: 'sandbox',
    description: 'Google Antigravity 内部 Claude Sonnet 原生底座名',
    contextLength: 1048576,
    maxOutputTokens: 8192
  }
];

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'none';

/**
 * 核心：根据客户端（CC Switch / Claude Code / Codex）请求的模型与框架传入的思考预算，动态路由至 Google 上游
 * 1. 自动剥离客户端主动附加的上下文标签（如 [1M], [1m]）
 * 2. 思考级别完全由客户端框架指令 (如 /effort low, /effort medium, /effort high) 动态决定，模型名称不包含任何 -high/-low 污染
 */
export function resolveDynamicUpstreamModel(
  inputModel: string,
  effort: ThinkingEffort = 'high'
): {
  upstreamModel: string;
  pool: 'cli' | 'sandbox';
} {
  // 剥离客户端可能附带的上下文窗口标签，如 [1M], [1m], [200k] 等
  const clean = inputModel
    .replace(/\[.*?\]/g, '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '');

  // 1. Claude Opus 系列 (claude-3-opus / claude-opus-4-6-thinking) -> Google 实机底座 claude-opus-4-6-thinking
  if (clean.includes('opus')) {
    return { upstreamModel: 'claude-opus-4-6-thinking', pool: 'sandbox' };
  }

  // 2. Claude Sonnet & Haiku (claude-3-7-sonnet / claude-3-5-sonnet / claude-3-5-haiku) -> Google 实机底座 claude-sonnet-4-6
  if (clean.includes('sonnet') || clean.includes('haiku')) {
    return { upstreamModel: 'claude-sonnet-4-6', pool: 'sandbox' };
  }

  // 3. Gemini 3.8: 动态思考强度完全由客户端/框架控制
  if (clean.includes('3.8')) {
    if (effort === 'low' || clean.endsWith('-low')) {
      return { upstreamModel: 'gemini-3.8-flash-low', pool: 'cli' };
    }
    if (effort === 'medium' || clean.endsWith('-medium')) {
      return { upstreamModel: 'gemini-3.8-flash-medium', pool: 'cli' };
    }
    return { upstreamModel: 'gemini-3.8-flash-high', pool: 'cli' };
  }

  // 4. Gemini 3.7: 动态思考强度完全由客户端/框架控制
  if (clean.includes('3.7')) {
    if (effort === 'low' || clean.endsWith('-low')) {
      return { upstreamModel: 'gemini-3.7-flash-low', pool: 'cli' };
    }
    if (effort === 'medium' || clean.endsWith('-medium')) {
      return { upstreamModel: 'gemini-3.7-flash-medium', pool: 'cli' };
    }
    return { upstreamModel: 'gemini-3.7-flash-high', pool: 'cli' };
  }

  // 5. Gemini 3.6: 动态思考强度完全由客户端/框架控制
  if (clean.includes('3.6')) {
    if (effort === 'low' || clean.endsWith('-low')) {
      return { upstreamModel: 'gemini-3.6-flash-low', pool: 'cli' };
    }
    if (effort === 'medium' || clean.endsWith('-medium')) {
      return { upstreamModel: 'gemini-3.6-flash-medium', pool: 'cli' };
    }
    return { upstreamModel: 'gemini-3.6-flash-high', pool: 'cli' };
  }

  // 6. Gemini 3.1 / Pro: 动态思考强度完全由客户端/框架控制
  if (clean.includes('3.1') || clean.includes('pro')) {
    if (clean.includes('2.5')) {
      return { upstreamModel: 'gemini-2.5-pro', pool: 'cli' };
    }
    if (effort === 'low' || clean.endsWith('-low')) {
      return { upstreamModel: 'gemini-3.1-pro-low', pool: 'cli' };
    }
    return { upstreamModel: 'gemini-pro-agent', pool: 'cli' };
  }

  // 7. Gemini 2.5 Flash
  if (clean.includes('2.5')) {
    return { upstreamModel: 'gemini-2.5-flash', pool: 'cli' };
  }

  // 8. GPT 全系列 -> 映射 Google 原生开源 120B 旗舰底座
  if (clean.includes('gpt') || clean.includes('oss')) {
    return { upstreamModel: 'gpt-oss-120b-medium', pool: 'sandbox' };
  }

  return { upstreamModel: clean, pool: 'cli' };
}
