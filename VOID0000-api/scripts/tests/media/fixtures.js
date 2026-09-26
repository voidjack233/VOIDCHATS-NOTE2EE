import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import Redis from 'ioredis';
import { Client } from 'minio';
import ts from 'typescript';
import * as historyMetrics from '../../../server/health/historyMetrics.js';
import { createReactionState } from '../../../server/reactions/state.js';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
export function load(path, dependencies, env = {}) {
  const source = readFileSync(join(root, 'server', `${path}.ts`), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  runInNewContext(output, { exports, Buffer, URL, console, setTimeout, clearTimeout, process: { env },
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
      if (specifier.endsWith('/health/historyMetrics.js')) return historyMetrics;
      if (specifier.endsWith('/reactions/index.js')) {
        const scylla = Object.entries(dependencies).find(([name]) => name.endsWith('/scylla.js'))?.[1]?.default;
        if (!scylla) throw new Error('Reaction fixture requires an injected Scylla client');
        return { reactionState: createReactionState(scylla) };
      }
      if (specifier === 'express' || specifier === 'crypto' || specifier.startsWith('node:')) return require(specifier);
      throw new Error(`Unexpected dependency: ${specifier}`);
    },
  });
  return exports;
}
export async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error('Isolated service timed out'); await delay(25); }
}
export async function services(t, ports = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'void-media-http-'));
  const cleanup = [];
  t.after(async () => {
    for (const task of cleanup.reverse()) await task();
    rmSync(directory, { recursive: true, force: true });
  });
  const pgBin = process.env.PROFILE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
  const pgPort = ports.postgres || await freePort(), redisPort = ports.valkey || await freePort(), minioPort = await freePort();
  const pgRun = (name, args) => execFileSync(join(pgBin, name), args, { stdio: 'pipe' });
  pgRun('initdb', ['-D', join(directory, 'pg'), '-A', 'trust', '--no-locale']);
  pgRun('pg_ctl', ['-D', join(directory, 'pg'), '-l', join(directory, 'pg.log'), '-o', `-h 127.0.0.1 -p ${pgPort} -k ${directory}`, '-w', 'start']);
  cleanup.push(() => pgRun('pg_ctl', ['-D', join(directory, 'pg'), '-m', 'immediate', '-w', 'stop']));
  const pool = new pg.Pool({ host: '127.0.0.1', port: pgPort, database: 'postgres', user: process.env.USER, max: ports.poolMax || 4 });
  cleanup.push(() => pool.end());
  for (const name of ports.migrate === false ? [] : readdirSync(join(root, 'db/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(root, 'db/migrations', name), 'utf8'));
  }
  const start = (binary, args, env = process.env) => {
    const child = spawn(binary, args, { env, stdio: 'ignore' });
    cleanup.push(async () => { if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped; });
    return child;
  };
  start('valkey-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--dir', directory]);
  const redis = new Redis({ host: '127.0.0.1', port: redisPort, lazyConnect: true });
  redis.on('error', () => {}); await until(() => redis.ping().then(() => true).catch(() => false));
  cleanup.push(() => redis.quit());
  const storageEnv = { ...process.env, MINIO_ROOT_USER: 'mediatest', MINIO_ROOT_PASSWORD: 'media-test-only-secret', MINIO_BROWSER: 'off' };
  start('/usr/local/bin/minio', ['server', join(directory, 'minio'), '--address', `127.0.0.1:${minioPort}`], storageEnv);
  await until(() => fetch(`http://127.0.0.1:${minioPort}/minio/health/ready`).then(r => r.ok).catch(() => false));
  const objects = new Client({ endPoint: '127.0.0.1', port: minioPort, useSSL: false, accessKey: 'mediatest', secretKey: 'media-test-only-secret', region: 'us-east-1' });
  await objects.makeBucket('attachments');
  const env = { PATH: process.env.PATH, HOME: directory, USER: process.env.USER,
    PGHOST: '127.0.0.1', PGPORT: String(pgPort), PGDATABASE: 'postgres', PGUSER: process.env.USER, PGPASSWORD: 'test-only',
    VALKEY_HOST: '127.0.0.1', VALKEY_PORT: String(redisPort), VALKEY_DB: '0',
    MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: String(minioPort), MINIO_USE_SSL: 'false', MINIO_REGION: 'us-east-1',
    MINIO_ACCESS_KEY: 'mediatest', MINIO_SECRET_KEY: 'media-test-only-secret', MINIO_ATTACH_BUCKET: 'attachments',
    MINIO_MEDIA_QUARANTINE_BUCKET: 'quarantine', MEDIA_TEMP_ROOT: join(directory, 'work'), MEDIA_WORKER_PORT: String(await freePort()),
  };
  return { pool, redis, objects, directory, env, start, cleanup };
}
