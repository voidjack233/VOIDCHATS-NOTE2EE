import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../services/totpService.js';
import { sendVerificationEmail } from '../../../middleware/emailService.js';
import { updateTrustScore } from '../../../middleware/captcha/trustScore.js';
import { DeviceFingerprint } from '../../../utils/deviceFingerprint.js';
import { IPSecurity } from '../../../utils/securityUtils.js';
import {
  consumeBackupCode,
  decrypt,
  findMatchingBackupCodeId,
  safeEqualHex,
} from '../../services/twoFactorService.js';
import {
  checkTwoFactorBlocked,
  claimPendingTwoFactorSession,
  clearTwoFactorAttemptState,
  createTwoFactorClaimOwnerId,
  create2FASession,
  deletePendingTwoFactorSession,
  finalizeClaimedTwoFactorSession,
  generateEmailCode,
  getPendingTwoFactorSession,
  getTwoFactorEmailRetryAfter,
  hasExceededTwoFactorEmailSends,
  hashEmailCode,
  isSameRequestBinding,
  recordTwoFactorEmailSend,
  recordTwoFactorFailure,
  releaseClaimedTwoFactorSession,
  updatePendingTwoFactorSession,
} from '../../services/twoFactorChallengeService.js';
import {
  isTwoFactorMethodAuthorized,
  normalizeTwoFactorMethod,
} from '../../services/twoFactorMethodService.js';
import {
  SecurityCounterUnavailableError,
} from '../../services/securityCounterService.js';
import {
  activateLoginSession,
  createLoginSessionRecord,
  setLoginSessionCookies,
} from '../../services/loginSessionService.js';

const router = Router();

export { create2FASession };

function sendTwoFactorCounterUnavailable(res) {
  return res.status(503).json({
    success: false,
    message: 'Verification is temporarily unavailable. Please try again.',
    code: 'TWO_FA_SECURITY_UNAVAILABLE',
    retryable: true,
  });
}

async function sendFailedTwoFactorAttempt(res, twoFactorToken, message) {
  const failureState = await recordTwoFactorFailure(twoFactorToken);
  if (failureState.exhausted) {
    await deletePendingTwoFactorSession(twoFactorToken);
    res.set('Retry-After', String(Math.max(1, failureState.retryAfterSeconds)));
    return res.status(429).json({
      success: false,
      message: 'Too many invalid 2FA attempts. Please login again.',
      code: 'TWO_FA_RATE_LIMIT',
      retryAfterSeconds: failureState.retryAfterSeconds,
    });
  }

  return res.status(400).json({
    success: false,
    message,
  });
}

// POST /api/auth/2fa/verify-login/send-email — Send email code during login
router.post('/send-email', async (req, res) => {
  try {
    const { twoFactorToken } = req.body;

    if (!twoFactorToken) {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const session = await getPendingTwoFactorSession(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }

    if (!isSameRequestBinding(session, req)) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: '2FA session changed devices. Please login again.',
        code: 'TWO_FA_DEVICE_MISMATCH',
      });
    }

    if (
      !await isTwoFactorMethodAuthorized(pool, session, 'email')
    ) {
      return res.status(400).json({
        success: false,
        message: 'The selected verification method is unavailable.',
        code: 'TWO_FA_METHOD_UNAVAILABLE',
      });
    }

    const emailSendCount = await recordTwoFactorEmailSend(twoFactorToken);
    if (hasExceededTwoFactorEmailSends(emailSendCount)) {
      const retryAfterSeconds = await getTwoFactorEmailRetryAfter(twoFactorToken);
      return res.status(429).json({
        success: false,
        message: 'Too many email code requests. Please wait before trying again.',
        code: 'TWO_FA_EMAIL_RATE_LIMIT',
        retryAfterSeconds,
      });
    }

    // Get user email
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }

    const email = userResult.rows[0].email;
    const code = generateEmailCode();

    const nextSession = {
      ...session,
      emailCodeHash: hashEmailCode(twoFactorToken, code),
      emailCodeExpiresAt: Date.now() + 10 * 60 * 1000,
    };
    const updateStatus = await updatePendingTwoFactorSession(
      twoFactorToken,
      session,
      nextSession,
    );
    if (updateStatus !== 'updated') {
      const claimBusy = updateStatus === 'busy';
      return res.status(claimBusy ? 409 : 401).json({
        success: false,
        message: claimBusy
          ? 'This verification session is already being completed.'
          : 'Session expired or changed. Please login again.',
        code: claimBusy
          ? 'TWO_FA_SESSION_BUSY'
          : updateStatus === 'missing'
            ? 'TWO_FA_SESSION_USED'
            : 'TWO_FA_SESSION_CHANGED',
      });
    }

    await sendVerificationEmail(email, code);

    res.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (err) {
    if (err instanceof SecurityCounterUnavailableError) {
      return sendTwoFactorCounterUnavailable(res);
    }
    console.error('2FA send email error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }
});

