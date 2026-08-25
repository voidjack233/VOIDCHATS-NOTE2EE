import type { CookieOptions, Request } from 'express';

import { getCookieOptions } from '../../utils/cookieOptions.js';

const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

export const accessCookieOptions = (req: Request | null = null): CookieOptions => (
  getCookieOptions(ACCESS_COOKIE_MAX_AGE, req)
);

export const refreshCookieOptions = (req: Request | null = null): CookieOptions => (
  getCookieOptions(REFRESH_COOKIE_MAX_AGE, req)
);

export const clearCookieOptions = (req: Request | null = null): CookieOptions =>
  getCookieOptions(null, req);

export const deviceCookieOptions = (req: Request | null = null): CookieOptions => ({
  ...getCookieOptions(DEVICE_COOKIE_MAX_AGE, req),
  httpOnly: true,
});
