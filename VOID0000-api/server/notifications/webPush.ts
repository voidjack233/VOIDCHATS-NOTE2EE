import webPush from 'web-push';
import type { PushSubscription } from 'web-push';
import type { QueryResultRow } from 'pg';
import { pool } from '../db.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || '';

const isConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (isConfigured) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[PUSH] Web Push disabled. Missing VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, or VAPID_SUBJECT.');
}

interface PushSubscriptionRow extends QueryResultRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface SubscriptionIdRow extends QueryResultRow {
  id: string;
}

interface SenderNameRow extends QueryResultRow {
  name: string;
}

export type PushConversation = {
  id?: string | null;
  public_id?: string | null;
  type?: string | null;
  name?: string | null;
};

type MessageNotificationPayload = {
  type: 'message';
  title: string;
  body: string;
  tag: string;
  url: string;
  conversation_id: string | null;
  conversation_public_id: string | null;
  mentioned: boolean;
};

type PushDeliverySummary = {
  attempted: number;
  delivered: number;
  failed: number;
};

type SaveSubscriptionInput = {
  userId: string;
  deviceId: string;
  subscription: unknown;
  userAgent: string | null;
};

type RevokeSubscriptionInput = {
  userId: string;
  deviceId: string;
  endpoint: string | null;
};

type Mention = { user_id?: unknown };

function hasUsableSubscription(subscription: unknown): subscription is PushSubscription {
  return Boolean(
    subscription &&
    typeof subscription === 'object' &&
    'endpoint' in subscription &&
    typeof subscription.endpoint === 'string' &&
    subscription.endpoint.trim() &&
    'keys' in subscription &&
    subscription.keys &&
    typeof subscription.keys === 'object' &&
    'p256dh' in subscription.keys &&
    typeof subscription.keys.p256dh === 'string' &&
    subscription.keys.p256dh.trim() &&
    'auth' in subscription.keys &&
    typeof subscription.keys.auth === 'string' &&
    subscription.keys.auth.trim()
  );
}

function toPushSubscription(row: PushSubscriptionRow): PushSubscription {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}

function getRouteForConversation(conversation: PushConversation | null | undefined): string {
  const routeId = conversation?.public_id || conversation?.id;
  if (!routeId) return '/chats';

  if (conversation.type === 'dm') {
    return `/chats/@me/${routeId}`;
  }

  return `/chats/${routeId}`;
}

function buildMessageNotificationPayload({
  conversation,
  senderName,
  mentioned,
}: {
  conversation: PushConversation | null | undefined;
  senderName: string;
  mentioned: boolean;
}): MessageNotificationPayload {
  const conversationName = conversation?.name || 'Group';
  const title = mentioned
    ? `You were mentioned by ${senderName}`
    : conversation?.type === 'dm'
      ? `New message from ${senderName}`
      : `New message in ${conversationName}`;

  return {
    type: 'message',
    title,
    body: 'Open VOID to read it.',
    tag: `void-message:${conversation?.id || 'unknown'}`,
    url: getRouteForConversation(conversation),
    conversation_id: conversation?.id || null,
    conversation_public_id: conversation?.public_id || null,
    mentioned: Boolean(mentioned),
  };
}

async function markPushSuccess(subscriptionId: string): Promise<void> {
  await pool.query(
    `UPDATE push_subscriptions
     SET last_success_at = NOW(),
         last_failure_at = NULL,
         failure_count = 0,
         updated_at = NOW()
     WHERE id = $1`,
    [subscriptionId]
  );
}

async function markPushFailure(subscriptionId: string, error: unknown): Promise<void> {
  const statusCode = error && typeof error === 'object'
    ? Number(
        ('statusCode' in error ? error.statusCode : undefined) ||
        ('status' in error ? error.status : undefined) ||
        0,
      )
    : 0;
  const shouldRevoke = statusCode === 404 || statusCode === 410;

  await pool.query(
    `UPDATE push_subscriptions
     SET last_failure_at = NOW(),
         failure_count = COALESCE(failure_count, 0) + 1,
         revoked_at = CASE WHEN $2::boolean THEN NOW() ELSE revoked_at END,
         enabled = CASE WHEN $2::boolean THEN FALSE ELSE enabled END,
         updated_at = NOW()
     WHERE id = $1`,
    [subscriptionId, shouldRevoke]
  );
}

