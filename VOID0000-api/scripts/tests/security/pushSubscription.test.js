import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import webPush from 'web-push';
import { pool } from '../../../server/db.js';

if (process.env.PGPORT !== '15439') throw new Error('Requires isolated security-test PostgreSQL on 15439');
const vapid = webPush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.test';
const { saveWebPushSubscription, revokeWebPushSubscription } = await import('../../../server/notifications/webPush.js');
before(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT DEFAULT md5(random()::text), user_id TEXT REFERENCES users(id), device_id TEXT,
      provider TEXT, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, user_agent TEXT,
      enabled BOOLEAN, revoked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)`);
});
after(() => pool.end());
const keys = { p256dh: Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') };
async function user() { const id=randomUUID(); await pool.query('INSERT INTO users VALUES($1)',[id]); return id; }
const input = (userId, deviceId, endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) => ({ userId, deviceId, subscription: { endpoint, keys }, userAgent: null });

test('concurrent subscription registrations enforce ten per account', async () => {
  const userId=await user();
  const results=await Promise.allSettled(Array.from({ length:20 }, (_,i) => saveWebPushSubscription(input(userId,`device-${i}`))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length,10);
  assert.equal(results.filter((r) => r.reason?.status === 429).length,10);
});
test('device quota includes moving an existing endpoint from another device', async () => {
  const userId=await user();
  const one=input(userId,'phone'), two=input(userId,'phone'), other=input(userId,'tablet');
  await saveWebPushSubscription(one); await saveWebPushSubscription(two); await saveWebPushSubscription(other);
  await assert.rejects(saveWebPushSubscription(input(userId,'phone')), { status:429 });
  await assert.rejects(saveWebPushSubscription({ ...other, deviceId:'phone' }), { status:429 });
  assert.ok((await saveWebPushSubscription(one)).id);
  await revokeWebPushSubscription({ userId, deviceId:'phone', endpoint:one.subscription.endpoint });
  assert.ok((await saveWebPushSubscription({ ...other, deviceId:'phone' })).id);
});
test('registering an endpoint cannot steal another account subscription', async () => {
  const first=await user(), second=await user();
  const original=input(first,'phone');
  await saveWebPushSubscription(original);
  await assert.rejects(saveWebPushSubscription({ ...original, userId:second }), { status:409 });
  assert.equal((await pool.query('SELECT user_id FROM push_subscriptions WHERE endpoint=$1', [original.subscription.endpoint])).rows[0].user_id, first);
});
