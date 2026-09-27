import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const api = path.join(repo, 'VOID0000-api');
const restore = path.join(repo, 'scripts/restore-voidapp.sh');

test('full restore dry run accepts a manifest-backed empty bucket and rejects missing data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'voidapp-empty-bucket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = path.join(root, 'backup');
  const bin = path.join(root, 'bin');
  const metadata = path.join(backup, 'minio/metadata/group-avatars.json');
  await Promise.all([
    mkdir(path.join(backup, 'postgres'), { recursive: true }),
    mkdir(path.join(backup, 'scylla'), { recursive: true }),
    mkdir(path.join(backup, 'minio/metadata'), { recursive: true }),
    mkdir(path.join(backup, 'minio/avatars'), { recursive: true }),
    mkdir(path.join(backup, 'minio/chat-attachments'), { recursive: true }),
    mkdir(path.join(backup, 'valkey'), { recursive: true }),
    mkdir(bin),
  ]);
  await writeFile(path.join(backup, 'MANIFEST.txt'), [
    'backup_format=2', 'backup_complete=1', 'recovery_point_quiesced=1',
    'postgres_status=complete', 'scylla_status=complete', 'minio_status=complete',
    'scylla_keyspace=source_keyspace',
  ].join('\n') + '\n');
  await writeFile(path.join(backup, 'postgres/source.dump'), 'fixture');
  await writeFile(path.join(backup, 'valkey/dump.rdb'), 'fixture');
  for (const table of ['messages', 'reaction_state', 'reaction_schema', 'schema_migrations']) {
    await writeFile(path.join(backup, `scylla/${table}.csv`), 'fixture');
  }
  for (const bucket of ['avatars', 'group-avatars', 'chat-attachments']) {
    await writeFile(path.join(backup, `minio/metadata/${bucket}.json`),
      JSON.stringify({ format: 1, bucket, objects: [] }));
  }
  for (const command of ['pg_restore', 'cqlsh', 'mc', 'valkey-cli']) {
    await writeFile(path.join(bin, command), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  }
  const envFile = path.join(root, 'isolated.env');
  await writeFile(envFile, [
    'PGHOST=127.0.0.1', 'PGPORT=15432', 'PGUSER=test', 'PGDATABASE=isolated_db',
    'SCYLLA_HOST=127.0.0.1', 'SCYLLA_PORT=19042', 'SCYLLA_KEYSPACE=isolated_keyspace',
    'MINIO_ENDPOINT=127.0.0.1', 'MINIO_PORT=19099', 'MINIO_USE_SSL=false',
    'VALKEY_HOST=127.0.0.1', 'VALKEY_PORT=16389',
  ].join('\n') + '\n');
  const run = () => spawnSync('bash', [restore, '--backup', backup, '--dry-run', '--all'], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VOIDAPP_ENV_FILE: envFile },
    encoding: 'utf8',
  });

  const empty = run();
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /Empty MinIO bucket group-avatars has no objects to mirror/);
  assert.doesNotMatch(empty.stdout, /mc mirror --overwrite .*minio\/group-avatars/);

  await writeFile(metadata, JSON.stringify({ format: 1, bucket: 'group-avatars', objects: [
    { key: 'missing.png', size: 1, sha256: '0'.repeat(64), metadata: {} },
  ] }));
  const missingBytes = run();
  assert.notEqual(missingBytes.status, 0);
  assert.match(missingBytes.stderr, /MinIO bucket backup is not empty/);

  await writeFile(metadata, '{bad json');
  const corruptManifest = run();
  assert.notEqual(corruptManifest.status, 0);
  assert.match(corruptManifest.stderr, /Required MinIO bucket backup is missing or invalid/);
});

test('non-empty MinIO metadata restore still verifies local object hashes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'voidapp-minio-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = path.join(root, 'objects');
  await mkdir(objects);
  await writeFile(path.join(objects, 'image.png'), 'wrong bytes');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ format: 1, bucket: 'attachments', objects: [
    { key: 'image.png', size: 11, sha256: '0'.repeat(64), metadata: {} },
  ] }));

  const result = spawnSync('node', [
    '--import', 'tsx', 'scripts/backup/minioObjectMetadata.ts',
    'restore', 'attachments', objects, manifest,
  ], { cwd: api, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Object bytes changed after backup/);
});