async function sendPayloadToRows(
  rows: PushSubscriptionRow[],
  payload: Record<string, unknown> | MessageNotificationPayload,
): Promise<PushDeliverySummary> {
  if (!isConfigured || rows.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    rows.map((row) => webPush.sendNotification(toPushSubscription(row), body))
  );

  await Promise.all(results.map((result, index) => (
    result.status === 'fulfilled'
      ? markPushSuccess(rows[index].id)
      : markPushFailure(rows[index].id, result.reason)
  )));

  return {
    attempted: rows.length,
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

export function isWebPushConfigured(): boolean {
  return isConfigured;
}

export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY || null;
}

export async function saveWebPushSubscription({
  userId,
  deviceId,
  subscription,
  userAgent,
}: SaveSubscriptionInput): Promise<SubscriptionIdRow> {
  if (!isConfigured) {
    const error = Object.assign(
      new Error('Browser push is not configured on this server'),
      { status: 503 },
    );
    throw error;
  }

  if (!hasUsableSubscription(subscription)) {
    const error = Object.assign(new Error('Invalid push subscription'), { status: 400 });
    throw error;
  }

  const endpoint = subscription.endpoint.trim();
  const p256dh = subscription.keys.p256dh.trim();
  const auth = subscription.keys.auth.trim();

  const result = await pool.query<SubscriptionIdRow>(
    `INSERT INTO push_subscriptions (
       user_id, device_id, provider, endpoint, p256dh, auth, user_agent,
       enabled, revoked_at, updated_at
     )
     VALUES ($1, $2, 'web_push', $3, $4, $5, $6, TRUE, NULL, NOW())
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       device_id = EXCLUDED.device_id,
       provider = 'web_push',
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       enabled = TRUE,
       revoked_at = NULL,
       updated_at = NOW()
     RETURNING id`,
    [userId, deviceId, endpoint, p256dh, auth, userAgent || null]
  );

  return result.rows[0];
}

export async function revokeWebPushSubscription({
  userId,
  deviceId,
  endpoint,
}: RevokeSubscriptionInput): Promise<void> {
  if (endpoint) {
    await pool.query(
      `UPDATE push_subscriptions
       SET enabled = FALSE,
           revoked_at = NOW(),
           updated_at = NOW()
       WHERE user_id = $1
         AND endpoint = $2`,
      [userId, endpoint]
    );
    return;
  }

  await pool.query(
    `UPDATE push_subscriptions
     SET enabled = FALSE,
         revoked_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $1
       AND device_id = $2
       AND provider = 'web_push'
       AND revoked_at IS NULL`,
    [userId, deviceId]
  );
}

export async function sendTestPush(userId: string): Promise<{
  configured: boolean;
  attempted: number;
  delivered: number;
  failed: number;
}> {
  if (!isConfigured) {
    return { configured: false, attempted: 0, delivered: 0, failed: 0 };
  }

  const result = await pool.query<PushSubscriptionRow>(
    `SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = $1
       AND provider = 'web_push'
       AND enabled = TRUE
       AND revoked_at IS NULL`,
    [userId]
  );

  const delivery = await sendPayloadToRows(result.rows, {
    type: 'test',
    title: 'VOID notifications are working',
    body: 'Browser push is enabled on this device.',
    tag: 'void-push-test',
    url: '/chats',
  });

  return { configured: true, ...delivery };
}

export async function dispatchMessagePushNotifications({
  senderId,
  recipientIds,
  conversation,
  mentions = [],
}: {
  senderId: string;
  recipientIds: string[];
  conversation: PushConversation;
  mentions?: Mention[];
}): Promise<void> {
  if (!isConfigured || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    return;
  }

  const targetUserIds = [...new Set(recipientIds.filter((id) => id && id !== senderId))];
  if (targetUserIds.length === 0) {
    return;
  }

  try {
    const senderResult = await pool.query<SenderNameRow>(
      `SELECT COALESCE(NULLIF(up.display_name, ''), u.username) AS name
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [senderId]
    );
    const senderName = senderResult.rows[0]?.name || 'Someone';
    const mentionedIds = new Set(
      Array.isArray(mentions)
        ? mentions.map((mention) => mention?.user_id).filter(Boolean)
        : []
    );

    const subscriptionsResult = await pool.query<PushSubscriptionRow>(
      `SELECT ps.id, ps.user_id::text AS user_id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       LEFT JOIN user_preferences prefs ON prefs.user_id = ps.user_id
       WHERE ps.user_id = ANY($1::uuid[])
         AND ps.provider = 'web_push'
         AND ps.enabled = TRUE
         AND ps.revoked_at IS NULL
         AND COALESCE(prefs.message_notifications_enabled, TRUE) = TRUE`,
      [targetUserIds]
    );

    const rowsByUserId = new Map<string, PushSubscriptionRow[]>();
    for (const row of subscriptionsResult.rows) {
      const rows = rowsByUserId.get(row.user_id) || [];
      rows.push(row);
      rowsByUserId.set(row.user_id, rows);
    }

    await Promise.all(targetUserIds.map((recipientId) => {
      const rows = rowsByUserId.get(recipientId) || [];
      if (rows.length === 0) return Promise.resolve();

      return sendPayloadToRows(
        rows,
        buildMessageNotificationPayload({
          conversation,
          senderName,
          mentioned: mentionedIds.has(recipientId),
        })
      );
    }));
  } catch (error) {
    console.warn('[PUSH] failed to dispatch message push notifications', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
