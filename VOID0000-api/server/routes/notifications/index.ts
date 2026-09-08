import { Router } from 'express';
import { createConfiguredLimiter as createLimiter } from '../../middleware/rateLimits/createLimiter.js';
import {
  getVapidPublicKey,
  isWebPushConfigured,
  revokeWebPushSubscription,
  saveWebPushSubscription,
  sendTestPush,
} from '../../notifications/webPush.js';

const router = Router();
const subscriptionLimiter = createLimiter({ algorithm: 'token_bucket', scope: 'user', keyPrefix: 'push:subscription', bucketSize: 10, refillWindowSec: 600 });
const testLimiter = createLimiter({ algorithm: 'token_bucket', scope: 'user', keyPrefix: 'push:test', bucketSize: 3, refillWindowSec: 600 });

router.get('/vapid-public-key', (_req, res) => {
  res.json({
    success: true,
    configured: isWebPushConfigured(),
    publicKey: getVapidPublicKey(),
  });
});

router.post('/subscribe', subscriptionLimiter, async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const userId = user.id;
  const deviceId = user.device_id;
  const userAgent = req.get('user-agent') || null;

  try {
    const subscription = req.body?.subscription;
    const saved = await saveWebPushSubscription({
      userId,
      deviceId,
      subscription,
      userAgent,
    });

    res.json({
      success: true,
      subscriptionId: saved.id,
    });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error
      ? Number(error.status || 500)
      : 500;
    console.error('[PUSH] subscribe failed:', error);
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save push subscription',
    });
  }
});

router.post('/unsubscribe', async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const userId = user.id;
  const deviceId = user.device_id;
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;

  try {
    await revokeWebPushSubscription({ userId, deviceId, endpoint });
    res.json({ success: true });
  } catch (error) {
    console.error('[PUSH] unsubscribe failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disable push subscription',
    });
  }
});

router.post('/test', testLimiter, async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const result = await sendTestPush(user.id);
    res.json({
      success: result.configured,
      ...result,
      error: result.configured ? undefined : 'Browser push is not configured on this server',
    });
  } catch (error) {
    console.error('[PUSH] test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test push',
    });
  }
});

export default router;
