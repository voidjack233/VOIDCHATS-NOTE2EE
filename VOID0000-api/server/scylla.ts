import dotenv from 'dotenv';
import cassandra from 'cassandra-driver';
import { resolveScyllaConfig } from './config/databaseConfig.js';
import { fromProjectRoot } from './config/projectRoot.js';

dotenv.config({ path: fromProjectRoot('.env') });

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

// Driver 4.9 can replace a Host when its control connection reconnects through
// the contact points. Client.shutdown() visits only the current host map, so
// retain removed hosts to close their pools and cancel their reconnect timers.
// Host.shutdown(false) is the same driver teardown used by Client.shutdown().
type RetiredHost = cassandra.Host & { shutdown(waitForPending: boolean): Promise<void> };
const retiredHosts = new Set<RetiredHost>();
const rememberRemovedHost = (host: RetiredHost) => retiredHosts.add(host);
client.on('hostRemove', rememberRemovedHost);
let shutdownPromise: Promise<void> | undefined;

export function shutdownScyllaClient(): Promise<void> {
  shutdownPromise ??= (async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => client.shutdown()),
      ...Array.from(retiredHosts, (host) => Promise.resolve().then(() => host.shutdown(false))),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Scylla resource shutdown failed');
    }
    retiredHosts.clear();
    client.off('hostRemove', rememberRemovedHost);
  })();
  return shutdownPromise;
}

client.connect()
  .then(() => console.log('✅ ScyllaDB connected'))
  .catch((err) => console.error('❌ ScyllaDB connection error:', err.message));

// Helper: generate TimeUUID for message IDs
export function generateTimeUUID(): cassandra.types.TimeUuid {
  return cassandra.types.TimeUuid.now();
}

// Helper: convert TimeUUID to Date
export function timeUUIDToDate(timeUuid: cassandra.types.TimeUuid): Date {
  return timeUuid.getDate();
}

// Helper: TimeUUID from date (for pagination)
export function timeUUIDFromDate(date: Date): cassandra.types.TimeUuid {
  return cassandra.types.TimeUuid.fromDate(date);
}

export { cassandra };
export default client;
