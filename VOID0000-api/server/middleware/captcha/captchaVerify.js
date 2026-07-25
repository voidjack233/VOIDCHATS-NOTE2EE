import { getTrustScore, updateTrustScore, TRUST_THRESHOLD, shouldRequireCaptchaForRegistration } from './trustScore.js';
import {
  consumeCaptchaChallenge,
} from '../../utils/captchaStore.js';

export async function verifyCaptcha(req, res, next) {
  try {
    const trust = await getTrustScore(req);

    if (!trust.isNew && trust.score >= TRUST_THRESHOLD) {
      req.captchaSkipped = true;
      return next();
    }
  } catch (err) {
    console.error('Trust check error:', err);
  }

  return verifyCaptchaAnswer(req, res, next);
}

export async function verifyCaptchaForRegistration(req, res, next) {
  try {
    const required = await shouldRequireCaptchaForRegistration(req);

    if (!required) {
      req.captchaSkipped = true;
      return next();
    }
  } catch (err) {
    console.error('Registration trust check error:', err);
  }

  return verifyCaptchaAnswer(req, res, next);
}

async function verifyCaptchaAnswer(req, res, next) {
  const { captchaId, captchaAnswer } = req.body;

  if (!captchaId || !captchaAnswer) {
    return res.status(400).json({
      success: false,
      message: 'Captcha is required',
      code: 'CAPTCHA_REQUIRED'
    });
  }

  let result;
  try {
    result = await consumeCaptchaChallenge(captchaId, captchaAnswer);
  } catch (err) {
    console.error('Captcha security counter error:', err);
    return res.status(503).json({
      success: false,
      message: 'Captcha verification is temporarily unavailable.',
      code: 'CAPTCHA_SECURITY_UNAVAILABLE',
      retryable: true,
    });
  }

  if (result.status === 'missing') {
    return res.status(400).json({
      success: false,
      message: 'Captcha expired or invalid. Please refresh.',
      code: 'CAPTCHA_INVALID'
    });
  }

  if (result.status === 'wrong' || result.status === 'exhausted') {
    const trust = await getTrustScore(req);
    await updateTrustScore(trust.deviceId, 'CAPTCHA_FAILED', req);
    return res.status(400).json({
      success: false,
      message: result.status === 'exhausted'
        ? 'Too many failed attempts. Please refresh captcha.'
        : 'Incorrect captcha. Please try again.',
      code: result.status === 'exhausted' ? 'CAPTCHA_MAX_ATTEMPTS' : 'CAPTCHA_WRONG',
      attemptsLeft: result.attemptsLeft,
    });
  }

  const trust = await getTrustScore(req);
  await updateTrustScore(trust.deviceId, 'CAPTCHA_PASSED', req);
  return next();
}
