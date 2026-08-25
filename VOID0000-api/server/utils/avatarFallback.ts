const CDN_BASE = process.env.CDN_URL || 'https://cdn.void0000.online';

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
