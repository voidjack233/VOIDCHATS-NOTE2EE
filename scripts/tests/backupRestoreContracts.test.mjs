import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, root), 'utf8');
const require = createRequire(import.meta.url);

test('PM2 full backup quiesces the media worker and lists only configured services', async () => {
  const backup = await read('backup-voidapp.sh');
  const declaration = backup.match(/^\s*local names=\(([^)]*)\)$/m);
  assert.ok(declaration, 'PM2 writer list is present');
  const writers = declaration[1].trim().split(/\s+/);
  const { apps } = require('../../VOID0000-api/ecosystem.config.cjs');
  const configured = new Set(apps.map(({ name }) => name));

  assert.ok(writers.includes('voidapp-media-worker'));
  for (const writer of writers) {
    assert.ok(configured.has(writer), `${writer} is missing from the PM2 ecosystem`);
  }
});

test('backup and restore MinIO commands target the internal endpoint', async () => {
  for (const script of ['backup-voidapp.sh', 'restore-voidapp.sh']) {
    const source = await read(script);
    assert.match(source, /MINIO_USE_SSL/);
    assert.match(source, /MINIO_ENDPOINT/);
    assert.match(source, /MINIO_PORT/);
    assert.doesNotMatch(source, /MINIO_URL/);
  }
});

test('full backup uses the authoritative Scylla reaction and migration tables', async () => {
  const backup = await read('backup-voidapp.sh');
  const restore = await read('restore-voidapp.sh');
  for (const table of ['messages', 'reaction_state', 'reaction_schema', 'schema_migrations']) {
    assert.match(backup, new RegExp(`\\n    ${table}\\n`));
    assert.match(restore, new RegExp(`\\n    ${table}\\n`));
  }
  for (const legacyTable of ['message_reactions', 'user_reactions', 'reaction_counts', 'message_edits']) {
    assert.doesNotMatch(backup, new RegExp(`\\n    ${legacyTable}\\n`));
    assert.doesNotMatch(restore, new RegExp(`\\n    ${legacyTable}\\n`));
  }
});

test('full recovery requires a complete quiesced format-2 artifact', async () => {
  const backup = await read('backup-voidapp.sh');
  const restore = await read('restore-voidapp.sh');
  assert.match(backup, /quiesce_writers\nwrite_manifest\nbackup_postgres/);
  assert.match(backup, /backup_format=2/);
  assert.match(restore, /backup_complete.*= "1"/);
  assert.match(restore, /recovery_point_quiesced.*= "1"/);
});

test('MinIO restore uses a manifest, hashes, and SDK metadata verification', async () => {
  const backup = await read('backup-voidapp.sh');
  const restore = await read('restore-voidapp.sh');
  const metadata = await read('../VOID0000-api/scripts/backup/minioObjectMetadata.ts');
  assert.match(backup, /minioObjectMetadata\.ts capture/);
  assert.match(restore, /minioObjectMetadata\.ts restore/);
  assert.match(metadata, /createHash\('sha256'\)/);
  assert.match(metadata, /minio\.putObject/);
  assert.match(metadata, /Metadata verification failed/);
});
