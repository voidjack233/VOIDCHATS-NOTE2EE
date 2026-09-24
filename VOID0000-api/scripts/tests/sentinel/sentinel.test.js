import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import express from 'express';
import ts from 'typescript';
import { Sentinel, createSentinelKey } from '../../../server/sentinel/index.js';
import { historyMetrics } from '../../../server/health/historyMetrics.js';
import { root } from '../media/fixtures.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('Sentinel joins a concurrent read, releases it and never caches completed results', async () => {
  const sentinel = new Sentinel(), pending = deferred(); let calls = 0;
  const leader = sentinel.guard('same', () => { calls++; return pending.promise; });
  const follower = sentinel.guard('same', () => { throw new Error('duplicate work'); });
  assert.equal(leader, follower);
  await Promise.resolve(); assert.equal(calls, 1);
  assert.deepEqual(sentinel.getSnapshot(), { enabled: true, active: 1, maxActive: 5000, started: 1, joined: 1, succeeded: 0, failed: 0, bypassed: 0 });
  pending.resolve('rows'); assert.equal(await follower, 'rows');
  assert.equal(sentinel.getSnapshot().active, 0);
  assert.equal(await sentinel.guard('same', () => 'fresh rows'), 'fresh rows');
  assert.equal(sentinel.getSnapshot().started, 2);
  assert.equal(sentinel.getSnapshot().succeeded, 2);
});

test('Sentinel capacity bypasses only new flights, still joins existing flights and respects disable', async () => {
  const sentinel = new Sentinel({ maxActiveFlights: 1 }), pending = deferred();
  const leader = sentinel.guard('one', () => pending.promise);
  const follower = sentinel.guard('one', () => 'must not run');
  assert.equal(await sentinel.guard('two', () => 'bypassed'), 'bypassed');
  assert.deepEqual(sentinel.getSnapshot(), { enabled: true, active: 1, maxActive: 1, started: 1, joined: 1, succeeded: 0, failed: 0, bypassed: 1 });
  pending.resolve('done'); await Promise.all([leader, follower]);
  const disabled = new Sentinel({ maxActiveFlights: 0 });
  await Promise.all([disabled.guard('one', () => 1), disabled.guard('one', () => 2)]);
  assert.deepEqual(disabled.getSnapshot(), { enabled: false, active: 0, maxActive: 0, started: 0, joined: 0, succeeded: 0, failed: 0, bypassed: 2 });
});

test('Sentinel failed flights are released once and retried; scalar keys do not collide', async () => {
  const sentinel = new Sentinel(), pending = deferred();
  const leader = sentinel.guard('one', () => pending.promise), follower = sentinel.guard('one', () => null);
  pending.reject(new Error('storage unavailable'));
  assert.deepEqual((await Promise.allSettled([leader, follower])).map(r => r.status), ['rejected', 'rejected']);
  assert.equal(sentinel.getSnapshot().failed, 1); assert.equal(sentinel.getSnapshot().active, 0);
  assert.equal(await sentinel.guard('one', () => 'recovered'), 'recovered');
  const keys = [null, undefined, '', '1', 1, false].map(value => createSentinelKey('path', value));
  assert.equal(new Set(keys).size, keys.length);
});

test('message-service health exposes only aggregate Sentinel stats without storage work', async t => {
  const sentinel = new Sentinel({ maxActiveFlights: 1 }), pending = deferred();
  const flight = sentinel.guard('private-user-and-conversation-key', () => pending.promise);
  const joined = sentinel.guard('private-user-and-conversation-key', () => null);
  await sentinel.guard('another-private-key', () => null);
  t.after(() => pending.resolve());
  const pass = (_req, _res, next) => next();
  const emptyRouter = express.Router(), esm = value => ({ __esModule: true, default: value });
  let server, queryCount = 0;
  const dependencies = {
    express: esm(express), cors: esm(() => pass), dotenv: esm({ config() {} }), 'cookie-parser': esm(() => pass),
    http: { createServer(app) { server = createServer(app); return server; } },
    '../config/projectRoot.js': { fromProjectRoot: value => value },
    '../middleware/xss/index.js': { securityMiddleware: () => [] }, '../utils/authSecrets.js': { validateAuthSecrets() {} },
    '../middleware/encryptedCSRF.js': { encryptedCSRFProtection: pass }, '../middleware/jwt.js': { authenticateUser: pass },
    '../middleware/rate_limit.js': { messageReactionToggleLimiter: pass }, '../middleware/noCache.js': { noCache: pass },
    '../db.js': { pool: { async query() { queryCount++; return { rows: [] }; } } },
    '../attachments/schemaCompatibility.js': { async assertAttachmentBlobSchemaCompatible() {} },
    '../valkey.js': esm({}), '../scylla.js': esm({}), '../minio.js': { minioClient: {}, ATTACH_BUCKET: 'fixture' },
    '../health/readiness.js': { createReadinessHandler: () => pass },
    '../health/gracefulHttpShutdown.js': { installGracefulHttpShutdown() {} },
    '../attachmentSanitizer/ipcProtocol.js': {}, '../valkey-pubsub.js': { initPublisher() {}, closePubSub() {} },
    '../sentinel/index.js': esm(sentinel),
    '../health/historyMetrics.js': { historyMetrics },
  };
  for (const route of ['conversations/attachments', 'conversations/batchReactions', 'conversations/messages', 'conversations/reactions']) {
    dependencies[`../routes/${route}.js`] = esm(emptyRouter);
  }
  dependencies['../media/ingestRoutes.js'] = esm(emptyRouter);
  const output = ts.transpileModule(readFileSync(join(root, 'server/entrypoints/message-server.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  await runInNewContext(`(async () => { ${output}\n })()`, {
    exports: {}, console: { log() {} }, process: { pid: 1, env: { MESSAGE_SERVICE_PORT: '0', HOST: '127.0.0.1' } },
    require(specifier) { assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency ${specifier}`); return dependencies[specifier]; },
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const before = queryCount;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.metrics.sentinel, sentinel.getSnapshot());
  assert.equal(body.metrics.sentinel.joined, 1); assert.equal(body.metrics.sentinel.bypassed, 1);
  assert.equal(queryCount, before);
  assert.deepEqual(body.metrics.history, historyMetrics.getSnapshot());
  assert.doesNotMatch(JSON.stringify(body), /private-user|another-private|token|secret|flight.*key/i);
  pending.resolve(); await Promise.all([flight, joined]);
  const completed = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(completed.metrics.sentinel.active, 0); assert.equal(completed.metrics.sentinel.succeeded, 1);
});
