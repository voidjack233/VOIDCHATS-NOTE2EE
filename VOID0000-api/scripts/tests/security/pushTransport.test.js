import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import webPush from 'web-push';
import { sendPrivatePush } from '../../../server/notifications/pushTransport.js';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test',
  keys: { p256dh: Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') },
};

function mockTransport(t, { addresses = [{ address: '8.8.8.8', family: 4 }], payloadBytes = 0, neverRespond = false } = {}) {
  const connections = [];
  t.mock.method(webPush, 'generateRequestDetails', () => ({ method: 'POST', headers: {}, body: Buffer.from('encrypted-payload') }));
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'request', (url, options, respond) => {
    assert.equal(url.hostname, 'fcm.googleapis.com');
    assert.equal(options.agent, false);
    assert.notEqual(options.rejectUnauthorized, false);
    const req = new EventEmitter();
    req.destroy = (error) => { req.emit('error', error); req.emit('close'); return req; };
    req.end = () => {
      if (neverRespond) return;
      options.lookup(url.hostname, { all: true }, (error, approved) => {
        if (error) return req.destroy(error);
        connections.push(approved);
        const res = new EventEmitter(); res.statusCode = 201;
        respond(res);
        if (payloadBytes) res.emit('data', Buffer.alloc(payloadBytes));
        res.emit('end'); req.emit('close');
      });
    };
    return req;
  });
  return connections;
}

test('push transport pins only public DNS answers at connection time', async (t) => {
  const connections=mockTransport(t);
  await sendPrivatePush(subscription,'test');
  assert.deepEqual(connections, [[{ address: '8.8.8.8', family: 4 }]]);
});
test('push transport rejects private or mixed DNS answers without connection', async (t) => {
  const connections=mockTransport(t, { addresses: [{ address: '8.8.8.8', family: 4 }, { address: '::ffff:7f00:1', family: 6 }] });
  await assert.rejects(sendPrivatePush(subscription,'test'), /Blocked push destination/);
  assert.deepEqual(connections,[]);
});
test('push response consumption is bounded', async (t) => {
  mockTransport(t, { payloadBytes: 16385 });
  await assert.rejects(sendPrivatePush(subscription,'test'), /Push response too large/);
});
test('push transport has an absolute deadline, including a stalled connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockTransport(t, { neverRespond: true });
  const outcome=assert.rejects(sendPrivatePush(subscription,'test'), /Push delivery timed out/);
  t.mock.timers.tick(10_000);
  await outcome;
});
