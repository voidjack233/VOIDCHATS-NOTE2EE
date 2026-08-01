const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

/**
 * Native clients cannot use the web app's relative Vite proxy URL. Set this to
 * a LAN-reachable NOTE2EE API origin while developing on a physical device.
 * Production is the safe default when a release build does not inject env.
 */
export const API_URL = trimTrailingSlash(
  process.env.EXPO_PUBLIC_API_URL || 'https://api.void0000.online',
);

export const GATEWAY_URL = (() => {
  const explicit = process.env.EXPO_PUBLIC_GATEWAY_URL;
  if (explicit) return explicit;

  try {
    const parsed = new URL(API_URL);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '/gateway';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'wss://api.void0000.online/gateway';
  }
})();

// React Native's Android WebSocket implementation derives Origin from the
// gateway host. The deployed gateway intentionally accepts the public app
// origin instead, so native supplies the same allow-listed Origin as web.
export const GATEWAY_ORIGIN = trimTrailingSlash(
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN || 'https://void0000.online',
);

export const APP_SCHEME = 'void0000';
export const MESSAGE_PAGE_SIZE = 40;
export const MAX_ATTACHMENTS = 5;