class PostClaimValidationError extends Error {
  constructor(status, body) {
    super(body.message);
    this.name = 'PostClaimValidationError';
    this.status = status;
    this.body = body;
  }
}

function sendFreshLoginRequired(res, code) {
  return res.status(503).json({
    success: false,
    message: 'Login completion could not be confirmed. Please login again.',
    code,
    retryable: false,
    requiresFreshLogin: true,
  });
}

function sendRetryableLoginCompletionError(res) {
  return res.status(503).json({
    success: false,
    message: 'Login completion is temporarily unavailable. Please try again.',
    code: 'TWO_FA_LOGIN_TEMPORARILY_UNAVAILABLE',
    retryable: true,
  });
}

async function validateTotpCandidate(queryable, userId, code) {
  const result = await queryable.query(
    `SELECT totp_secret
     FROM user_2fa
     WHERE user_id = $1
       AND method = 'totp'
       AND is_enabled = true`,
    [userId],
  );
  if (result.rows.length === 0) return 'unavailable';

  const secret = decrypt(result.rows[0].totp_secret);
  return totp.verifyToken(code, secret) ? 'valid' : 'invalid';
}

function isExactVerifiedEmailSnapshot({
  claimedSession,
  expectedSession,
  verifiedEmailCodeHash,
  now = Date.now(),
}) {
  const expiresAt = Number(claimedSession?.emailCodeExpiresAt);
  return Boolean(
    verifiedEmailCodeHash &&
    claimedSession?.emailCodeHash === verifiedEmailCodeHash &&
    claimedSession.emailCodeHash === expectedSession?.emailCodeHash &&
    expiresAt === Number(expectedSession?.emailCodeExpiresAt) &&
    Number.isFinite(expiresAt) &&
    now <= expiresAt
  );
}

