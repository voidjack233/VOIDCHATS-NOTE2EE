import path from 'path';
import dotenv from 'dotenv';
import cassandra from 'cassandra-driver';
import { resolveScyllaConfig } from './config/databaseConfig.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const config = resolveScyllaConfig();

const client = new cassandra.Client({
  contactPoints: config.contactPoints,
  localDataCenter: config.localDataCenter,
  keyspace: config.keyspace,
  pooling: {
    coreConnectionsPerHost: {
      [cassandra.types.distance.local]: 2,
      [cassandra.types.distance.remote]: 1,
    },
  },
});

client.connect()
  .then(() => console.log('✅ ScyllaDB connected'))
  .catch((err) => console.error('❌ ScyllaDB connection error:', err.message));

// Helper: generate TimeUUID for message IDs
export function generateTimeUUID() {
  return cassandra.types.TimeUuid.now();
}

// Helper: convert TimeUUID to Date
export function timeUUIDToDate(timeUuid) {
  return timeUuid.getDate();
}

// Helper: TimeUUID from date (for pagination)
export function timeUUIDFromDate(date) {
  return cassandra.types.TimeUuid.fromDate(date);
}

export { cassandra };
export default client;
