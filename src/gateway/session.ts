import crypto from 'crypto';

type HeadersLike = Record<string, unknown> | undefined;

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalized(value: unknown): string | undefined {
  return firstString(value);
}

function metadataSession(value: unknown): string | undefined {
  const raw = firstString(value);
  if (!raw) return undefined;

  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const session = normalized(parsed.session_id ?? parsed.sessionId ?? parsed.conversation_id ?? parsed.conversationId);
      if (session) {
        const agent = normalized(parsed.agent_id ?? parsed.agentId ?? parsed.subagent_id ?? parsed.subagentId);
        return agent && agent !== 'main' ? `claude:${session}:agent:${agent}` : `claude:${session}`;
      }
    } catch {
      // Keep the opaque value below when a client sends legacy non-JSON metadata.
    }
  }

  const match = raw.match(/(?:session[_-]?id|session)\s*[:=]\s*["']?([^,"'}\s]+)["']?/i);
  if (match?.[1]) return `claude:${match[1]}`;
  return `claude-user:${raw}`;
}

function bodyValue(body: any, ...paths: string[]): string | undefined {
  for (const path of paths) {
    let current = body;
    for (const part of path.split('.')) {
      if (current == null || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[part];
    }
    const result = normalized(current);
    if (result) return result;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: any) => {
    if (typeof part === 'string') return part;
    return part?.text ?? part?.input_text ?? part?.output_text ?? '';
  }).filter(Boolean).join('\n');
}

function firstUserText(body: any): string | undefined {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const message = messages.find((item: any) => item?.role === 'user');
  if (message) return textFromContent(message.content).trim() || undefined;

  const input = Array.isArray(body?.input) ? body.input : [];
  const inputItem = input.find((item: any) => typeof item === 'string' || item?.role === 'user' || item?.type === 'message');
  if (typeof inputItem === 'string') return inputItem.trim() || undefined;
  if (inputItem) return textFromContent(inputItem.content).trim() || undefined;
  if (typeof body?.input === 'string') return body.input.trim() || undefined;
  return undefined;
}

/**
 * Resolve one stable identity for account affinity. Explicit client IDs always
 * win; a first-turn content hash is only a last resort for clients that send
 * no session/conversation metadata at all.
 */
export function extractSessionKey(headers: HeadersLike, body: any, protocol: 'anthropic' | 'openai' | 'responses'): string | undefined {
  const headerNames = [
    'x-claude-code-session-id',
    'x-session-id',
    'session-id',
    'x-http-session-id',
    'x-session-affinity',
    'x-slot-session-id',
    'conversation-id',
    'x-conversation-id',
    'x-thread-id'
  ];
  for (const name of headerNames) {
    const value = normalized(headers?.[name] ?? headers?.[name.toLowerCase()]);
    if (value) return value;
  }

  const explicit = bodyValue(
    body,
    'session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId',
    'conversation.id', 'request.sessionId', 'metadata.session_id', 'metadata.sessionId',
    'prompt_cache_key', 'promptCacheKey'
  );
  if (explicit) {
    const isPromptCacheKey = bodyValue(body, 'prompt_cache_key', 'promptCacheKey') === explicit;
    return isPromptCacheKey ? `pck:${explicit}` : explicit;
  }

  const metadataUser = metadataSession(bodyValue(body, 'metadata.user_id', 'request.metadata.user_id'));
  if (metadataUser) return metadataUser;

  // OpenAI's user field is weaker than a conversation ID, but is still more
  // stable than hashing a changing request body.
  const user = bodyValue(body, 'user');
  if (user) return `user:${user}`;

  const firstText = firstUserText(body);
  if (!firstText) return undefined;
  return crypto.createHash('sha256')
    .update(`${protocol}_session\0${firstText.substring(0, 4000)}`)
    .digest('hex');
}

/** Attach a deterministic Antigravity request.sessionId to generation calls. */
export function attachUpstreamSessionId(payload: { request?: { sessionId?: string } }, sessionKey?: string): void {
  if (!sessionKey || !payload.request || payload.request.sessionId) return;
  const digest = crypto.createHash('sha256').update(`antigravity-session\0${sessionKey}`).digest('hex');
  const value = BigInt(`0x${digest.slice(0, 15)}`) & BigInt('0x7fffffffffffffff');
  payload.request.sessionId = `-${value.toString()}`;
}
