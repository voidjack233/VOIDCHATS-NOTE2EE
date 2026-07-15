function requiredValue(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required database setting ${name}`);
  }
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function identifier(value, name) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, and underscores`);
  }
  return value;
}

export function resolvePostgresConfig(env = process.env) {
  return {
    host: requiredValue(env, 'PGHOST'),
    port: positiveInteger(requiredValue(env, 'PGPORT'), 'PGPORT'),
    database: requiredValue(env, 'PGDATABASE'),
    user: requiredValue(env, 'PGUSER'),
    password: requiredValue(env, 'PGPASSWORD'),
  };
}

export function resolveScyllaConfig(env = process.env) {
  const contactPoints = requiredValue(env, 'SCYLLA_HOST')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (contactPoints.length === 0) {
    throw new Error('SCYLLA_HOST must contain at least one contact point');
  }

  return {
    contactPoints,
    keyspace: identifier(requiredValue(env, 'SCYLLA_KEYSPACE'), 'SCYLLA_KEYSPACE'),
    localDataCenter: identifier(
      requiredValue(env, 'SCYLLA_LOCAL_DATACENTER'),
      'SCYLLA_LOCAL_DATACENTER',
    ),
    replicationFactor: positiveInteger(
      requiredValue(env, 'SCYLLA_REPLICATION_FACTOR'),
      'SCYLLA_REPLICATION_FACTOR',
    ),
  };
}
