import crypto from 'crypto';

type HeadersLike = Record<string, unknown> | undefined;
type Protocol = 'anthropic' | 'openai' | 'responses';

function normalized(value: unknown): string | undefined {
  if (Array.isArray(value)) return normalized(value[0]);
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

interface MetadataIdentity { session?: string; parent?: string; agent?: string; parentAgent?: string; opaque?: string }

function metadataIdentity(value: unknown): MetadataIdentity {
  const raw = normalized(value);
  if (!raw) return {};
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const session = normalized(parsed.session_id ?? parsed.sessionId ?? parsed.conversation_id ?? parsed.conversationId);
      if (session) return { session,
        parent: normalized(parsed.parent_session_id ?? parsed.parentSessionId),
        agent: normalized(parsed.agent_id ?? parsed.agentId ?? parsed.subagent_id ?? parsed.subagentId),
        parentAgent: normalized(parsed.parent_agent_id ?? parsed.parentAgentId) };
    } catch { /* Fall back to legacy or opaque metadata. */ }
  }
  const legacy = raw.match(/_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|_)/i);
  if (legacy) return { session: legacy[1] };
  const match = raw.match(/(?:session[_-]?id|session)\s*[:=]\s*["']?([^,"'}\s]+)["']?/i);
  if (match?.[1]) return { session: match[1] };
  return { opaque: 'claude-user:' + raw };
}

function bodyValue(body: any, ...paths: string[]): string | undefined {
  for (const path of paths) {
    let current = body;
    for (const part of path.split('.')) {
      if (current == null || typeof current !== 'object') { current = undefined; break; }
      current = current[part];
    }
    const value = normalized(current);
    if (value) return value;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: any) => typeof part === 'string' ? part
    : part?.text ?? part?.input_text ?? part?.output_text ?? '').filter(Boolean).join('\n');
}

function firstUserText(body: any): string | undefined {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const message = messages.find((item: any) => item?.role === 'user');
  if (message) return textFromContent(message.content).trim() || undefined;
  const input = Array.isArray(body?.input) ? body.input : [];
  const item = input.find((entry: any) => typeof entry === 'string' || entry?.role === 'user' || entry?.type === 'message');
  if (typeof item === 'string') return item.trim() || undefined;
  if (item) return textFromContent(item.content).trim() || undefined;
  return normalized(body?.input);
}

export interface SessionIdentity {
  /** Logical request identity, including the child agent when supplied. */
  sessionKey: string;
  /** Account affinity and fair queue ownership. Children inherit this root. */
  rootKey: string;
  parentKey?: string;
  agentId?: string;
  source: 'explicit' | 'metadata' | 'cache-key' | 'user' | 'content';
}

export function extractSessionIdentity(headers: HeadersLike, body: any, protocol: Protocol): SessionIdentity | undefined {
  const lowered = Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const header = (...names: string[]) => names.map(name => normalized(lowered[name])).find(Boolean);
  const metadata = metadataIdentity(bodyValue(body, 'metadata.user_id', 'request.metadata.user_id'));
  const canonical = (value: string) => protocol === 'anthropic' && !value.startsWith('claude:') ? 'claude:' + value : value;
  const headerSession = header('x-claude-code-session-id', 'x-session-id', 'session-id', 'x-http-session-id',
    'x-session-affinity', 'x-slot-session-id', 'conversation-id', 'x-conversation-id', 'x-thread-id');
  const explicit = bodyValue(body, 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId',
    'conversation.id', 'request.sessionId', 'metadata.session_id', 'metadata.sessionId', 'prompt_cache_key', 'promptCacheKey');
  const session = headerSession || explicit || metadata.session;
  if (session) {
    const cacheKey = bodyValue(body, 'prompt_cache_key', 'promptCacheKey');
    const explicitSession = bodyValue(body, 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId',
      'conversation.id', 'request.sessionId', 'metadata.session_id', 'metadata.sessionId');
    const isCacheKey = !headerSession && !explicitSession && !!cacheKey;
    const parent = header('x-claude-code-parent-session-id', 'x-parent-session-id')
      || bodyValue(body, 'parent_session_id', 'parentSessionId', 'metadata.parent_session_id',
        'metadata.parentSessionId', 'request.metadata.parent_session_id') || metadata.parent;
    const agent = header('x-claude-code-agent-id', 'x-agent-id')
      || bodyValue(body, 'agent_id', 'agentId', 'metadata.agent_id', 'metadata.subagent_id') || metadata.agent;
    const parentAgent = header('x-claude-code-parent-agent-id')
      || bodyValue(body, 'metadata.parent_agent_id', 'parent_agent_id') || metadata.parentAgent;
    const base = isCacheKey ? 'pck:' + session : canonical(session);
    const rootKey = parent ? canonical(parent) : base;
    const sessionKey = agent && agent !== 'main' ? base + ':agent:' + encodeURIComponent(agent) : base;
    const parentKey = parentAgent && parentAgent !== 'main' ? rootKey + ':agent:' + encodeURIComponent(parentAgent)
      : sessionKey !== rootKey ? rootKey : undefined;
    return { sessionKey, rootKey, parentKey, agentId: agent,
      source: isCacheKey ? 'cache-key' : headerSession || explicit ? 'explicit' : 'metadata' };
  }
  if (metadata.opaque) return { sessionKey: metadata.opaque, rootKey: metadata.opaque, source: 'metadata' };
  const user = bodyValue(body, 'user');
  if (user) return { sessionKey: 'user:' + user, rootKey: 'user:' + user, source: 'user' };
  // A complete first user message is only a weak fallback. Never include the changing system prompt.
  const text = firstUserText(body);
  if (!text) return undefined;
  const key = crypto.createHash('sha256').update(protocol + '_session\0' + text).digest('hex');
  return { sessionKey: key, rootKey: key, source: 'content' };
}

/** Cache-first account routing inherits the root, without erasing child identity. */
export function extractSessionKey(headers: HeadersLike, body: any, protocol: Protocol): string | undefined {
  return extractSessionIdentity(headers, body, protocol)?.rootKey;
}

/** Correlate routing without printing client identifiers or prompt contents. */
export function logSessionIdentity(identity: SessionIdentity | undefined, requestId: string): void {
  if (!identity) return;
  const short = (value: string | undefined) => value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 12) : 'none';
  console.info('[Session] req=' + requestId + ' root=' + short(identity.rootKey)
    + ' session=' + short(identity.sessionKey) + ' parent=' + short(identity.parentKey) + ' source=' + identity.source);
}

/** Attach a deterministic Antigravity request.sessionId to generation calls. */
export function attachUpstreamSessionId(payload: { request?: { sessionId?: string } }, sessionKey?: string, force = false): void {
  if (!sessionKey || !payload.request) return;
  if (payload.request.sessionId && !force) return;
  const digest = crypto.createHash('sha256').update('antigravity-session\0' + sessionKey).digest('hex');
  const value = BigInt('0x' + digest.slice(0, 15)) & BigInt('0x7fffffffffffffff');
  payload.request.sessionId = '-' + value.toString();
}
