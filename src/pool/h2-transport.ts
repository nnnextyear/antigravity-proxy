import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { request as undiciRequest } from 'undici';

const PING_INTERVAL_MS = 15_000;

/**
 * Direct HTTPS transport for long CloudCode generations. HTTP/2 PING frames
 * keep a transparent/TUN route active while Google is still preparing the
 * first response headers. A normal HTTP request cannot safely write heartbeat
 * bytes into an in-flight TLS request.
 */
export async function requestUpstream(url: string, options: any, proxyUrl?: string): Promise<any> {
  if (options.signal?.aborted) throw abortError();
  if (!/^https:/i.test(url)) {
    return undiciRequest(url, options);
  }

  const target = new URL(url);
  const connectTimeoutMs = Number(options.connectTimeout) > 0 ? Number(options.connectTimeout) : 60_000;
  const attempt = options.transportAttempt;
  const tunnel = proxyUrl ? await openConnectTunnel(proxyUrl, target, options.signal, connectTimeoutMs) : undefined;
  const secureSocket = tunnel ? await wrapTargetTls(tunnel, target, options.signal, connectTimeoutMs, attempt) : undefined;
  const session = http2.connect(target.origin, {
    rejectUnauthorized: true,
    keepAlive: true,
    keepAliveInitialDelay: 15_000,
    ...(secureSocket ? { createConnection: () => secureSocket } : {})
  } as any);
  session.once('connect', () => attempt?.markConnected());
  let pingTimer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
  };
  const fail = (err: any) => {
    cleanup();
    if (!session.destroyed) session.destroy();
    return err;
  };

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null) headers[key.toLowerCase()] = String(value);
  }
  const req = session.request({
    ':method': options.method || 'GET',
    ':path': `${target.pathname}${target.search}`,
    ...headers
  });
  req.once('ready', () => attempt?.markSent());

  pingTimer = setInterval(() => {
    if (session.destroyed || session.closed || session.connecting) return;
    session.ping((err) => {
      if (err && !session.destroyed) session.destroy(err);
    });
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  if (options.signal) {
    if (options.signal.aborted) req.close(http2.constants.NGHTTP2_CANCEL);
    options.signal.addEventListener('abort', () => {
      cleanup();
      if (!req.destroyed) req.close(http2.constants.NGHTTP2_CANCEL);
      if (!session.destroyed) session.close();
    }, { once: true });
  }

  return await new Promise((resolve, reject) => {
    let responseHeaders: http2.IncomingHttpHeaders | undefined;
    const timeoutMs = Number(options.headersTimeout) > 0 ? Number(options.headersTimeout) : 900_000;
    const timeout = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      fail(Object.assign(new Error(`HTTP/2 response headers timeout after ${timeoutMs}ms`), { code: 'UND_ERR_HEADERS_TIMEOUT' }));
      reject(new Error(`HTTP/2 response headers timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    req.once('response', (headers) => {
      attempt?.markHeaders();
      responseHeaders = headers;
      clearTimeout(timeout);
      const statusCode = Number(headers[':status'] || 0);
      // Keep the Undici response shape used by the executor. Node's HTTP/2
      // stream is async-iterable, but it does not provide Undici's text/json
      // helpers, which are needed when an upstream error has a response body.
      const body: any = req;
      body.text = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
      };
      body.json = async () => JSON.parse(await body.text());
      let bodyTimer: NodeJS.Timeout | undefined;
      const bodyTimeoutMs = Number(options.bodyTimeout) > 0 ? Number(options.bodyTimeout) : 0;
      const armBodyTimeout = () => {
        if (!bodyTimeoutMs) return;
        if (bodyTimer) clearTimeout(bodyTimer);
        bodyTimer = setTimeout(() => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          req.destroy(Object.assign(new Error(`HTTP/2 response body timeout after ${bodyTimeoutMs}ms`), { code: 'UND_ERR_BODY_TIMEOUT' }));
        }, bodyTimeoutMs);
        bodyTimer.unref?.();
      };
      const finish = () => {
        if (bodyTimer) clearTimeout(bodyTimer);
        cleanup();
        if (!session.destroyed) session.close();
      };
      req.on('data', armBodyTimeout);
      armBodyTimeout();
      body.once('end', finish);
      body.once('error', finish);
      resolve({ statusCode, headers, body });
    });
    req.once('error', (err) => {
      clearTimeout(timeout);
      if (!responseHeaders) reject(fail(err));
    });
    session.once('error', (err) => {
      clearTimeout(timeout);
      if (!responseHeaders) reject(fail(err));
    });
    session.once('close', () => {
      if (!responseHeaders) {
        clearTimeout(timeout);
        reject(fail(Object.assign(new Error('HTTP/2 session closed before response headers'), { code: 'UND_ERR_SOCKET' })));
      }
    });

    if (options.body !== undefined && options.body !== null) {
      req.end(options.body, () => attempt?.markUploaded());
    } else {
      req.end(() => attempt?.markUploaded());
    }
  });
}

function abortError(): Error {
  return Object.assign(new Error('Upstream request aborted by client.'), { code: 'ABORT_ERR' });
}

export async function openConnectTunnel(proxyUrl: string, target: URL, signal?: AbortSignal, timeoutMs = 60_000, attempt?: any): Promise<Duplex> {
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) {
    throw new Error(`Unsupported HTTP proxy URL: ${proxyUrl}`);
  }
  const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const socket = await new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(Object.assign(new Error(`Proxy CONNECT timed out after ${timeoutMs}ms`), { code: 'UND_ERR_CONNECT_TIMEOUT' })), timeoutMs);
    const raw = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: proxy.hostname, port });
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      raw.removeAllListeners('data');
      raw.destroy();
      reject(err);
    };
    const onAbort = () => fail(abortError());
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    raw.once('error', fail);
    raw.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const authority = `${target.hostname}:${target.port || 443}`;
      const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive'];
      if (proxy.username || proxy.password) {
        headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`);
      }
      raw.write(`${headers.join('\r\n')}\r\n\r\n`);
      let data = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 64 * 1024) return fail(new Error('HTTP proxy CONNECT response headers exceeded 64 KiB'));
        const end = data.indexOf('\r\n\r\n');
        if (end < 0) return;
        raw.removeListener('data', onData);
        const head = data.subarray(0, end).toString('latin1');
        const status = Number(/^HTTP\/\d\.\d\s+(\d+)/i.exec(head)?.[1] || 0);
        if (status !== 200) return fail(new Error(`HTTP proxy CONNECT failed with status ${status}`));
        settled = true;
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', onAbort);
        const rest = data.subarray(end + 4);
        if (rest.length) raw.unshift(rest);
        resolve(raw);
      };
      raw.on('data', onData);
    });
  });
  return socket;
}

async function wrapTargetTls(tunnel: Duplex, target: URL, signal?: AbortSignal, timeoutMs = 60_000, attempt?: any): Promise<tls.TLSSocket> {
  return await new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: tunnel, servername: target.hostname, ALPNProtocols: ['h2'], rejectUnauthorized: true });
    let settled = false;
    const timeout = setTimeout(() => fail(Object.assign(new Error(`Upstream TLS handshake timed out after ${timeoutMs}ms`), { code: 'UND_ERR_CONNECT_TIMEOUT' })), timeoutMs);
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      secure.destroy();
      reject(err);
    };
    const onAbort = () => fail(abortError());
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    secure.once('error', fail);
    secure.once('secureConnect', () => {
      attempt?.markConnected();
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(secure);
    });
  });
}
