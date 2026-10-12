import { ProxyAgent, Dispatcher } from 'undici';

/**
 * 全局 ProxyAgent 实例缓存池
 * 避免高频请求或后台定时轮询中不断 new ProxyAgent 造成连接池未关闭、socket 泄漏和本地端口耗尽
 */
const proxyAgentCache = new Map<string, ProxyAgent>();

export interface DispatcherOptions {
  timeoutMs?: number;
}

/**
 * 获取或创建复用的 Dispatcher (ProxyAgent) 单例
 * 
 * 正确配置 undici 代理超时：
 * - requestTls: 控制代理隧道建立后，Node.js 到目标服务器的端到端 TLS 握手及 socket 超时
 * - proxyTls: 控制连接本地代理服务器的 TLS/TCP 超时
 * - connect: 控制底层连接器通用超时
 */
export function getOrCreateDispatcher(proxyUrl?: string, options?: DispatcherOptions): Dispatcher | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const timeoutMs = options?.timeoutMs ?? 60000;
  const cacheKey = `${trimmed}__timeout_${timeoutMs}`;

  let dispatcher = proxyAgentCache.get(cacheKey);
  if (!dispatcher) {
    dispatcher = new ProxyAgent({
      uri: trimmed,
      requestTls: { timeout: timeoutMs },
      proxyTls: { timeout: timeoutMs },
      connect: { timeout: timeoutMs }
    } as any);
    proxyAgentCache.set(cacheKey, dispatcher);
  }

  return dispatcher;
}

/** Drop a cached proxy tunnel so the next request establishes a fresh route. */
export function resetDispatcher(proxyUrl?: string, options?: DispatcherOptions): void {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return;

  const timeoutMs = options?.timeoutMs ?? 60000;
  const cacheKey = `${trimmed}__timeout_${timeoutMs}`;
  const dispatcher = proxyAgentCache.get(cacheKey);
  if (!dispatcher) return;

  try {
    dispatcher.destroy();
  } catch {}
  proxyAgentCache.delete(cacheKey);
}

/**
 * 优雅关闭所有缓存的 ProxyAgent 连接池
 */
export function destroyAllDispatchers(): void {
  for (const dispatcher of proxyAgentCache.values()) {
    try {
      dispatcher.destroy();
    } catch {}
  }
  proxyAgentCache.clear();
}
