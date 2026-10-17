import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { setTimeout as delay } from 'node:timers/promises';
import type { Dispatcher } from 'undici';
import { getDispatcherId } from './dispatcher.js';

const currentAttempt = new AsyncLocalStorage<TransportAttempt>();
const attempts = new WeakMap<object, TransportAttempt>();

// CONNECT requests share the async context with their POST. Only observe the
// application request, and never log its authorization headers or prompt.
channel('undici:request:create').subscribe((event: any) => {
  const attempt = currentAttempt.getStore();
  if (attempt && event.request.method === 'POST') attempts.set(event.request, attempt);
});
channel('undici:client:sendHeaders').subscribe((event: any) => {
  const attempt = attempts.get(event.request);
  if (attempt) attempt.sentAt = Date.now();
});
channel('undici:request:bodySent').subscribe((event: any) => {
  const attempt = attempts.get(event.request);
  if (attempt) attempt.uploadedAt = Date.now();
});
channel('undici:request:headers').subscribe((event: any) => {
  const attempt = attempts.get(event.request);
  if (attempt) attempt.headersAt = Date.now();
});

export class TransportAttempt {
  readonly startedAt = Date.now();
  sentAt?: number;
  uploadedAt?: number;
  headersAt?: number;

  constructor(private dispatcher: Dispatcher | undefined, private requestId?: string) {}

  run<T>(operation: () => T): T {
    return currentAttempt.run(this, operation);
  }

  // A generation can be replayed only when its body was never fully sent.
  // `sendHeaders` alone means the request may still be in the upload phase.
  get requestSent(): boolean { return this.uploadedAt !== undefined; }

  describe(): string {
    const phase = this.headersAt ? 'reading-body'
      : this.uploadedAt ? 'waiting-for-headers'
        : this.sentAt ? 'uploading' : 'connecting';
    const elapsed = (time?: number) => time === undefined ? 'pending' : `${time - this.startedAt}ms`;
    return `req=${this.requestId ?? 'unknown'}, dispatcher=${getDispatcherId(this.dispatcher)}, phase=${phase}, elapsed=${Date.now() - this.startedAt}ms, sent=${elapsed(this.sentAt)}, uploaded=${elapsed(this.uploadedAt)}, headers=${elapsed(this.headersAt)}`;
  }
}

export async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

/**
 * Fixed retry delays make every session and every account fire in lockstep,
 * which is exactly the burst shape upstream rate limiters look for. Spread
 * each delay by +/-20%.
 */
export function jittered(ms: number): number {
  return Math.max(1, Math.round(ms * (0.8 + Math.random() * 0.4)));
}
