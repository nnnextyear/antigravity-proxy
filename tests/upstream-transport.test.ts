import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { getEventListeners, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { requestHttp2, requestUpstream } from '../src/pool/upstream-transport.js';
import { destroyAllDispatchers, getOrCreateDispatcher } from '../src/pool/dispatcher.js';
import { TransportAttempt } from '../src/pool/transport.js';

async function serverFixture(t: any, handler: (response: http.ServerResponse) => void) {
  const server = http.createServer((_req, response) => handler(response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    destroyAllDispatchers();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return 'http://127.0.0.1:' + (server.address() as any).port + '/test';
}

test('upstream buffers the first and last chunks until the consumer starts', async t => {
  const expected = 'data: 你好\n\n' + 'x'.repeat(100000) + '\nlast';
  const url = await serverFixture(t, response => response.end(expected));
  const abort = new AbortController();
  const result = await requestUpstream(url, { signal: abort.signal, bodyTimeout: 2000 });
  const closed = once(result.body, 'close');
  await delay(50);
  assert.equal(await result.body.text(), expected);
  await closed;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('cancellation before headers settles and removes listeners', async t => {
  const url = await serverFixture(t, () => {});
  const abort = new AbortController();
  const pending = requestUpstream(url, { signal: abort.signal, headersTimeout: 2000 });
  setImmediate(() => abort.abort());
  await assert.rejects(pending, (error: any) => error.name === 'AbortError');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('body timeout is an error, never a clean partial response', async t => {
  const url = await serverFixture(t, response => { response.writeHead(200); response.write('partial'); });
  const result = await requestUpstream(url, { bodyTimeout: 50 });
  await assert.rejects(result.body.text(), (error: any) => error.code === 'UND_ERR_BODY_TIMEOUT');
});

test('HTTP/2 sends periodic PING frames while waiting for response headers', async t => {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  let pingCount = 0;
  server.on('session', session => {
    sessions.add(session);
    session.on('ping', () => pingCount++);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', stream => {
    setTimeout(() => {
      if (!stream.destroyed) {
        stream.respond({ ':status': 200 });
        stream.end('alive');
      }
    }, 100);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const url = 'http://127.0.0.1:' + (server.address() as any).port + '/generate';
  const attempt = new TransportAttempt(undefined, 'h2-ping-test', 'http2-ping');
  const response = await requestHttp2(url, {
    method: 'POST', body: '{}', headersTimeout: 1000, bodyTimeout: 1000,
    pingIntervalMs: 15, pingAckTimeoutMs: 100, transportAttempt: attempt
  });
  await delay(50);
  assert.equal(await response.body.text(), 'alive');
  assert.ok(pingCount >= 2, `expected PING frames during the header wait, got ${pingCount}`);
  assert.ok(attempt.pingsAcknowledged >= 2, `expected PING acknowledgements, got ${attempt.pingsAcknowledged}`);
});

test('HTTP/2 cancellation before headers removes the abort listener', async t => {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', session => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const url = 'http://127.0.0.1:' + (server.address() as any).port + '/generate';
  const abort = new AbortController();
  const pending = requestHttp2(url, { signal: abort.signal, headersTimeout: 2000, pingIntervalMs: 100 });
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending, (error: any) => error.name === 'AbortError');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('HTTP/2 response body timeout rejects a partial stream', async t => {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', session => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', stream => {
    stream.respond({ ':status': 200 });
    stream.write('partial');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const url = 'http://127.0.0.1:' + (server.address() as any).port + '/generate';
  const response = await requestHttp2(url, { bodyTimeout: 50, pingIntervalMs: 100 });
  await assert.rejects(response.body.text(), (error: any) => error.code === 'UND_ERR_BODY_TIMEOUT');
});

test('direct connections reuse their managed pool instead of leaking one Agent per request', t => {
  t.after(() => destroyAllDispatchers());
  assert.equal(getOrCreateDispatcher(undefined), getOrCreateDispatcher(undefined));
  assert.notEqual(getOrCreateDispatcher(undefined, { timeoutMs: 1234 }), getOrCreateDispatcher(undefined));
});
