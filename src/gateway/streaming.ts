import type { FastifyReply, FastifyRequest } from 'fastify';

const DEFAULT_STREAM_KEEPALIVE_MS = 15_000;
const MIN_STREAM_KEEPALIVE_MS = 1_000;

/**
 * Keep a downstream SSE response visibly active while the upstream model is
 * thinking and has not emitted a data chunk yet. SSE comments are ignored by
 * Anthropic/OpenAI clients, but prevent a local reverse proxy or client from
 * treating a valid long-running request as an idle connection.
 */
export function startSseHeartbeat(
  reply: FastifyReply,
  intervalMs = DEFAULT_STREAM_KEEPALIVE_MS,
  frame = ': keepalive\n\n',
  beforeWrite?: () => void
): () => void {
  const interval = Number.isFinite(intervalMs)
    ? Math.max(MIN_STREAM_KEEPALIVE_MS, intervalMs)
    : DEFAULT_STREAM_KEEPALIVE_MS;
  let stopped = false;
  let timer: ReturnType<typeof setInterval>;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  timer = setInterval(() => {
    if (stopped || reply.raw.destroyed || reply.raw.writableEnded) {
      stop();
      return;
    }
    try {
      // Do not accumulate heartbeat frames behind a slow client.
      if (!reply.raw.writableNeedDrain) {
        beforeWrite?.();
        reply.raw.write(frame);
      }
    } catch {
      stop();
    }
  }, interval);
  (timer as any).unref?.();

  return stop;
}

export type GatewayProtocol = 'anthropic' | 'chat' | 'responses';

/** Replies whose SSE headers were already written (hijack() alone does not show up in headersSent). */
const preparedReplies = new WeakSet<object>();

export function prepareSseResponse(reply: FastifyReply): void {
  if (reply.raw.headersSent || preparedReplies.has(reply.raw)) return;
  preparedReplies.add(reply.raw);
  // Preserve Fastify's request-id and CORS headers when taking over the socket.
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  hijackReply(reply);
}

/**
 * Fastify only stops owning the response after `hijack()`. `raw.headersSent`
 * stays false until the first byte is flushed, so a reply can be hijacked
 * without any header being sent yet.
 */
function hijackReply(reply: FastifyReply): void {
  if (reply.sent) return;
  reply.hijack();
}

/** Observe response closure even after the incoming POST has been fully read. */
export function startRequestLifecycle(req: FastifyRequest, reply: FastifyReply, stream: boolean, intervalMs?: number) {
  const controller = new AbortController();
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  const stopHeartbeat = stream
    ? startSseHeartbeat(reply, intervalMs, ': keepalive\n\n', () => prepareSseResponse(reply))
    : () => {};
  const onAborted = () => { abort(); dispose(); };
  const onClose = () => {
    if (!reply.raw.writableEnded) abort();
    dispose();
  };
  const onFinish = () => dispose();
  const dispose = () => {
    stopHeartbeat();
    req.raw.removeListener('aborted', onAborted);
    reply.raw.removeListener('close', onClose);
    // The listener identity must match what was registered, otherwise the
    // closure stays attached for the lifetime of the response object.
    reply.raw.removeListener('finish', onFinish);
  };
  req.raw.once('aborted', onAborted);
  reply.raw.once('close', onClose);
  reply.raw.once('finish', onFinish);
  if (req.raw.aborted || reply.raw.destroyed) onAborted();
  return { signal: controller.signal, abort };
}

/** Anthropic wire-level error types; clients back off differently per type. */
export function anthropicErrorType(statusCode: number): string {
  if (statusCode === 400) return 'invalid_request_error';
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 403) return 'permission_error';
  if (statusCode === 404) return 'not_found_error';
  if (statusCode === 413) return 'request_too_large';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode === 503 || statusCode === 529) return 'overloaded_error';
  return 'api_error';
}

export interface GatewayErrorOptions {
  /** Upstream Retry-After, kept in-band when the HTTP status is already sent. */
  retryAfterSeconds?: string;
}

/**
 * HTTP status is immutable once a waiting heartbeat has opened the SSE stream.
 * Every error path must therefore go through here: before the stream opens the
 * client gets a real HTTP status, afterwards a protocol-correct error frame
 * that still carries the upstream retry hint.
 */
export function sendGatewayError(
  reply: FastifyReply,
  statusCode: number,
  payload: any,
  protocol: GatewayProtocol,
  options: GatewayErrorOptions = {}
) {
  if (reply.raw.destroyed || reply.raw.writableEnded) return reply;
  // `reply.sent` is true when Fastify was hijacked, even if no byte was flushed
  // yet; calling reply.send() in that state is a silent no-op that would hang
  // the client forever.
  const fastifyOwnsReply = !reply.sent && !reply.raw.headersSent;
  if (fastifyOwnsReply) return reply.status(statusCode).send(payload);

  const retryAfter = options.retryAfterSeconds ?? payload?.retry_after;
  // The real status can no longer travel in the status line, so carry it in
  // the frame: clients that back off on 429/503 still have the information.
  const upstreamStatus = { status: statusCode };
  if (protocol === 'anthropic') {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({
      ...payload,
      error: { ...payload.error, ...upstreamStatus },
      ...(retryAfter ? { retry_after: retryAfter } : {})
    })}\n\n`);
  } else if (protocol === 'responses') {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({
      type: 'error',
      code: payload.error?.type ?? 'api_error',
      message: payload.error?.message ?? 'Upstream request failed',
      param: null,
      ...upstreamStatus,
      ...(retryAfter ? { retry_after: retryAfter } : {})
    })}\n\n`);
  } else {
    reply.raw.write(`data: ${JSON.stringify({
      ...payload,
      error: { ...(payload.error ?? {}), ...upstreamStatus },
      ...(retryAfter ? { retry_after: retryAfter } : {})
    })}\n\ndata: [DONE]\n\n`);
  }
  reply.raw.end();
  return reply;
}
