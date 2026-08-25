import type { AuthenticatedRequestUser } from '../auth/types.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedRequestUser;
      userId?: string;
      userProfileId?: string;
      captchaSkipped?: boolean;
      _revalidateCache?: boolean;
      _cacheUserId?: string;
    }
  }
}

export {};
