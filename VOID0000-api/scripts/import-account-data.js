import pg from 'pg';

const { Pool } = pg;

const CONFIRMATION = 'IMPORT_ACCOUNTS_INTO_VOID';
const FRIENDSHIP_STATUSES = ['accepted', 'blocked'];

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function readPort(name, fallback) {
  const value = Number.parseInt(process.env[name] || fallback, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid port in ${name}`);
  }
  return value;
}

function connectionConfig(prefix) {
  return {
    host: required(`${prefix}_PGHOST`),
    port: readPort(`${prefix}_PGPORT`, '5432'),
    database: required(`${prefix}_PGDATABASE`),
    user: required(`${prefix}_PGUSER`),
    password: required(`${prefix}_PGPASSWORD`),
  };
}

function connectionIdentity(config) {
  return `${config.host}:${config.port}/${config.database}`;
}

async function resolvedDatabaseIdentity(client) {
  const result = await client.query(
    `SELECT
       current_database() AS database,
       COALESCE(inet_server_addr()::text, 'local_socket') AS server_address,
       COALESCE(inet_server_port(), 0) AS server_port`,
  );
  const row = result.rows[0];
  return `${row.server_address}:${row.server_port}/${row.database}`;
}

function parseTwoFactorMode() {
  const mode = String(process.env.ACCOUNT_IMPORT_2FA_MODE || '').trim().toLowerCase();
  if (mode && mode !== 'preserve' && mode !== 'reset') {
    throw new Error('ACCOUNT_IMPORT_2FA_MODE must be either preserve or reset');
  }
  return mode;
}

async function insertRows(client, table, columns, rows) {
  for (const row of rows) {
    const values = columns.map((column) => row[column]);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
  }
}

async function resetSequence(client, table, column = 'id') {
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence($1, $2),
       COALESCE(MAX(${column}), 1),
       MAX(${column}) IS NOT NULL
     )
     FROM ${table}`,
    [table, column],
  );
}

