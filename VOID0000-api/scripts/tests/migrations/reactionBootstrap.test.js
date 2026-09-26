import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import cassandra from 'cassandra-driver';
import { runScyllaMigrations } from '../../../scripts/lib/migrationRunner.js';
import { createReactionState, ReactionError } from '../../../server/reactions/state.js';
import { migrateReactions } from '../../../server/reactions/migrate.js';
import { root } from '../media/fixtures.js';

const localDataCenter = 'datacenter1';

function nextKeyspace() {
  return `void_rx_boot_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function migrationStatements(filename, keyspace) {
  return readFileSync(join(root, 'db/scylla-migrations', filename), 'utf8')
    .replaceAll('{{KEYSPACE}}', keyspace)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function withScyllaEnvironment(keyspace, task) {
  const keys = ['SCYLLA_HOST', 'SCYLLA_KEYSPACE', 'SCYLLA_LOCAL_DATACENTER', 'SCYLLA_REPLICATION_FACTOR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    SCYLLA_HOST: '127.0.0.1',
    SCYLLA_KEYSPACE: keyspace,
    SCYLLA_LOCAL_DATACENTER: localDataCenter,
    SCYLLA_REPLICATION_FACTOR: '1',
  });
  try {
    return await task();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function connect(keyspace) {
  const client = new cassandra.Client({
    contactPoints: ['127.0.0.1'],
    localDataCenter,
    socketOptions: { readTimeout: 60_000 },
    ...(keyspace ? { keyspace } : {}),
  });
  await client.connect();
  return client;
}

test('normal migration makes a fresh Scylla target reaction-ready', async (t) => {
  const keyspace = nextKeyspace();
  const admin = await connect();
  t.after(async () => {
    await admin.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`);
    await admin.shutdown();
  });

  await withScyllaEnvironment(keyspace, async () => {
    const result = await runScyllaMigrations({ logger: { log() {} } });
    assert.equal(result.pendingCount, 0);
  });

  const db = await connect(keyspace);
  t.after(() => db.shutdown());
  assert.equal(
    (await db.execute("SELECT ready FROM reaction_schema WHERE version='atomic_v1'")).rows[0]?.ready,
    true,
  );
  const state = createReactionState(db);
  await state.ensureReady();
  const snapshot = await state.set(
    String(cassandra.types.Uuid.random()),
    String(cassandra.types.TimeUuid.now()),
    String(cassandra.types.Uuid.random()),
    '👍',
    true,
  );
  assert.equal(snapshot.counts['👍'], 1);
});

test('interrupted fresh readiness publication is retried after both migrations are recorded', async (t) => {
  const keyspace = nextKeyspace();
  const admin = await connect();
  t.after(async () => {
    await admin.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`);
    await admin.shutdown();
  });

  const execute = cassandra.Client.prototype.execute;
  let failReadinessPublication = true;
  cassandra.Client.prototype.execute = function patchedExecute(query, ...args) {
    if (
      failReadinessPublication &&
      typeof query === 'string' &&
      query.includes(`INSERT INTO ${keyspace}.reaction_schema`)
    ) {
      failReadinessPublication = false;
      return Promise.reject(new Error('injected readiness publication failure'));
    }
    return execute.call(this, query, ...args);
  };
  try {
    await assert.rejects(
      withScyllaEnvironment(keyspace, () => runScyllaMigrations({ logger: { log() {} } })),
      /injected readiness publication failure/,
    );
  } finally {
    cassandra.Client.prototype.execute = execute;
  }

  const beforeRetry = await connect(keyspace);
  t.after(() => beforeRetry.shutdown());
  const applied = await beforeRetry.execute(
    'SELECT filename FROM schema_migrations WHERE scope=?',
    ['scylla'],
    { prepare: true },
  );
  assert.deepEqual(applied.rows.map((row) => row.filename).sort(), [
    '0000_message_storage.cql',
    '0001_atomic_reactions.cql',
  ]);
  assert.equal(
    (await beforeRetry.execute("SELECT ready FROM reaction_schema WHERE version='atomic_v1'")).rows.length,
    0,
  );

  await withScyllaEnvironment(keyspace, () => runScyllaMigrations({ logger: { log() {} } }));
  const state = createReactionState(beforeRetry);
  await state.ensureReady();
  const snapshot = await state.set(
    String(cassandra.types.Uuid.random()),
    String(cassandra.types.TimeUuid.now()),
    String(cassandra.types.Uuid.random()),
    '👍',
    true,
  );
  assert.equal(snapshot.counts['👍'], 1);
});

test('legacy memberships remain fail-closed until the explicit verified backfill completes', async (t) => {
  const keyspace = nextKeyspace();
  const admin = await connect();
  t.after(async () => {
    await admin.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`);
    await admin.shutdown();
  });
  await admin.execute(`CREATE KEYSPACE ${keyspace} WITH replication = {'class':'NetworkTopologyStrategy','${localDataCenter}':1} AND tablets = {'enabled':false}`);
  for (const statement of migrationStatements('0000_message_storage.cql', keyspace)) {
    await admin.execute(statement);
  }
  await admin.execute(`CREATE TABLE ${keyspace}.schema_migrations (scope text, filename text, checksum text, applied_at timestamp, PRIMARY KEY ((scope), filename))`);
  const baseline = readFileSync(join(root, 'db/scylla-migrations/0000_message_storage.cql'));
  await admin.execute(
    `INSERT INTO ${keyspace}.schema_migrations (scope, filename, checksum, applied_at) VALUES (?, ?, ?, ?)`,
    ['scylla', '0000_message_storage.cql', createHash('sha256').update(baseline).digest('hex'), new Date()],
    { prepare: true },
  );
  const conversation = cassandra.types.Uuid.random();
  const message = cassandra.types.TimeUuid.now();
  const user = cassandra.types.Uuid.random();
  await admin.execute(
    `INSERT INTO ${keyspace}.message_reactions (conversation_id, message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [conversation, message, '👍', user, new Date()],
    { prepare: true },
  );

  await withScyllaEnvironment(keyspace, () => runScyllaMigrations({ logger: { log() {} } }));
  const db = await connect(keyspace);
  t.after(() => db.shutdown());
  const state = createReactionState(db);
  assert.notEqual(
    (await db.execute("SELECT ready FROM reaction_schema WHERE version='atomic_v1'")).rows[0]?.ready,
    true,
  );
  assert.equal(
    (await db.execute(
      'SELECT filename FROM schema_migrations WHERE scope=? AND filename=?',
      ['bootstrap', 'fresh_atomic_reactions_v1'],
      { prepare: true },
    )).rows.length,
    0,
  );
  await withScyllaEnvironment(keyspace, () => runScyllaMigrations({ logger: { log() {} } }));
  assert.notEqual(
    (await db.execute("SELECT ready FROM reaction_schema WHERE version='atomic_v1'")).rows[0]?.ready,
    true,
  );
  await assert.rejects(
    state.ensureReady(),
    (error) => error instanceof ReactionError && error.code === 'REACTIONS_NOT_READY',
  );

  const incomplete = await migrateReactions(db, false);
  assert.equal(incomplete.copied, 1);
  await assert.rejects(
    state.ensureReady(),
    (error) => error instanceof ReactionError && error.code === 'REACTIONS_NOT_READY',
  );

  const migrated = await migrateReactions(db, true);
  assert.equal(migrated.verified, 1);
  await state.ensureReady();
  const snapshot = await state.batch(String(conversation), [String(message)], String(user));
  assert.equal(snapshot.reactions[String(message)]['👍'].count, 1);
  assert.equal(snapshot.reactions[String(message)]['👍'].me, true);
});
