import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import cassandra from 'cassandra-driver';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, QueryResultRow } from 'pg';
import {
  resolvePostgresConfig,
  resolveScyllaConfig,
} from '../../server/config/databaseConfig.js';
import type { ScyllaConfig } from '../../server/config/databaseConfig.js';
import { projectRoot } from '../../server/config/projectRoot.js';

const { Pool } = pg;

export { projectRoot };
const postgresMigrationsDir = path.join(projectRoot, 'db', 'migrations');
const scyllaMigrationsDir = path.join(projectRoot, 'db', 'scylla-migrations');
const MIGRATION_LOCK_KEYS = [1448030532, 1296641874];
const SCYLLA_MIGRATION_READ_TIMEOUT_MS = 120_000;

interface MigrationLogger {
  log(...values: unknown[]): void;
}

interface MigrationRunOptions {
  logger?: MigrationLogger;
  statusOnly?: boolean;
}

interface MigrationCounts {
  appliedCount: number;
  pendingCount: number;
}

interface AppliedMigration extends QueryResultRow {
  filename: string;
  checksum: string;
  applied_at: Date | string | number;
}

interface ExistsRow extends QueryResultRow {
  exists: boolean;
}

interface TableNameRow extends QueryResultRow {
  table_name: string;
}

interface MigrationDefinition {
  filename: string;
  fullPath: string;
  checksum: string;
}

interface SqlMigration extends MigrationDefinition {
  sql: string;
}

interface ScyllaMigration extends MigrationDefinition {
  cql: string;
  statements: string[];
}

interface MigrationStatusInput<TMigration extends MigrationDefinition> {
  logger: MigrationLogger;
  appliedRows: AppliedMigration[];
  pending: TMigration[];
  appliedLabel: string;
  pendingLabel: string;
}

interface AppliedValidationInput<TMigration extends MigrationDefinition> {
  appliedByFilename: Map<string, AppliedMigration>;
  migrations: TMigration[];
  errorPrefix: string;
}

interface UnexpectedValidationInput<TMigration extends MigrationDefinition> {
  appliedRows: AppliedMigration[];
  migrations: TMigration[];
  errorPrefix: string;
}

dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

function createPool(): PgPool {
  return new Pool(resolvePostgresConfig());
}

function checksumOf(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function getErrorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensurePostgresMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function readPostgresAppliedMigrations(
  client: PoolClient,
): Promise<AppliedMigration[]> {
  const tableResult = await client.query<ExistsRow>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`
  );
  if (!tableResult.rows[0]?.exists) {
    return [];
  }

  const appliedResult = await client.query<AppliedMigration>(
    `SELECT filename, checksum, applied_at
     FROM schema_migrations
     ORDER BY filename`
  );
  return appliedResult.rows;
}

async function assertFreshPostgresBaseline(
  client: PoolClient,
  appliedRows: AppliedMigration[],
): Promise<void> {
  if (appliedRows.length > 0) {
    return;
  }

  const tablesResult = await client.query<TableNameRow>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
       AND table_name <> 'schema_migrations'
     ORDER BY table_name`
  );

  if (tablesResult.rows.length > 0) {
    const tables = tablesResult.rows.map((row) => row.table_name).join(', ');
    throw new Error(
      `Fresh NOTE2EE migrations require an empty PostgreSQL target. Found: ${tables}`
    );
  }
}

async function ensureScyllaKeyspace(
  client: cassandra.Client,
  config: ScyllaConfig,
): Promise<void> {
  await client.execute(
    `CREATE KEYSPACE IF NOT EXISTS ${config.keyspace}
     WITH replication = {
       'class': 'NetworkTopologyStrategy',
       '${config.localDataCenter}': ${config.replicationFactor}
     }
     AND tablets = { 'enabled': false }`
  );
}

