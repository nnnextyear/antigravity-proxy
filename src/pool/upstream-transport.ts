import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { getOrCreateDispatcher } from './dispatcher.js';
import type { TransportAttempt } from './transport.js';

type UpstreamOptions = Omit<NonNullable<Parameters<typeof request>[1]>, 'signal'> & {
  signal?: AbortSignal;
  connectTimeout?: number;
  transportAttempt?: TransportAttempt;
};

type Http2Options = UpstreamOptions & {
  pingIntervalMs?: number;
  pingAckTimeoutMs?: number;
};

const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_PING_ACK_TIMEOUT_MS = 30_000;
const activeHttp2Sessions = new Set<http2.ClientHttp2Session>();

/** HTTP/1.1 transport for control-plane calls and non-HTTPS test endpoints. */
export function requestUpstream(url: string, options: UpstreamOptions, proxyUrl?: string) {
  const { connectTimeout, transportAttempt: _attempt, ...requestOptions } = options;
  const dispatcher: Dispatcher | undefined = options.dispatcher
    ?? getOrCreateDispatcher(proxyUrl, { timeoutMs: connectTimeout });
  return request(url, { ...requestOptions, dispatcher });
}

/** Generation requests use HTTP/2 PINGs to keep Google's active connection alive. */
export function requestUpstreamWithPing(url: string, options: Http2Options, proxyUrl?: string) {
  if (!url.toLowerCase().startsWith('https://')) return requestUpstream(url, options, proxyUrl);
  return requestHttp2(url, options, proxyUrl);
}

export function destroyAllUpstreamSessions(): void {
  for (const session of activeHttp2Sessions) session.destroy();
  activeHttp2Sessions.clear();
}

