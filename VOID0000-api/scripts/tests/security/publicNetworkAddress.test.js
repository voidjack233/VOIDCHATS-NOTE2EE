import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicNetworkAddress } from '../../../server/utils/publicNetworkAddress.js';
import previewRouter from '../../../server/routes/linkPreview/index.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('public-address policy handles private, reserved, mapped and transition addresses', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe90::1', 'fd00::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::',
    '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a00:1', '::ffff:c0a8:101', 'invalid',
  ]) assert.equal(isPublicNetworkAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808']) {
    assert.equal(isPublicNetworkAddress(address), true, address);
  }
});

test('preview redirect revalidates mapped private destinations after a pinned public request', async (t) => {
  const route = previewRouter.stack.find((layer) => layer.route).route.stack.at(-1).handle;
  const requests = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(http, 'request', (options, callback) => {
    requests.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = () => {
      const res = new PassThrough();
      res.statusCode = 302;
      res.headers = { location: 'http://[::ffff:7f00:1]/private' };
      callback(res);
    };
    return req;
  });
  const res = { code: 200, status(code) { this.code=code; return this; }, json() { return this; } };
  await route({ query: { url: 'http://public.example/redirect-security-test' } }, res);
  assert.equal(res.code,400);
  assert.equal(requests.length,1);
  assert.equal(requests[0].hostname,'8.8.8.8');
  assert.equal(requests[0].headers.Host,'public.example');
});

test('preview route rejects mapped loopback and private DNS before connecting', async (t) => {
  const route = previewRouter.stack.find((layer) => layer.route)?.route.stack.at(-1).handle;
  assert.equal(typeof route, 'function');
  let connections = 0;
  t.mock.method(http, 'request', () => { connections++; throw new Error('must not connect'); });
  t.mock.method(dns, 'lookup', async () => [{ address: '::ffff:7f00:1', family: 6 }]);
  for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://example.com/']) {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await route({ query: { url } }, res);
    assert.equal(status, 400, url);
  }
  assert.equal(connections, 0);
});