async function ensureScyllaMigrationsTable(
  client: cassandra.Client,
  keyspace: string,
): Promise<void> {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${keyspace}.schema_migrations (
      scope text,
      filename text,
      checksum text,
      applied_at timestamp,
      PRIMARY KEY ((scope), filename)
    )`
  );
}

async function scyllaKeyspaceExists(
  client: cassandra.Client,
  keyspace: string,
): Promise<boolean> {
  const result = await client.execute(
    `SELECT keyspace_name
     FROM system_schema.keyspaces
     WHERE keyspace_name = ?`,
    [keyspace],
    { prepare: true }
  );
  return result.rows.length > 0;
}

async function scyllaTableExists(
  client: cassandra.Client,
  keyspace: string,
  tableName: string,
): Promise<boolean> {
  const result = await client.execute(
    `SELECT table_name
     FROM system_schema.tables
     WHERE keyspace_name = ? AND table_name = ?`,
    [keyspace, tableName],
    { prepare: true }
  );
  return result.rows.length > 0;
}

async function readScyllaAppliedMigrations(
  client: cassandra.Client,
  keyspace: string,
): Promise<AppliedMigration[]> {
  if (!(await scyllaKeyspaceExists(client, keyspace))) {
    return [];
  }
  if (!(await scyllaTableExists(client, keyspace, 'schema_migrations'))) {
    return [];
  }

  const result = await client.execute(
    `SELECT filename, checksum, applied_at
     FROM ${keyspace}.schema_migrations
     WHERE scope = ?`,
    ['scylla'],
    { prepare: true }
  );
  return (result.rows || []).map((row) => ({
    filename: String(row.filename),
    checksum: String(row.checksum),
    applied_at: row.applied_at instanceof Date
      ? row.applied_at
      : String(row.applied_at),
  }));
}

async function assertFreshScyllaBaseline(
  client: cassandra.Client,
  config: ScyllaConfig,
  appliedRows: AppliedMigration[],
): Promise<void> {
  if (appliedRows.length > 0 || !(await scyllaKeyspaceExists(client, config.keyspace))) {
    return;
  }

  const tablesResult = await client.execute(
    `SELECT table_name
     FROM system_schema.tables
     WHERE keyspace_name = ?`,
    [config.keyspace],
    { prepare: true }
  );
  const existingTables = tablesResult.rows
    .map((row) => String(row.table_name))
    .filter((tableName) => tableName !== 'schema_migrations');
  if (existingTables.length > 0) {
    throw new Error(
      `Fresh NOTE2EE migrations require an empty Scylla keyspace. Found: ${existingTables.join(', ')}`
    );
  }
}

async function loadSqlMigrations(): Promise<SqlMigration[]> {
  const files = (await fs.readdir(postgresMigrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const migrations: SqlMigration[] = [];
  for (const filename of files) {
    const fullPath = path.join(postgresMigrationsDir, filename);
    const sql = await fs.readFile(fullPath, 'utf8');
    migrations.push({
      filename,
      fullPath,
      sql,
      checksum: checksumOf(sql),
    });
  }

  return migrations;
}

async function loadScyllaMigrations(): Promise<ScyllaMigration[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(scyllaMigrationsDir);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const migrations: ScyllaMigration[] = [];
  for (const filename of files.filter((file) => file.endsWith('.cql')).sort()) {
    const fullPath = path.join(scyllaMigrationsDir, filename);
    const cql = await fs.readFile(fullPath, 'utf8');
    const statements = cql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    migrations.push({
      filename,
      fullPath,
      cql,
      statements,
      checksum: checksumOf(cql),
    });
  }

  return migrations;
}

function renderScyllaStatement(statement: string, config: ScyllaConfig): string {
  return statement.replaceAll('{{KEYSPACE}}', config.keyspace);
}

function reportMigrationStatus<TMigration extends MigrationDefinition>({
  logger,
  appliedRows,
  pending,
  appliedLabel,
  pendingLabel,
}: MigrationStatusInput<TMigration>): void {
  logger.log(`${appliedLabel}: ${appliedRows.length}`);
  logger.log(`${pendingLabel}: ${pending.length}`);

  for (const row of appliedRows) {
    logger.log(`applied  ${row.filename}  ${new Date(row.applied_at).toISOString()}`);
  }
  for (const migration of pending) {
    logger.log(`pending  ${migration.filename}`);
  }
}

function validateAppliedChecksums<TMigration extends MigrationDefinition>({
  appliedByFilename,
  migrations,
  errorPrefix,
}: AppliedValidationInput<TMigration>): TMigration[] {
  const pending: TMigration[] = [];

  for (const migration of migrations) {
    const applied = appliedByFilename.get(migration.filename);
    if (!applied) {
      pending.push(migration);
      continue;
    }

    if (applied.checksum !== migration.checksum) {
      throw new Error(
        `${errorPrefix} "${migration.filename}" no longer matches the repo copy. ` +
        'Create a new migration instead of editing an old one.'
      );
    }
  }

  return pending;
}

function validateUnexpectedAppliedMigrations<TMigration extends MigrationDefinition>({
  appliedRows,
  migrations,
  errorPrefix,
}: UnexpectedValidationInput<TMigration>): void {
  const repoFilenames = new Set(migrations.map((migration) => migration.filename));
  const unexpected = appliedRows
    .map((row) => row.filename)
    .filter((filename) => !repoFilenames.has(filename));

  if (unexpected.length > 0) {
    throw new Error(
      `${errorPrefix} ${unexpected.join(', ')}. ` +
      'This database is ahead of the repo migration set. Realign schema_migrations and any leftover tables before continuing.'
    );
  }
}

async function withGlobalMigrationLock<T>(
  { logger = console }: Pick<MigrationRunOptions, 'logger'>,
  callback: () => Promise<T>,
): Promise<T> {
  const pool = createPool();
  const client = await pool.connect();

  try {
    logger.log('Waiting for global migration lock...');
    await client.query(
      'SELECT pg_advisory_lock($1, $2)',
      MIGRATION_LOCK_KEYS
    );
    logger.log('Acquired global migration lock.');
    return await callback();
  } finally {
    try {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        MIGRATION_LOCK_KEYS
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}

export async function runPostgresMigrations({
  logger = console,
  statusOnly = false,
}: MigrationRunOptions = {}): Promise<MigrationCounts> {
  const pool = createPool();
  const client = await pool.connect();

  try {
    const migrations = await loadSqlMigrations();
    const appliedRows = await readPostgresAppliedMigrations(client);
    await assertFreshPostgresBaseline(client, appliedRows);
    const appliedByFilename = new Map(
      appliedRows.map((row) => [row.filename, row])
    );
    validateUnexpectedAppliedMigrations({
      appliedRows,
      migrations,
      errorPrefix: 'Unexpected applied PostgreSQL migrations:',
    });
    const pending = validateAppliedChecksums({
      appliedByFilename,
      migrations,
      errorPrefix: 'Applied migration',
    });

    if (statusOnly) {
      reportMigrationStatus({
        logger,
        appliedRows,
        pending,
        appliedLabel: 'Applied migrations',
        pendingLabel: 'Pending migrations',
      });

      return {
        appliedCount: appliedRows.length,
        pendingCount: pending.length,
      };
    }

    await ensurePostgresMigrationsTable(client);

    for (const migration of pending) {
      logger.log(`Applying migration ${migration.filename}...`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum)
           VALUES ($1, $2)`,
          [migration.filename, migration.checksum]
        );
        await client.query('COMMIT');
        logger.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    logger.log(
      pending.length === 0
        ? 'No pending migrations.'
        : `Migration complete. Applied ${pending.length} new migration${pending.length === 1 ? '' : 's'}.`
    );

    return {
      appliedCount: appliedRows.length + pending.length,
      pendingCount: 0,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export async function runScyllaMigrations({
  logger = console,
  statusOnly = false,
}: MigrationRunOptions = {}): Promise<MigrationCounts> {
  const config = resolveScyllaConfig();
  const client = new cassandra.Client({
    contactPoints: config.contactPoints,
    localDataCenter: config.localDataCenter,
    socketOptions: {
      readTimeout: SCYLLA_MIGRATION_READ_TIMEOUT_MS,
    },
  });

  await client.connect();

  try {
    const migrations = await loadScyllaMigrations();
    const appliedRows = await readScyllaAppliedMigrations(client, config.keyspace);
    await assertFreshScyllaBaseline(client, config, appliedRows);
    const appliedByFilename = new Map(
      appliedRows.map((row) => [row.filename, row])
    );
    validateUnexpectedAppliedMigrations({
      appliedRows,
      migrations,
      errorPrefix: 'Unexpected applied Scylla migrations:',
    });
    const pending = validateAppliedChecksums({
      appliedByFilename,
      migrations,
      errorPrefix: 'Applied Scylla migration',
    });

    if (statusOnly) {
      reportMigrationStatus({
        logger,
        appliedRows,
        pending,
        appliedLabel: 'Applied Scylla migrations',
        pendingLabel: 'Pending Scylla migrations',
      });

      return {
        appliedCount: appliedRows.length,
        pendingCount: pending.length,
      };
    }

    await ensureScyllaKeyspace(client, config);
    await ensureScyllaMigrationsTable(client, config.keyspace);

    for (const migration of pending) {
      logger.log(`Applying Scylla migration ${migration.filename}...`);
      try {
        for (const statement of migration.statements) {
          await client.execute(renderScyllaStatement(statement, config));
        }
        await client.execute(
          `INSERT INTO ${config.keyspace}.schema_migrations (scope, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
          ['scylla', migration.filename, migration.checksum, new Date()],
          { prepare: true }
        );
        logger.log(`Applied ${migration.filename}`);
      } catch (error) {
        throw new Error(
          `Failed while applying Scylla migration "${migration.filename}": ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
    }

    logger.log(
      pending.length === 0
        ? 'No pending Scylla migrations.'
        : `Scylla migration complete. Applied ${pending.length} new migration${pending.length === 1 ? '' : 's'}.`
    );

    return {
      appliedCount: appliedRows.length + pending.length,
      pendingCount: 0,
    };
  } finally {
    await client.shutdown();
  }
}

export async function runMigrations({
  logger = console,
  statusOnly = false,
}: MigrationRunOptions = {}): Promise<{
  postgres: MigrationCounts;
  scylla: MigrationCounts;
}> {
  // Validate every target before either datastore can be changed.
  resolvePostgresConfig();
  resolveScyllaConfig();

  const runAll = async () => {
    logger.log('== PostgreSQL ==');
    const postgres = await runPostgresMigrations({ logger, statusOnly });
    logger.log('');
    logger.log('== ScyllaDB ==');
    const scylla = await runScyllaMigrations({ logger, statusOnly });

    return {
      postgres,
      scylla,
    };
  };

  if (statusOnly) {
    return runAll();
  }

  return withGlobalMigrationLock({ logger }, runAll);
}
