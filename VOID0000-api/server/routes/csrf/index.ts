import { Router } from 'express';
import { generateEncryptedCSRFToken } from '../../middleware/encryptedCSRF.js';
import { getCookieOptions } from '../../utils/cookieConfig.js'; 
import { isAuthTokenClaims, verifyAccessToken, verifyRefreshToken } from '../../auth/services/tokenService.js';
import { matchesRequestAccount, accountChangedResponse } from '../../auth/middleware/requestAccount.js';

const router = Router();

router.get('/csrf-token', (req, res) => {
  if (req.headers['x-void-account-id'] !== undefined) {
    // Expired access with a valid refresh session must still be able to acquire
    // CSRF, but a delayed account-A operation must not acquire it under B.
    let userId: string | null = null;
    for (const [token, verify, type] of [
      [req.cookies.accessToken, verifyAccessToken, 'access'],
      [req.cookies.refreshToken, verifyRefreshToken, 'refresh'],
    ] as const) {
      try {
        if (typeof token !== 'string') continue;
        const decoded = verify(token);
        if (isAuthTokenClaims(decoded, type)) { userId = decoded.id; break; }
      } catch { /* Try the remaining credential without adopting a new account. */ }
    }
    if (!userId || !matchesRequestAccount(req, userId)) return res.status(409).json(accountChangedResponse);
  }
  const { plainToken, encryptedToken } = generateEncryptedCSRFToken();

  // Use same cookie options as auth tokens
  res.cookie('_csrf', encryptedToken, getCookieOptions(30 * 24 * 60 * 60 * 1000, req));  // 30 days

  res.json({
    success: true,
    csrfToken: plainToken
  });
});

export default router;
