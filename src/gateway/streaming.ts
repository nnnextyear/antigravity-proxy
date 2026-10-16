import type { FastifyReply } from 'fastify';

const DEFAULT_STREAM_KEEPALIVE_MS = 15_000;

/**
 * Keep a downstream SSE response visibly active while the upstream model is
 * thinking and has not emitted a data chunk yet. SSE comments are ignored by
 * Anthropic/OpenAI clients, but prevent a local reverse proxy or client from
 * treating a valid long-running request as an idle connection.
 */
export function startSseHeartbeat(
  reply: FastifyReply,
  intervalMs = DEFAULT_STREAM_KEEPALIVE_MS,
  frame = ': keepalive\n\n'
): () => void {
  const interval = Number.isFinite(intervalMs) ? Math.max(5_000, intervalMs) : DEFAULT_STREAM_KEEPALIVE_MS;
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
      reply.raw.write(frame);
    } catch {
      stop();
    }
  }, interval);
  (timer as any).unref?.();

  return stop;
}
