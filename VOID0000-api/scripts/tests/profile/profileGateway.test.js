import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { chromium } = createRequire(new URL('../../../../VOID0000-www/package.json', import.meta.url))('playwright');
const apiRoot = fileURLToPath(new URL('../../../', import.meta.url));

function load(path, dependencies, env = {}) {
  const source = readFileSync(join(apiRoot, 'server', `${path}.ts`), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  runInNewContext(output, { exports, console, Buffer, setTimeout, clearTimeout, process: { env },
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
      if (['express', 'ioredis'].includes(specifier)) return require(specifier);
      throw new Error(`Unexpected dependency: ${specifier}`);
    },
  });
  return exports;
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  process.kill(-child.pid, 'SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
}

test('real profile edit -> PostgreSQL audience -> Valkey -> Phoenix -> authenticated non-friend WebSocket', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-profile-gateway-'));
  const bin = process.env.PROFILE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
  let pgStarted = false;
  let db, redis, subscriber, publisher, valkeyProcess, gatewayProcess, browser;
  let gatewayLog = '';
  try {
    execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'pg.log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    pgStarted = true;
    db = new pg.Client({ host: root, port: 5432, database: 'postgres', user: process.env.USER });
    await db.connect();
    await db.query(`CREATE TABLE user_profiles(id bigint PRIMARY KEY, display_name text, bio text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE friendships(requester_id text, addressee_id text, status text);
      CREATE TABLE conversations(id text PRIMARY KEY, type text);
      CREATE TABLE conversation_members(conversation_id text, user_id text);
      INSERT INTO user_profiles(id,display_name,bio) VALUES(732434999193640961,'Old name','Old bio');
      INSERT INTO conversations VALUES ('shared','group');`);
    const editor = randomUUID(), receiver = randomUUID(), outsider = randomUUID();
    await db.query("INSERT INTO conversation_members VALUES ('shared',$1),('shared',$2)", [editor, receiver]);
    const valkeyPort = await freePort();
    const gatewayPort = await freePort();
    valkeyProcess = spawn('valkey-server', ['--bind', '127.0.0.1', '--port', String(valkeyPort), '--save', '', '--appendonly', 'no', '--dir', root], { detached: true, stdio: 'ignore' });
    await until(() => new Promise(resolve => {
      const connection = createConnection({ host: '127.0.0.1', port: valkeyPort });
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => { connection.destroy(); resolve(false); });
    }), 'temporary Valkey readiness');
    redis = new Redis({ host: '127.0.0.1', port: valkeyPort, lazyConnect: true, retryStrategy: () => 50 });
    redis.on('error', () => {});
    await redis.connect();
    subscriber = redis.duplicate();
    const envelopes = [];
    subscriber.on('message', (_channel, raw) => {
      const envelope = JSON.parse(raw);
      if (envelope.event === 'PROFILE_UPDATE') envelopes.push(envelope);
    });
    await subscriber.subscribe('void:gateway');
    const accessSecret = randomBytes(48).toString('hex');
    const base = `http://127.0.0.1:${gatewayPort}`;
    const env = { ...process.env, MIX_ENV: 'test', ERL_FLAGS: '+S 2:2 +SDcpu 1 +SDio 1',
      GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(gatewayPort), FRONT_URL: base,
      VALKEY_HOST: '127.0.0.1', VALKEY_PORT: String(valkeyPort), VALKEY_DB: '0',
      ACCESS_SECRET: accessSecret, PHX_SECRET_KEY_BASE: randomBytes(48).toString('hex') };
    gatewayProcess = spawn('mix', ['run', '--no-halt'], { cwd: join(apiRoot, 'void_gateway'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = data => { gatewayLog = (gatewayLog + data).slice(-12000); };
    gatewayProcess.stdout.on('data', record);
    gatewayProcess.stderr.on('data', record);
    await until(async () => {
      if (gatewayProcess.exitCode !== null) throw new Error(`Gateway exited: ${gatewayLog}`);
      try { return (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 'temporary Phoenix readiness');
    browser = await chromium.launch({ headless: true });
    const connect = async userId => {
      const sessionId = randomUUID();
      await redis.set(`session:${userId}:profile-test`, JSON.stringify({ userId, deviceId: 'profile-test', sessionId }), 'EX', 120);
      const token = jwt.sign({ id: userId, device_id: 'profile-test', sid: sessionId, type: 'access' }, accessSecret, { expiresIn: 120 });
      const context = await browser.newContext();
      await context.addCookies([{ name: 'accessToken', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      await page.goto(`${base}/health`);
      await page.evaluate(({ url, userId }) => {
        globalThis.profileFrames = [];
        const socket = new WebSocket(url);
        globalThis.profileSocket = socket;
        socket.onmessage = ({ data }) => {
          const frame = JSON.parse(data);
          globalThis.profileFrames.push(frame);
          if (frame.op === 10) socket.send(JSON.stringify({ op: 2, d: { user_id: userId, client_instance_id: 'profile-test', presence_status: 'online' } }));
        };
      }, { url: `ws://127.0.0.1:${gatewayPort}/gateway`, userId });
      await page.waitForFunction(() => globalThis.profileFrames.some(frame => frame.t === 'READY'));
      return page;
    };
    const receiverPage = await connect(receiver);
    const outsiderPage = await connect(outsider);
    publisher = load('valkey-pubsub', { './utils/debugLog.js': { debugLog() {} } }, env);
    await publisher.initPublisher().ping();
    const gateway = load('gateway/client', {
      '../valkey.js': {}, './presenceMode.js': {}, './protocol.js': { EVENTS: { PROFILE_UPDATE: 'PROFILE_UPDATE' } },
      '../db.js': { pool: db }, '../valkey-pubsub.js': publisher,
    });
    let broadcast;
    const route = load('routes/user/profileFields', {
      '../../db.js': { pool: db }, '../../middleware/profileCache.js': { profileCache: { invalidate: async () => {} } },
      '../../middleware/rate_limit.js': { profileUpdateLimiter: (_req, _res, next) => next() },
      '../../gateway/client.js': { broadcastProfileUpdate: (...args) => { broadcast = gateway.broadcastProfileUpdate(...args); return broadcast; } },
    }).default;
    const edit = async name => {
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await route.stack.find(layer => layer.route).route.stack.at(-1).handle({ userId: editor,
        userProfileId: '732434999193640961', body: { display_name: name, bio: 'Live bio' } }, res);
      assert.equal(res.code, 200);
      await broadcast;
      await publisher.initPublisher().ping();
    };
    await edit('Live non-friend name');
    await receiverPage.waitForFunction(() => globalThis.profileFrames.some(frame => frame.t === 'PROFILE_UPDATE'));
    const frames = await receiverPage.evaluate(() => globalThis.profileFrames.filter(frame => frame.t === 'PROFILE_UPDATE'));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].d.display_name, 'Live non-friend name');
    assert.equal(frames[0].d.profile_id, '732434999193640961');
    assert.deepEqual(envelopes.map(event => event.targetUserId), [receiver]);
    assert.equal(await outsiderPage.evaluate(() => globalThis.profileFrames.filter(frame => frame.t === 'PROFILE_UPDATE').length), 0);
    await db.query('DELETE FROM conversation_members WHERE user_id = $1', [receiver]);
    await edit('After removal');
    await delay(150);
    assert.equal(envelopes.length, 1, 'removed member must not be an audience recipient');
    assert.equal(await receiverPage.evaluate(() => globalThis.profileFrames.filter(frame => frame.t === 'PROFILE_UPDATE').length), 1);
    assert.equal((await db.query('SELECT display_name FROM user_profiles')).rows[0].display_name, 'After removal');
  } catch (error) {
    throw new Error(`${error.stack}\nTemporary gateway log:\n${gatewayLog}`);
  } finally {
    await browser?.close();
    await publisher?.closePubSub();
    await subscriber?.quit();
    await redis?.quit();
    await stop(gatewayProcess);
    await stop(valkeyProcess);
    await db?.end();
    if (pgStarted) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(root, { recursive: true, force: true });
  }
});
