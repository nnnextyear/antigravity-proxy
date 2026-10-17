import { Agent, ProxyAgent, Dispatcher } from 'undici';

/**
 * 全局 ProxyAgent 实例缓存池
 * 避免高频请求或后台定时轮询中不断 new ProxyAgent 造成连接池未关闭、socket 泄漏和本地端口耗尽
 */
const proxyAgentCache = new Map<string, ProxyAgent>();
const directAgents = new Set<Agent>();
const drainingDispatchers = new Set<ProxyAgent>();
const dispatcherIds = new WeakMap<Dispatcher, number>();
let nextDispatcherId = 1;

export function getDispatcherId(dispatcher?: Dispatcher): string {
  return dispatcher ? String(dispatcherIds.get(dispatcher) ?? 'unknown') : 'direct';
}

/**
 * undici's ProxyAgent only speaks HTTP CONNECT over http/https. A socks5 URL
 * would otherwise fail deep inside the connector for every single request, so
 * reject it up front with an actionable message.
 */
export function assertSupportedProxyUrl(proxyUrl?: string): void {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return;
  if (/^https?:\/\//i.test(trimmed)) return;
  if (/^socks[45h]*:\/\//i.test(trimmed)) {
    throw new Error(`不支持的代理协议 (${trimmed})：本项目依赖的 undici 只实现了 HTTP/HTTPS 代理。请改用代理软件的 HTTP 混合端口（Clash/Mihomo 默认 http://127.0.0.1:7897）。`);
  }
  throw new Error(`代理地址格式不正确 (${trimmed})：需要形如 http://host:port 的完整 URL。`);
}

export interface DispatcherOptions {
  timeoutMs?: number;
  /** Maximum time an idle keep-alive tunnel may be reused. */
  keepAliveTimeoutMs?: number;
  keepAliveMaxTimeoutMs?: number;
}

/**
 * 获取或创建复用的 Dispatcher (ProxyAgent) 单例
 * 
 * 正确配置 undici 代理超时：
 * - requestTls: 控制代理隧道建立后的端到端 TLS 握手超时，不限制生成总时长
 * - proxyTls: 控制连接本地代理服务器的 TLS/TCP 超时
 * - connect: 控制底层连接器通用超时
 */
export function getOrCreateDispatcher(proxyUrl?: string, options?: DispatcherOptions): Dispatcher | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    // Clash TUN and other transparent routes still need a long-lived TCP
    // socket for generations that stay silent before response headers arrive.
    // Undici's default direct connector does not enable TCP keepalive.
    // A TUN/proxy path may corrupt a reused H2 TLS session after a long
    // silent generation. Create one isolated H2 session per upstream request
    // instead of allowing later generations to reuse that session.
    const agent = new Agent({
      allowH2: true,
      maxRequestsPerClient: 1,
      connect: { keepAlive: true, keepAliveInitialDelay: 15_000 },
      keepAliveTimeout: Math.min(1000, options?.keepAliveTimeoutMs ?? 10_000),
      keepAliveMaxTimeout: Math.min(3000, options?.keepAliveMaxTimeoutMs ?? 30_000),
      keepAliveTimeoutThreshold: 1000
    });
    directAgents.add(agent);
    dispatcherIds.set(agent, nextDispatcherId++);
    return agent;
  }
  assertSupportedProxyUrl(trimmed);

  const timeoutMs = options?.timeoutMs ?? 60000;
  // A proxy can silently retire an idle CONNECT tunnel while undici still
  // has it in its pool. Keep the reuse window bounded so a later long-lived
  // request does not inherit a stale tunnel from an earlier request.
  const keepAliveTimeoutMs = options?.keepAliveTimeoutMs ?? 10000;
  const keepAliveMaxTimeoutMs = options?.keepAliveMaxTimeoutMs ?? 30000;
  const cacheKey = `${trimmed}__timeout_${timeoutMs}__ka_${keepAliveTimeoutMs}_${keepAliveMaxTimeoutMs}`;

  let dispatcher = proxyAgentCache.get(cacheKey);
  if (!dispatcher) {
    dispatcher = new ProxyAgent({
      uri: trimmed,
      allowH2: true,
      maxRequestsPerClient: 1,
      // maxCachedSessions: 0 disables TLS session resumption. Accounts that
      // share one proxy also share this ProxyAgent, and a resumed ticket is a
      // cross-account correlation signal; correctness beats the handshake
      // saving here.
      requestTls: { timeout: timeoutMs, keepAlive: true, keepAliveInitialDelay: 15000, maxCachedSessions: 0, ALPNProtocols: ['h2', 'http/1.1'] },
      proxyTls: { timeout: timeoutMs, keepAlive: true, keepAliveInitialDelay: 15000 },
      connect: { timeout: timeoutMs },
      keepAliveTimeout: keepAliveTimeoutMs,
      keepAliveMaxTimeout: keepAliveMaxTimeoutMs,
      keepAliveTimeoutThreshold: Math.min(2000, Math.max(1000, Math.floor(keepAliveTimeoutMs / 2)))
    } as any);
    dispatcherIds.set(dispatcher, nextDispatcherId++);
    proxyAgentCache.set(cacheKey, dispatcher);
  }

  return dispatcher;
}

/** Retire a specific pool without interrupting requests already using it. */
export function resetDispatcher(proxyUrl: string | undefined, options: DispatcherOptions | undefined, expectedDispatcher: Dispatcher): void {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return;

  const timeoutMs = options?.timeoutMs ?? 60000;
  const keepAliveTimeoutMs = options?.keepAliveTimeoutMs ?? 10000;
  const keepAliveMaxTimeoutMs = options?.keepAliveMaxTimeoutMs ?? 30000;
  const cacheKey = `${trimmed}__timeout_${timeoutMs}__ka_${keepAliveTimeoutMs}_${keepAliveMaxTimeoutMs}`;
  const dispatcher = proxyAgentCache.get(cacheKey);
  // A late failure from an old pool must never retire its replacement.
  if (!dispatcher || dispatcher !== expectedDispatcher) return;

  proxyAgentCache.delete(cacheKey);
  drainingDispatchers.add(dispatcher);
  void Promise.resolve()
    .then(() => dispatcher.close())
    .catch(() => { console.warn(`[Dispatcher] Failed to close retired pool ${getDispatcherId(dispatcher)}.`); })
    .finally(() => { drainingDispatchers.delete(dispatcher); });
}

/**
 * 服务退出时关闭当前和正在排空的连接池
 */
export function destroyAllDispatchers(): void {
  for (const dispatcher of new Set<Dispatcher>([...directAgents, ...proxyAgentCache.values(), ...drainingDispatchers])) {
    void Promise.resolve().then(() => dispatcher.destroy()).catch(() => {});
  }
  directAgents.clear();
  proxyAgentCache.clear();
  drainingDispatchers.clear();
}

/**
 * Accounts that resolve to the same proxy share one egress IP, one connection
 * pool and one TLS session cache, which is the classic way a provider clusters
 * a fleet into one entity. Make the topology visible instead of silent.
 */
export function sharedEgressWarning(
  accountProxyUrls: Array<string | undefined>,
  defaultProxyUrl?: string
): string | undefined {
  const groups = new Map<string, number>();
  for (const url of accountProxyUrls) {
    const effective = (url || defaultProxyUrl || '').trim();
    groups.set(effective || '(direct)', (groups.get(effective || '(direct)') ?? 0) + 1);
  }
  const shared = [...groups.entries()].filter(([, count]) => count > 1);
  if (!shared.length) return undefined;
  return shared.map(([url, count]) => `${count} 个账号共用出口 ${url}`).join('；');
}
