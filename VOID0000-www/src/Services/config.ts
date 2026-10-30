// In dev, use empty string so all calls are relative (go through Vite proxy → localhost:3001)
// In production, use the configured API URL
const viteEnv = import.meta.env;
const publicDomain = viteEnv?.VITE_PUBLIC_DOMAIN?.trim();
const sameOrigin = viteEnv?.VITE_SAME_ORIGIN === 'true';

export const API_URL = viteEnv?.DEV
  ? ''
  : viteEnv?.VITE_API_URL || (!sameOrigin && publicDomain ? `https://api.${publicDomain}` : '');

export const CDN_URL = viteEnv?.DEV
  ? ''
  : viteEnv?.VITE_CDN_URL || (!sameOrigin && publicDomain ? `https://cdn.${publicDomain}` : '');

export const SOCKET_URL = viteEnv?.DEV
  ? ''
  : viteEnv?.VITE_GATEWAY_URL || API_URL;
