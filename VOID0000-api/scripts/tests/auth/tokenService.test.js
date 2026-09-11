import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import jwt from 'jsonwebtoken';

import {
  createTokenPair,
  isAuthenticatedRequestUser,
  isAuthTokenClaims,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../../server/auth/services/tokenService.js';

const originalAccessSecret = process.env.ACCESS_SECRET;
const originalRefreshSecret = process.env.REFRESH_SECRET;

before(() => {
  process.env.ACCESS_SECRET = 'a'.repeat(48);
  process.env.REFRESH_SECRET = 'b'.repeat(48);
});

after(() => {
  if (originalAccessSecret === undefined) delete process.env.ACCESS_SECRET;
  else process.env.ACCESS_SECRET = originalAccessSecret;

  if (originalRefreshSecret === undefined) delete process.env.REFRESH_SECRET;
  else process.env.REFRESH_SECRET = originalRefreshSecret;
});

test('created token pairs expose validated access and refresh claims', () => {
  const tokens = createTokenPair({
    userId: 'user-1',
    profileId: 'profile-1',
    deviceId: 'device-1',
    sessionId: 'immutable-login-id',
  });

  const accessClaims = verifyAccessToken(tokens.accessToken);
  const refreshClaims = verifyRefreshToken(tokens.refreshToken);

  assert.equal(isAuthenticatedRequestUser(accessClaims), true);
  assert.equal(isAuthTokenClaims(accessClaims, 'access'), true);
  assert.equal(isAuthTokenClaims(refreshClaims, 'refresh'), true);
  assert.equal(isAuthTokenClaims(refreshClaims, 'access'), false);
  assert.equal(accessClaims.sid, 'immutable-login-id');
  assert.equal(refreshClaims.sid, accessClaims.sid);
  assert.equal(isAuthenticatedRequestUser(refreshClaims), false);
});

test('a verified JWT with a non-object payload is not an authenticated user', () => {
  const token = jwt.sign('not-an-auth-object', process.env.ACCESS_SECRET);
  const decoded = verifyAccessToken(token);

  assert.equal(isAuthenticatedRequestUser(decoded), false);
  assert.equal(isAuthTokenClaims(decoded), false);
});

test('missing identity fields cannot satisfy the authenticated request contract', () => {
  const token = jwt.sign(
    { id: 'user-1', type: 'access' },
    process.env.ACCESS_SECRET,
  );
  const decoded = verifyAccessToken(token);

  assert.equal(isAuthenticatedRequestUser(decoded), false);
  assert.equal(isAuthTokenClaims(decoded, 'access'), false);
});