async function assertTargetIsEmpty(client) {
  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users,
       (SELECT COUNT(*)::int FROM user_profiles) AS profiles,
       (SELECT COUNT(*)::int FROM friendships) AS friendships`,
  );
  const row = counts.rows[0];
  if (row.users || row.profiles || row.friendships) {
    throw new Error('Target account tables are not empty; refusing to merge or overwrite rows');
  }
}

async function loadSourceData(source) {
  const [users, profiles, preferences, friendships, enabledTwoFactor] = await Promise.all([
    source.query(
      `SELECT id, username, email, password_hash, created_at, updated_at, is_verified, profile_id
       FROM users
       ORDER BY created_at, id`,
    ),
    source.query(
      `SELECT id, user_id, display_name, bio, avatar_filename, created_at, updated_at
       FROM user_profiles
       ORDER BY id`,
    ),
    source.query(
      `SELECT user_id, theme, accent_color, bg_color, text_color, hover_color,
              density, message_group_spacing, chat_font_scale,
              message_notifications_enabled, updated_at
       FROM user_preferences
       ORDER BY user_id`,
    ),
    source.query(
      `SELECT id, requester_id, addressee_id, status, created_at, updated_at
       FROM friendships
       WHERE status = ANY($1::varchar[])
       ORDER BY id`,
      [FRIENDSHIP_STATUSES],
    ),
    source.query(
      `SELECT COUNT(*)::int AS count
       FROM user_2fa
       WHERE is_enabled = TRUE`,
    ),
  ]);

  return {
    users: users.rows,
    profiles: profiles.rows,
    preferences: preferences.rows,
    friendships: friendships.rows,
    enabledTwoFactorCount: enabledTwoFactor.rows[0]?.count || 0,
  };
}

async function loadTwoFactorData(source) {
  const [methods, backupCodes] = await Promise.all([
    source.query(
      `SELECT id, user_id, method, totp_secret, is_enabled, enabled_at, created_at
       FROM user_2fa
       ORDER BY id`,
    ),
    source.query(
      `SELECT id, user_id, code_hash, is_used, used_at, created_at
       FROM user_2fa_backup_codes
       ORDER BY id`,
    ),
  ]);
  return { methods: methods.rows, backupCodes: backupCodes.rows };
}

async function importAccounts(target, sourceData, twoFactorData) {
  await target.query('BEGIN');
  try {
    await insertRows(
      target,
      'users',
      ['id', 'username', 'email', 'password_hash', 'created_at', 'updated_at', 'is_verified'],
      sourceData.users,
    );
    await insertRows(
      target,
      'user_profiles',
      ['id', 'user_id', 'display_name', 'bio', 'avatar_filename', 'created_at', 'updated_at'],
      sourceData.profiles,
    );

    for (const user of sourceData.users) {
      if (user.profile_id !== null) {
        await target.query(
          `UPDATE users SET profile_id = $1 WHERE id = $2`,
          [user.profile_id, user.id],
        );
      }
    }

    await insertRows(
      target,
      'user_preferences',
      [
        'user_id',
        'theme',
        'accent_color',
        'bg_color',
        'text_color',
        'hover_color',
        'density',
        'message_group_spacing',
        'chat_font_scale',
        'message_notifications_enabled',
        'updated_at',
      ],
      sourceData.preferences,
    );
    await insertRows(
      target,
      'friendships',
      ['id', 'requester_id', 'addressee_id', 'status', 'created_at', 'updated_at'],
      sourceData.friendships,
    );

    if (twoFactorData) {
      await insertRows(
        target,
        'user_2fa',
        ['id', 'user_id', 'method', 'totp_secret', 'is_enabled', 'enabled_at', 'created_at'],
        twoFactorData.methods,
      );
      await insertRows(
        target,
        'user_2fa_backup_codes',
        ['id', 'user_id', 'code_hash', 'is_used', 'used_at', 'created_at'],
        twoFactorData.backupCodes,
      );
    }

    await resetSequence(target, 'friendships');
    if (twoFactorData) {
      await resetSequence(target, 'user_2fa');
      await resetSequence(target, 'user_2fa_backup_codes');
    }

    await target.query('COMMIT');
  } catch (error) {
    await target.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (process.env.ACCOUNT_IMPORT_CONFIRM !== CONFIRMATION) {
    throw new Error(`Set ACCOUNT_IMPORT_CONFIRM=${CONFIRMATION} to allow the import`);
  }

  const sourceConfig = connectionConfig('SOURCE');
  const targetConfig = connectionConfig('TARGET');
  if (connectionIdentity(sourceConfig) === connectionIdentity(targetConfig)) {
    throw new Error('Source and target resolve to the same PostgreSQL database');
  }

  const sourcePool = new Pool(sourceConfig);
  const targetPool = new Pool(targetConfig);
  let source;
  let target;

  try {
    source = await sourcePool.connect();
    target = await targetPool.connect();

    const [resolvedSource, resolvedTarget] = await Promise.all([
      resolvedDatabaseIdentity(source),
      resolvedDatabaseIdentity(target),
    ]);
    if (resolvedSource === resolvedTarget) {
      throw new Error('Source and target connections resolved to the same PostgreSQL database');
    }

    await assertTargetIsEmpty(target);

    const sourceData = await loadSourceData(source);
    const twoFactorMode = parseTwoFactorMode();
    if (sourceData.enabledTwoFactorCount > 0 && !twoFactorMode) {
      throw new Error(
        'Source has enabled 2FA accounts. Set ACCOUNT_IMPORT_2FA_MODE=preserve or reset explicitly.',
      );
    }

    const twoFactorData = twoFactorMode === 'preserve'
      ? await loadTwoFactorData(source)
      : null;

    await importAccounts(target, sourceData, twoFactorData);

    console.log('Account import completed', {
      users: sourceData.users.length,
      profiles: sourceData.profiles.length,
      preferences: sourceData.preferences.length,
      friendshipsAndBlocks: sourceData.friendships.length,
      twoFactorMode: twoFactorMode || 'not_needed',
    });
  } finally {
    source?.release();
    target?.release();
    await sourcePool.end();
    await targetPool.end();
  }
}

main().catch((error) => {
  console.error('Account import failed:', error.message);
  process.exitCode = 1;
});