export function createVerifyLoginHandler({
  databasePool = pool,
  claimChallenge = claimPendingTwoFactorSession,
  finalizeChallenge = finalizeClaimedTwoFactorSession,
  releaseChallenge = releaseClaimedTwoFactorSession,
  createClaimOwnerId = createTwoFactorClaimOwnerId,
  createSessionRecord = createLoginSessionRecord,
  activateSession = activateLoginSession,
  setSessionCookies = setLoginSessionCookies,
  recordLoginSuccess = (req, userId) => (
    IPSecurity.logIPActivity(req, 'LOGIN_SUCCESS', userId)
  ),
  recordLoginTrust = (req, res) => (
    updateTrustScore(
      DeviceFingerprint.ensureFingerprint(req, res),
      'LOGIN_SUCCESS',
      req,
    )
  ),
} = {}) {
  return async function verifyLogin(req, res) {
    let dbClient = null;
    let transactionState = 'not_started';
    let claimOwnerId = null;
    let claimOwned = false;
    let claimOutcomeUnknown = false;
    let destroyDbClient = false;

    const rollbackOpenTransaction = async () => {
      if (transactionState !== 'open') return transactionState === 'rolled_back';

      try {
        await dbClient.query('ROLLBACK');
        transactionState = 'rolled_back';
        return true;
      } catch (rollbackError) {
        transactionState = 'rollback_failed';
        destroyDbClient = true;
        console.error('2FA login transaction rollback error:', rollbackError);
        return false;
      }
    };

    const releaseOwnedClaim = async () => {
      const releaseStatus = await releaseChallenge({
        twoFactorToken: req.body.twoFactorToken,
        claimOwnerId,
      });
      if (releaseStatus !== 'released' && releaseStatus !== 'missing') {
        return false;
      }
      claimOwned = false;
      claimOutcomeUnknown = false;
      return true;
    };

    try {
      const { twoFactorToken, code } = req.body;
      const method = normalizeTwoFactorMethod(req.body.method);

      if (!twoFactorToken || !code || typeof req.body.method !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Token, code, and method are required.',
        });
      }

      const session = await getPendingTwoFactorSession(twoFactorToken);
      if (!session) {
        await clearTwoFactorAttemptState(twoFactorToken);
        return res.status(401).json({
          success: false,
          message: 'Session expired or already used. Please login again.',
          code: 'TWO_FA_SESSION_USED',
        });
      }
      if (Date.now() > session.expiresAt) {
        await clearTwoFactorAttemptState(twoFactorToken);
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'TWO_FA_SESSION_EXPIRED',
        });
      }

      if (!isSameRequestBinding(session, req)) {
        await clearTwoFactorAttemptState(twoFactorToken);
        return res.status(401).json({
          success: false,
          message: '2FA session changed devices. Please login again.',
          code: 'TWO_FA_DEVICE_MISMATCH',
        });
      }

      const blockedState = await checkTwoFactorBlocked(twoFactorToken);
      if (blockedState.blocked) {
        await deletePendingTwoFactorSession(twoFactorToken);
        res.set('Retry-After', String(Math.max(1, blockedState.retryAfterSeconds)));
        return res.status(429).json({
          success: false,
          message: 'Too many invalid 2FA attempts. Please login again.',
          code: 'TWO_FA_RATE_LIMIT',
          retryAfterSeconds: blockedState.retryAfterSeconds,
        });
      }

      if (
        !method ||
        !await isTwoFactorMethodAuthorized(databasePool, session, method)
      ) {
        return sendFailedTwoFactorAttempt(
          res,
          twoFactorToken,
          'The selected verification method is unavailable.',
        );
      }

      const userId = session.userId;
      let backupCodeId = null;
      let verifiedEmailCodeHash = null;

      if (method === 'backup') {
        const backupCodes = await databasePool.query(
          `SELECT id, code_hash
           FROM user_2fa_backup_codes
           WHERE user_id = $1
             AND is_used = false`,
          [userId],
        );
        backupCodeId = await findMatchingBackupCodeId(backupCodes.rows, code);
        if (!backupCodeId) {
          return sendFailedTwoFactorAttempt(res, twoFactorToken, 'Invalid backup code.');
        }
      } else if (method === 'totp') {
        const totpStatus = await validateTotpCandidate(databasePool, userId, code);
        if (totpStatus === 'unavailable') {
          return res.status(400).json({
            success: false,
            message: 'Authenticator app is not set up.',
          });
        }
        if (totpStatus !== 'valid') {
          return sendFailedTwoFactorAttempt(
            res,
            twoFactorToken,
            'Invalid code. Please try again.',
          );
        }
      } else if (method === 'email') {
        if (!session.emailCodeHash || Date.now() > session.emailCodeExpiresAt) {
          return res.status(400).json({
            success: false,
            message: 'Email code expired. Please request a new one.',
          });
        }

        const submittedCodeHash = hashEmailCode(twoFactorToken, code);
        if (!safeEqualHex(session.emailCodeHash, submittedCodeHash)) {
          return sendFailedTwoFactorAttempt(
            res,
            twoFactorToken,
            'Invalid code. Please try again.',
          );
        }
        verifiedEmailCodeHash = submittedCodeHash;
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid verification method.',
        });
      }

      dbClient = await databasePool.connect();
      transactionState = 'beginning';
      await dbClient.query('BEGIN');
      transactionState = 'open';

      claimOwnerId = createClaimOwnerId();
      claimOutcomeUnknown = true;
      const challengeClaim = await claimChallenge({
        twoFactorToken,
        expectedSession: session,
        claimOwnerId,
      });
      claimOutcomeUnknown = false;

      if (challengeClaim.status !== 'claimed') {
        if (!await rollbackOpenTransaction()) {
          return sendFreshLoginRequired(res, 'TWO_FA_ROLLBACK_OUTCOME_UNKNOWN');
        }

        if (challengeClaim.status === 'busy') {
          return res.status(409).json({
            success: false,
            message: 'This verification session is already being completed.',
            code: 'TWO_FA_SESSION_BUSY',
          });
        }

        return res.status(401).json({
          success: false,
          message: challengeClaim.status === 'missing'
            ? 'Session expired or already used. Please login again.'
            : 'Session changed during verification. Please login again.',
          code: challengeClaim.status === 'missing'
            ? 'TWO_FA_SESSION_USED'
            : 'TWO_FA_SESSION_CHANGED',
        });
      }

      claimOwned = true;
      const claimedSession = challengeClaim.session;
      if (
        String(claimedSession?.userId || '') !== String(userId) ||
        Date.now() > Number(claimedSession?.expiresAt) ||
        !isSameRequestBinding(claimedSession, req)
      ) {
        throw new PostClaimValidationError(401, {
          success: false,
          message: 'Session changed during verification. Please login again.',
          code: 'TWO_FA_SESSION_CHANGED',
        });
      }

      if (!await isTwoFactorMethodAuthorized(dbClient, claimedSession, method)) {
        throw new PostClaimValidationError(400, {
          success: false,
          message: 'The selected verification method is unavailable.',
          code: 'TWO_FA_METHOD_UNAVAILABLE',
        });
      }

      if (method === 'totp') {
        const totpStatus = await validateTotpCandidate(dbClient, userId, code);
        if (totpStatus !== 'valid') {
          throw new PostClaimValidationError(400, {
            success: false,
            message: 'The authenticator configuration changed. Please try again.',
            code: 'TWO_FA_SESSION_CHANGED',
          });
        }
      } else if (method === 'email' && !isExactVerifiedEmailSnapshot({
        claimedSession,
        expectedSession: session,
        verifiedEmailCodeHash,
      })) {
        throw new PostClaimValidationError(401, {
          success: false,
          message: 'Email verification changed or expired. Please request a new code.',
          code: 'TWO_FA_SESSION_CHANGED',
        });
      } else if (
        method === 'backup' &&
        !await consumeBackupCode(dbClient, backupCodeId, userId)
      ) {
        throw new PostClaimValidationError(400, {
          success: false,
          message: 'Invalid or already used backup code.',
          code: 'TWO_FA_BACKUP_CODE_USED',
        });
      }

      const userResult = await dbClient.query(
        'SELECT id, email, username, profile_id, is_verified FROM users WHERE id = $1',
        [userId],
      );
      const user = userResult.rows[0];
      if (!user) {
        throw new PostClaimValidationError(401, {
          success: false,
          message: 'Session expired. Please login again.',
          code: 'TWO_FA_SESSION_EXPIRED',
        });
      }

      const loginSession = await createSessionRecord({
        queryable: dbClient,
        user,
        req,
        res,
      });

      transactionState = 'commit_attempted';
      try {
        await dbClient.query('COMMIT');
        transactionState = 'committed';
      } catch (commitError) {
        transactionState = 'commit_uncertain';
        destroyDbClient = true;
        console.error('2FA login commit outcome is uncertain:', commitError);
        return sendFreshLoginRequired(res, 'TWO_FA_COMMIT_OUTCOME_UNKNOWN');
      }

      const finalizeStatus = await finalizeChallenge({
        twoFactorToken,
        claimOwnerId,
      });
      if (finalizeStatus !== 'finalized') {
        return sendFreshLoginRequired(res, 'TWO_FA_FINALIZATION_FAILED');
      }
      claimOwned = false;

      await activateSession(loginSession);
      await recordLoginSuccess(req, userId);
      await recordLoginTrust(req, res);
      setSessionCookies(req, res, loginSession);

      return res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          profile_id: user.profile_id,
          is_verified: user.is_verified,
        },
        device: {
          id: loginSession.deviceId,
          name: loginSession.deviceInfo.deviceName,
          type: loginSession.deviceInfo.deviceType,
        },
      });
    } catch (err) {
      if (transactionState === 'committed' || transactionState === 'commit_uncertain') {
        console.error('2FA post-commit completion error:', err);
        return sendFreshLoginRequired(
          res,
          transactionState === 'commit_uncertain'
            ? 'TWO_FA_COMMIT_OUTCOME_UNKNOWN'
            : 'TWO_FA_POST_COMMIT_SECURITY_FAILURE',
        );
      }

      if (transactionState === 'beginning') {
        destroyDbClient = true;
      }

      const rollbackConfirmed = transactionState === 'open'
        ? await rollbackOpenTransaction()
        : transactionState !== 'rollback_failed';

      if ((claimOwned || claimOutcomeUnknown) && rollbackConfirmed) {
        try {
          if (!await releaseOwnedClaim()) {
            return sendFreshLoginRequired(res, 'TWO_FA_CLAIM_RELEASE_FAILED');
          }
        } catch (releaseError) {
          console.error('2FA claim release error:', releaseError);
          return sendFreshLoginRequired(res, 'TWO_FA_CLAIM_RELEASE_FAILED');
        }
      } else if ((claimOwned || claimOutcomeUnknown) && !rollbackConfirmed) {
        return sendFreshLoginRequired(res, 'TWO_FA_ROLLBACK_OUTCOME_UNKNOWN');
      }

      if (err instanceof PostClaimValidationError) {
        return res.status(err.status).json(err.body);
      }
      if (err instanceof SecurityCounterUnavailableError) {
        return sendTwoFactorCounterUnavailable(res);
      }

      console.error('2FA verify login error:', err);
      return sendRetryableLoginCompletionError(res);
    } finally {
      dbClient?.release(destroyDbClient);
    }
  };
}

// POST /api/auth/2fa/verify-login — Verify 2FA code and complete login
router.post('/', createVerifyLoginHandler());

export default router;
