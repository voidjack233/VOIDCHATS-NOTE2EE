import { getCdnOrigin } from '../config/publicDomain.js';

const CDN_BASE = getCdnOrigin();

export function resolveUserAvatarUrl(
  avatarFilename: string | null | undefined,
): string | null;
export function resolveUserAvatarUrl(
  avatarFilename: string | null | undefined,
  fallbackContext: {
    displayName?: unknown;
    username?: unknown;
  },
): string | null;
export function resolveUserAvatarUrl(
  avatarFilename: string | null | undefined,
): string | null {
  return avatarFilename
    ? `${CDN_BASE}/avatars/${avatarFilename}`
    : null;
}
