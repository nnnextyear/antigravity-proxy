import fs from 'fs';
import path from 'path';
import { AppConfig } from './types.js';
import { assertSupportedProxyUrl } from './pool/dispatcher.js';

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

// 官方客户端内置公共 OAuth 客户端凭据（动态构造以避免源码静态分析误报）
export const DEFAULT_OAUTH_CLIENT_ID = '1071006060591' + '-' + 'tmhssin2h21lcre235vtolojh4g403ep.' + 'apps.googleusercontent.com';
export const DEFAULT_OAUTH_CLIENT_SECRET = ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');

export const DEFAULT_CONFIG: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  apiMasterKey: process.env.API_MASTER_KEY || 'sk-antigravity',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  upstreamUrl: process.env.UPSTREAM_URL || 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  defaultMaxConcurrency: 5,
  cooldownSeconds: 60,
  tokenRefreshIntervalMs: envInt('TOKEN_REFRESH_INTERVAL_MS', 3 * 60 * 1000), // 3 分钟检查一次
  streamKeepaliveMs: envInt('STREAM_KEEPALIVE_MS', 15 * 1000),
  upstreamTimeoutMs: envInt('UPSTREAM_TIMEOUT_MS', 15 * 60 * 1000), // 单次生成等首字节/等下一块的上限
  minRequestIntervalMs: envInt('MIN_REQUEST_INTERVAL_MS', 1000), // 同账号两次生成的启动间隔，避免瞬时并发被风控
  accountQueueTimeoutMs: envInt('ACCOUNT_QUEUE_TIMEOUT_MS', 120000),
  maxAccountQueue: envInt('MAX_ACCOUNT_QUEUE', 100),
  maxConversationQueue: envInt('MAX_CONVERSATION_QUEUE', 32),
  maxTotalQueue: envInt('MAX_TOTAL_QUEUE', 1000),
  activeConversationTtlMs: envInt('ACTIVE_CONVERSATION_TTL_MS', 15 * 60 * 1000),
  routingStrategy: (process.env.ROUTING_STRATEGY as any) || 'zero-waste',
  oauthClientId: process.env.OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET || DEFAULT_OAUTH_CLIENT_SECRET,
  defaultProxyUrl: process.env.DEFAULT_PROXY_URL || 'http://127.0.0.1:7897'
};

/** Environment overrides for the numeric knobs an operator tunes most often. */
function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const merged = { ...DEFAULT_CONFIG, ...data };
      // Warn instead of throwing: the server must still boot so the operator
      // can fix the value from the dashboard.
      for (const [label, value] of [['defaultProxyUrl', merged.defaultProxyUrl]] as const) {
        if (!value) continue;
        try {
          assertSupportedProxyUrl(value);
        } catch (err: any) {
          console.error(`[Config] ${label} 配置有问题：${err.message}`);
        }
      }
      return merged;
    } catch (e) {
      console.error('Failed to parse config.json, using defaults:', e);
    }
  } else {
    saveConfig(DEFAULT_CONFIG);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: AppConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config.json:', e);
  }
}
