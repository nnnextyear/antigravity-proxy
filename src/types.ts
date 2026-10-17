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
  /** 429 累计次数：在被限频但还没被冷却隔离之前给出预警信号。 */
  rateLimitHits?: number;
  lastRateLimitAt?: number;
  /** 连续的可恢复 403 / 新 token 被拒次数，用于逐级升级到终止状态。 */
  forbiddenCount?: number;
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
  /** Downstream SSE keep-alive interval for long thinking streams. */
  streamKeepaliveMs?: number;
  /**
   * Response-header / inter-chunk budget for one generation POST. A long
   * thinking generation can stay silent for minutes; this must stay well above
   * the downstream keep-alive interval. Default 900000 (15 分钟).
   */
  upstreamTimeoutMs?: number;
  /**
   * Minimum spacing between two generation starts on one account (ms).
   * Spreads a burst across an account instead of firing every slot at once.
   * 0 disables the pacing.
   */
  minRequestIntervalMs?: number;
  routingStrategy?: RoutingStrategy;
  oauthClientId?: string;
  oauthClientSecret?: string;
  defaultProxyUrl?: string;       // 全局默认出口代理，如 http://127.0.0.1:7897
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: 'function';
    function: { name: string; arguments: string };
  }>;
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
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  reasoning?: { effort?: OpenAIChatCompletionRequest['reasoning_effort'] };
  thinking?: {
    type?: 'enabled' | 'disabled' | 'adaptive';
    budget_tokens?: number;
  };
  thinking_budget?: number;
  thinkingBudget?: number;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: any } }>;
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  user?: string;
  stream_options?: { include_usage?: boolean };
  response_format?: {
    type?: string;
    json_schema?: { name?: string; description?: string; schema?: any; strict?: boolean };
  };
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
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }[];
}

export interface GooglePart {
  text?: string;
  functionCall?: { id?: string; name: string; args?: any };
  functionResponse?: { id?: string; name: string; response: { output: string } };
  thoughtSignature?: string;
}

export interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

export interface GoogleCloudCodePayload {
  project?: string;
  model?: string;
  request: {
    sessionId?: string;
    contents: GoogleContent[];
    systemInstruction?: {
      parts: GooglePart[];
    };
    generationConfig?: {
      temperature?: number;
      topP?: number;
      maxOutputTokens?: number;
      thinkingConfig?: Record<string, unknown>;
    };
    tools?: any[];
    toolConfig?: Record<string, unknown>;
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
  totalCachedTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  hasTokenUsage: boolean;
  uptimeSeconds: number;
  routingStrategy: RoutingStrategy;
}
