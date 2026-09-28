import assert from 'node:assert/strict';
import test from 'node:test';
import { createScyllaShutdownFixture, reconnectMessage, terminateNaturally } from './scyllaShutdownFixture.js';

test('real conversation process closes its shared Scylla client and exits naturally', { timeout: 60_000 }, async (t) => {
  const fixture = await createScyllaShutdownFixture(t);
  const service = await fixture.startService('conversation');
  await fixture.exerciseConversation(service.port);
  const result = await terminateNaturally(service);
  assert.equal((await fixture.ready(service.port)).status, 0);
  t.diagnostic(JSON.stringify(result));
});

test('real message process exits naturally without an outage', { timeout: 60_000 }, async (t) => {
  const fixture = await createScyllaShutdownFixture(t);
  const service = await fixture.startService('message');
  await fixture.exerciseMessages(service.port);
  const result = await terminateNaturally(service);
  assert.equal((await fixture.ready(service.port)).status, 0);
  t.diagnostic(JSON.stringify(result));
});

test('same message PID recovers through Scylla Host replacement then closes all pools naturally', { timeout: 90_000 }, async (t) => {
  const fixture = await createScyllaShutdownFixture(t);
  await fixture.startProxy();
  const service = await fixture.startService('message', { viaProxy: true });
  const recovery = await reconnectMessage(fixture, service);
  const result = await terminateNaturally(service);
  assert.equal((await fixture.ready(service.port)).status, 0);
  t.diagnostic(JSON.stringify({ ...result, ...recovery }));
});
