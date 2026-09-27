import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, root), 'utf8');

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
