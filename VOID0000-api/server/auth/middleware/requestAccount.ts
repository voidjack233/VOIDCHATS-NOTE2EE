import type { Request } from 'express';

// A queued operation may outlive a cross-tab cookie change. This is an expected
// identity assertion, not authentication; signed tokens still authorize access.
export function matchesRequestAccount(req: Request, userId: string): boolean {
  const expected = req.headers['x-void-account-id'];
  return expected === undefined || (typeof expected === 'string' && expected === userId);
}
export const accountChangedResponse = {
  success: false, code: 'AUTH_ACCOUNT_CHANGED', error: 'Account changed. Operation cancelled.',
};