export function requestHttp2(url: string, options: Http2Options, proxyUrl?: string): Promise<any> {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return Promise.reject(new Error(`Unsupported upstream protocol: ${target.protocol}`));
  }
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError());

  return connectHttp2(target, options, proxyUrl).then(session => new Promise((resolve, reject) => {
    if (signal?.aborted || session.destroyed || session.closed) {
      session.destroy();
      reject(signal?.aborted ? abortError() : codedError('HTTP/2 session closed before request.', 'UND_ERR_SOCKET'));
      return;
    }

    const headers: Record<string, string> = {
      ':method': options.method || 'GET',
      ':path': `${target.pathname}${target.search}`
    };
    for (const [name, value] of Object.entries(options.headers || {})) {
      if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value);
    }
    const body = options.body as string | Uint8Array | undefined;
    if (body !== undefined && body !== null && !headers['content-length']) {
      headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
    }

    let req: http2.ClientHttp2Stream;
    try {
      req = session.request(headers);
    } catch (error) {
      session.destroy();
      reject(error);
      return;
    }

    const attempt = options.transportAttempt;
    let responseStarted = false;
    let promiseSettled = false;
    let goAwayReason: string | undefined;
    let pingInFlight: number | undefined;
    let pingSequence = 0;
    let headerTimer: NodeJS.Timeout | undefined;
    let bodyTimer: NodeJS.Timeout | undefined;
    let pingTimer: NodeJS.Timeout | undefined;
    let pingAckTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const clearTimers = () => {
      if (headerTimer) clearTimeout(headerTimer);
      if (bodyTimer) clearTimeout(bodyTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (pingAckTimer) clearTimeout(pingAckTimer);
      headerTimer = bodyTimer = pingTimer = pingAckTimer = undefined;
      pingInFlight = undefined;
    };
    const removeAbortListener = () => {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      abortListener = undefined;
    };
    const closeSession = (destroy = false) => {
      clearTimers();
      removeAbortListener();
      if (!session.destroyed && !session.closed) {
        if (destroy) session.destroy();
        else session.close();
      }
    };
    const failBeforeResponse = (error: Error) => {
      if (promiseSettled) return;
      promiseSettled = true;
      clearTimers();
      removeAbortListener();
      req.close(http2.constants.NGHTTP2_CANCEL);
      closeSession(true);
      reject(error);
    };
    const failActiveStream = (error: Error) => {
      if (req.destroyed) return;
      req.destroy(error);
      closeSession(true);
    };
    const armBodyTimeout = () => {
      const timeoutMs = Number(options.bodyTimeout) || 0;
      if (!timeoutMs) return;
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => {
        const error = codedError(`HTTP/2 response body timeout after ${timeoutMs}ms`, 'UND_ERR_BODY_TIMEOUT');
        failActiveStream(error);
      }, timeoutMs);
      bodyTimer.unref?.();
    };
    const pingFailure = (error: Error) => {
      if (responseStarted) failActiveStream(error);
      else failBeforeResponse(error);
    };
    const sendPing = () => {
      if (session.destroyed || session.closed || session.connecting || pingInFlight !== undefined) return;
      const sequence = ++pingSequence;
      pingInFlight = sequence;
      attempt?.markPingSent();
      const ackTimeoutMs = Math.max(1, Number(options.pingAckTimeoutMs) || DEFAULT_PING_ACK_TIMEOUT_MS);
      pingAckTimer = setTimeout(() => {
        if (pingInFlight !== sequence) return;
        pingInFlight = undefined;
        pingAckTimer = undefined;
        pingFailure(codedError(`HTTP/2 PING acknowledgement timed out after ${ackTimeoutMs}ms`, 'UND_ERR_SOCKET'));
      }, ackTimeoutMs);
      pingAckTimer.unref?.();
      try {
        session.ping(error => {
          if (pingInFlight !== sequence) return;
          pingInFlight = undefined;
          if (pingAckTimer) clearTimeout(pingAckTimer);
          pingAckTimer = undefined;
          if (error) pingFailure(error);
          else attempt?.markPingAcknowledged();
        });
      } catch (error: any) {
        if (pingInFlight === sequence) {
          pingInFlight = undefined;
          if (pingAckTimer) clearTimeout(pingAckTimer);
          pingAckTimer = undefined;
          pingFailure(error);
        }
      }
    };

    const headersTimeoutMs = Number(options.headersTimeout) || 900_000;
    headerTimer = setTimeout(() => {
      failBeforeResponse(codedError(`HTTP/2 response headers timeout after ${headersTimeoutMs}ms`, 'UND_ERR_HEADERS_TIMEOUT'));
    }, headersTimeoutMs);
    headerTimer.unref?.();

    const pingIntervalMs = Math.max(1, Number(options.pingIntervalMs) || DEFAULT_PING_INTERVAL_MS);
    pingTimer = setInterval(sendPing, pingIntervalMs);
    pingTimer.unref?.();

    const onSessionError = (error: Error) => {
      if (responseStarted) failActiveStream(error);
      else failBeforeResponse(error);
    };
    const onSessionClose = () => {
      activeHttp2Sessions.delete(session);
      if (!responseStarted) {
        const resetCode = (req as any).rstCode;
        const details = [goAwayReason, resetCode === undefined ? undefined : `RST_STREAM=${resetCode}`]
          .filter(Boolean).join(', ');
        failBeforeResponse(codedError(
          `HTTP/2 session closed before response headers${details ? ` (${details})` : ''}.`,
          'UND_ERR_SOCKET'
        ));
      }
    };
    const onRequestError = (error: Error) => {
      if (responseStarted) closeSession(true);
      else failBeforeResponse(error);
    };
    const onAbort = () => {
      const error = abortError();
      if (responseStarted) failActiveStream(error);
      else failBeforeResponse(error);
    };

    session.on('error', onSessionError);
    session.on('goaway', (code, lastStreamID) => {
      goAwayReason = `GOAWAY=${code} lastStreamID=${lastStreamID}`;
    });
    session.once('close', onSessionClose);
    req.once('error', onRequestError);
    req.once('ready', () => attempt?.markSent());
    req.once('response', responseHeaders => {
      responseStarted = true;
      attempt?.markHeaders();
      if (headerTimer) clearTimeout(headerTimer);
      headerTimer = undefined;
      const statusCode = Number(responseHeaders[':status'] || 0);
      const responseBody: any = req;
      responseBody.text = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
      };
      responseBody.json = async () => JSON.parse(await responseBody.text());
      req.on('readable', armBodyTimeout);
      armBodyTimeout();
      const finishBody = () => closeSession();
      req.once('end', finishBody);
      req.once('error', finishBody);
      if (!promiseSettled) {
        promiseSettled = true;
        resolve({ statusCode, headers: responseHeaders, body: responseBody });
      }
    });
    if (signal) {
      abortListener = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.end(body, () => attempt?.markUploaded());
  }));
}

