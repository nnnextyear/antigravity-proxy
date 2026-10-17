import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openConnectTunnel } from '../src/pool/h2-transport.js';

async function withServer(handler: (socket: net.Socket) => void, run: (port: number) => Promise<void>): Promise<void> {
  const server = net.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(address.port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('HTTP CONNECT tunnel forwards data after the tunnel is established', async () => {
  await withServer(socket => {
    socket.once('data', data => {
      assert.match(data.toString(), /^CONNECT example\.test:443 HTTP\/1\.1\r\n/);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => socket.end('probe-data'), 20);
    });
  }, async port => {
    const tunnel = await openConnectTunnel(`http://127.0.0.1:${port}`, new URL('https://example.test/path'), undefined, 1000);
    const chunks: Buffer[] = [];
    for await (const chunk of tunnel) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'probe-data');
  });
});

test('HTTP CONNECT sends Basic proxy credentials', async () => {
  let requestText = '';
  await withServer(socket => {
    socket.once('data', data => {
      requestText = data.toString();
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  }, async port => {
    const tunnel = await openConnectTunnel(`http://user:pass@127.0.0.1:${port}`, new URL('https://example.test/'), undefined, 1000);
    tunnel.destroy();
    await new Promise(resolve => setTimeout(resolve, 5));
  });
  assert.match(requestText, /Proxy-Authorization: Basic dXNlcjpwYXNz\r\n/i);
});

test('HTTP CONNECT rejects unsuccessful proxy responses', async () => {
  await withServer(socket => socket.once('data', () => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')), async port => {
    await assert.rejects(
      openConnectTunnel(`http://127.0.0.1:${port}`, new URL('https://example.test/'), undefined, 1000),
      /CONNECT failed with status 407/
    );
  });
});
