export type AccountStatus = 'active' | 'cooldown' | 'dead' | 'disabled';
export type RoutingStrategy = 'zero-waste' | 'sequential-drain' | 'round-robin';

export interface AccountQuota {
  geminiWeeklyFraction: number; // 0.0 - 1.0 (周期总额度)
  gemini5hFraction: number;      // 0.0 - 1.0 (5小时额度)
  geminiResetTime?: string;      // 5小时重置时间 (ISO timestamp)
  geminiWeeklyResetTime?: string; // 周期总额度重置时间 (ISO timestamp)
  gemini5hDesc?: string;         // Google 官方 5 小时描述
  geminiWeeklyDesc?: string;     // Google 官方周度描述
  claudeWeeklyFraction: number;  // 0.0 - 1.0 (周期总额度剩余比例)
  claude5hFraction: number;      // 0.0 - 1.0 (5小时额度剩余比例)
  claudeResetTime?: string;      // 5小时重置时间 (ISO timestamp)
  claudeWeeklyResetTime?: string; // 周期总额度重置时间 (ISO timestamp)
  claude5hDesc?: string;         // Google 官方 5 小时描述
  claudeWeeklyDesc?: string;     // Google 官方周度描述
  lastCheckedAt?: number;
}

export interface Account {
  id: string;
  email: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number; // Unix timestamp (ms)
  status: AccountStatus;
  cooldownUntil: number;        // Unix timestamp (ms)
  activeConcurrency: number;
  maxConcurrency: number;
  totalRequests: number;
  failedRequests: number;
  proxyUrl?: string;            // 独立出口代理，如 http://user:pass@ip:port
  lastUsedAt: number;
  createdAt: number;
  lastError?: string;
  quota?: AccountQuota;
  validationUrl?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  apiMasterKey: string;         // 对外给客户端调用的 API Key，如 sk-antigravity
  adminPassword: string;        // Web 控制台管理密码
  upstreamUrl: string;          // Google CloudCode 端点
  defaultMaxConcurrency: number;
  cooldownSeconds: number;      // 遇到 429 冷却时长（秒）
  tokenRefreshIntervalMs: number;
  routingStrategy?: RoutingStrategy;
  oauthClientId?: string;
  oauthClientSecret?: string;
  defaultProxyUrl?: string;       // 全局默认出口代理，如 http://127.0.0.1:7897
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[];
  name?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'none';
  thinking?: {
    type?: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  thinking_budget?: number;
  thinkingBudget?: number;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }[];
}

export interface GooglePart {
  text?: string;
}

export interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

export interface GoogleCloudCodePayload {
  project?: string;
  model?: string;
  request: {
    contents: GoogleContent[];
    systemInstruction?: {
      parts: GooglePart[];
    };
    generationConfig?: {
      temperature?: number;
      topP?: number;
      maxOutputTokens?: number;
    };
  };
}

export interface PoolStats {
  totalAccounts: number;
  activeAccounts: number;
  cooldownAccounts: number;
  deadAccounts: number;
  currentTotalConcurrency: number;
  totalRequestsServed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  hasTokenUsage: boolean;
  uptimeSeconds: number;
  routingStrategy: RoutingStrategy;
}
