#!/usr/bin/env node
/**
 * nuke-conversations.js
 * Wipes all conversation-related data from PostgreSQL, ScyllaDB, and Valkey.
 * Run with: node scripts/nuke-conversations.js
 * Add --confirm to skip the prompt.
 */

import path from 'path';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import pkg from 'pg';
const { Pool } = pkg;

import cassandra from 'cassandra-driver';
import Redis from 'ioredis';
import {
  resolvePostgresConfig,
  resolveScyllaConfig,
} from '../server/config/databaseConfig.js';

const POSTGRES_TABLES = [
  // Order matters — child tables first to avoid FK violations
  'conversation_join_requests',
  'conversation_invite_links',
  'conversation_members',
  'conversation_categories',
  'dm_pairs',
  'conversations',
];

const SCYLLA_TABLES = [
  'message_reactions',
  'reaction_counts',
  'user_reactions',
  'message_edits',
  'messages',
];

async function confirm() {
  if (process.argv.includes('--confirm')) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve, reject) => {
    rl.question(
      '\n⚠️  This will permanently delete ALL conversation data.\nType "nuke" to proceed: ',
      (answer) => {
        rl.close();
        if (answer.trim() !== 'nuke') {
          console.log('Aborted.');
          process.exit(0);
        }
        resolve();
      }
    );
  });
}

async function nukePostgres() {
  const pool = new Pool(resolvePostgresConfig());

  const client = await pool.connect();
  try {
    console.log('\n[PostgreSQL] Truncating tables...');
    const existingTablesResult = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [POSTGRES_TABLES]
    );

    const existingTables = new Set(existingTablesResult.rows.map((row) => row.table_name));
    const tablesToTruncate = POSTGRES_TABLES.filter((tableName) => existingTables.has(tableName));

    if (tablesToTruncate.length === 0) {
      console.log('  No matching conversation tables found.');
      return;
    }

    // TRUNCATE with CASCADE handles any remaining FK references.
    const tableList = tablesToTruncate.join(', ');
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    for (const t of tablesToTruncate) {
      console.log(`  ✓ ${t}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function nukeScylla() {
  const config = resolveScyllaConfig();
  const scylla = new cassandra.Client({
    contactPoints: config.contactPoints,
    localDataCenter: config.localDataCenter,
    keyspace: config.keyspace,
  });

  await scylla.connect();
  console.log('\n[ScyllaDB] Truncating tables...');
  try {
    for (const t of SCYLLA_TABLES) {
      await scylla.execute(`TRUNCATE ${config.keyspace}.${t}`);
      console.log(`  ✓ ${t}`);
    }
  } finally {
    await scylla.shutdown();
  }
}

async function nukeValkey() {
  const valkey = new Redis({
    host: process.env.VALKEY_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT || '6379', 10),
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });

  console.log('\n[Valkey] Flushing all keys...');
  await valkey.flushall();
  console.log('  ✓ FLUSHALL done');
  valkey.disconnect();
}

async function main() {
  await confirm();

  try {
    await nukePostgres();
    await nukeScylla();
    await nukeValkey();
    console.log('\n✅ All conversation data wiped.\n');
  } catch (err) {
    console.error('\n❌ Error during nuke:', err.message);
    process.exit(1);
  }
}

main();
