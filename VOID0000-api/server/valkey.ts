import { Redis } from 'ioredis';
import { valkeyRetryDelay } from './valkeyRetry.js';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
  db: parseInt(process.env.VALKEY_DB || '0', 10),
  maxRetriesPerRequest: 3,
  retryStrategy: valkeyRetryDelay,
  lazyConnect: false,
});

valkey.on('connect', () => console.log('✅ Valkey connected'));
valkey.on('error', (err: Error) => console.error('❌ Valkey error:', err.message));

export default valkey;
