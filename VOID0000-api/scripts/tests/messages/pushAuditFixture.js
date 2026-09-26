import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { load } from '../media/fixtures.js';
import { withPushCapacity } from '../../../server/notifications/pushTransport.js';

// Real dispatcher/PG/production capacity gate; external providers are stubbed.
export async function measurePush(storage, fixture, subscriptionsPerUser = 1, failure = false) {
  await storage.pool.query(`INSERT INTO push_subscriptions(user_id,device_id,endpoint,p256dh,auth)
    SELECT id, i::text, 'https://fcm.googleapis.com/test/'||id||'/'||i, 'test', 'test'
    FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,$2::int) i
    ON CONFLICT(endpoint) DO NOTHING`, [fixture.users, subscriptionsPerUser]);
  const counts = { queries: [], deliveries: 0, active: 0, peak: 0 };
  const dispatcher = load('notifications/webPush', {
    'web-push': { __esModule: true, default: { setVapidDetails() {} } },
    '../db.js': { pool: { query: (sql, args) => { counts.queries.push(sql); return storage.pool.query(sql, args); } } },
    './pushTransport.js': { withPushCapacity, validatePushSubscription: value => value,
      async sendPrivatePush() {
        counts.deliveries++; counts.active++; counts.peak = Math.max(counts.peak, counts.active);
        try { await delay(1); if (failure) throw Object.assign(new Error('Provider rejection'), { statusCode: 410 }); }
        finally { counts.active--; }
      } },
  }, { VAPID_PUBLIC_KEY: 'fixture', VAPID_PRIVATE_KEY: 'fixture', VAPID_SUBJECT: 'mailto:test@test.invalid' });
  const start = performance.now();
  await dispatcher.dispatchMessagePushNotifications({ senderId: fixture.user, recipientIds: fixture.users, conversation: { id: fixture.conversation, type: 'group', name: 'Test' } });
  return { members: fixture.users.length, subscriptionsPerUser, failure, ms: performance.now() - start,
    deliveries: counts.deliveries, peak: counts.peak, reads: counts.queries.filter(q => q.trim().startsWith('SELECT')).length,
    updates: counts.queries.filter(q => q.trim().startsWith('UPDATE')).length };
}