async function connectHttp2(target: URL, options: Http2Options, proxyUrl?: string): Promise<http2.ClientHttp2Session> {
  const timeoutMs = Math.max(1, Number(options.connectTimeout) || 60_000);
  const signal = options.signal;
  let secureSocket: tls.TLSSocket | undefined;
  const trimmedProxy = proxyUrl?.trim();

  if (target.protocol === 'https:' && trimmedProxy) {
    const tunnel = await openConnectTunnel(trimmedProxy, target, signal, timeoutMs);
    secureSocket = await wrapTargetTls(tunnel, target, signal, timeoutMs);
  }

  if (signal?.aborted) {
    secureSocket?.destroy();
    throw abortError();
  }

  const session = http2.connect(target.origin, secureSocket
    ? { createConnection: () => secureSocket! }
    : { rejectUnauthorized: true, ALPNProtocols: target.protocol === 'https:' ? ['h2'] : undefined });
  activeHttp2Sessions.add(session);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(codedError(`HTTP/2 connection timed out after ${timeoutMs}ms`, 'UND_ERR_CONNECT_TIMEOUT')), timeoutMs);
    timer.unref?.();
    const onAbort = () => fail(abortError());
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(codedError('HTTP/2 session closed during connection.', 'UND_ERR_SOCKET'));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      session.removeListener('connect', onConnect);
      session.removeListener('error', onError);
      session.removeListener('close', onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      activeHttp2Sessions.delete(session);
      session.destroy();
      reject(error);
    };
    const onConnect = () => {
      if (settled) return;
      const alpn = (session.socket as tls.TLSSocket).alpnProtocol;
      if (target.protocol === 'https:' && alpn && alpn !== 'h2') {
        fail(codedError(`Upstream negotiated ${alpn} instead of HTTP/2.`, 'ERR_HTTP2_ALPN_PROTOCOL'));
        return;
      }
      settled = true;
      cleanup();
      options.transportAttempt?.markConnected();
      resolve(session);
    };
    session.once('connect', onConnect);
    session.once('error', onError);
    session.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function openConnectTunnel(proxyUrl: string, target: URL, signal?: AbortSignal, timeoutMs = 60_000): Promise<Duplex> {
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) {
    throw new Error(`Unsupported HTTP proxy URL: ${proxyUrl}`);
  }
  if (signal?.aborted) throw abortError();

  const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const raw: Duplex = proxy.protocol === 'https:'
    ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
    : net.connect({ host: proxy.hostname, port });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => fail(codedError(`Proxy CONNECT timed out after ${timeoutMs}ms`, 'UND_ERR_CONNECT_TIMEOUT')), timeoutMs);
    timer.unref?.();
    const onAbort = () => fail(abortError());
    const onError = (error: Error) => fail(error);
    const connectedEvent = proxy.protocol === 'https:' ? 'secureConnect' : 'connect';
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      raw.removeListener('error', onError);
      raw.removeListener(connectedEvent, onConnected);
      raw.removeListener('data', onData);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      raw.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (received.length > 64 * 1024) {
        fail(new Error('HTTP proxy CONNECT response headers exceeded 64 KiB'));
        return;
      }
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headerText = received.subarray(0, end).toString('latin1');
      const status = Number(/^HTTP\/\d\.\d\s+(\d+)/i.exec(headerText)?.[1] || 0);
      if (status !== 200) {
        fail(new Error(`HTTP proxy CONNECT failed with status ${status}`));
        return;
      }
      settled = true;
      cleanup();
      const remaining = received.subarray(end + 4);
      if (remaining.length) (raw as any).unshift(remaining);
      resolve(raw);
    };
    const onConnected = () => {
      const authority = `${target.hostname}:${target.port || 443}`;
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive'];
      if (proxy.username || proxy.password) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
      }
      raw.write(`${lines.join('\r\n')}\r\n\r\n`);
      raw.on('data', onData);
    };

    raw.once('error', onError);
    raw.once(connectedEvent, onConnected);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function wrapTargetTls(tunnel: Duplex, target: URL, signal: AbortSignal | undefined, timeoutMs: number): Promise<tls.TLSSocket> {
  const secure = tls.connect({
    socket: tunnel as any,
    servername: target.hostname,
    ALPNProtocols: ['h2'],
    rejectUnauthorized: true
  });
  if (signal?.aborted) {
    secure.destroy();
    throw abortError();
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(codedError(`Upstream TLS handshake timed out after ${timeoutMs}ms`, 'UND_ERR_CONNECT_TIMEOUT')), timeoutMs);
    timer.unref?.();
    const onAbort = () => fail(abortError());
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      secure.removeListener('secureConnect', onSecureConnect);
      secure.removeListener('error', onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      secure.destroy();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onSecureConnect = () => {
      if (secure.alpnProtocol !== 'h2') {
        fail(codedError(`Upstream negotiated ${secure.alpnProtocol || 'no ALPN'} instead of HTTP/2.`, 'ERR_HTTP2_ALPN_PROTOCOL'));
        return;
      }
      settled = true;
      cleanup();
      resolve(secure);
    };
    secure.once('secureConnect', onSecureConnect);
    secure.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function abortError(): Error {
  return Object.assign(new Error('Upstream request aborted by client.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
