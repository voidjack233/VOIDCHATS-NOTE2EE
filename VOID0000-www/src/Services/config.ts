// In dev, use empty string so all calls are relative (go through Vite proxy → localhost:3001)
// In production, use the configured API URL
const viteEnv = import.meta.env;

export const API_URL = viteEnv?.DEV
  ? ''
  : viteEnv?.VITE_API_URL;

export const CDN_URL = viteEnv?.DEV
  ? ''
  : viteEnv?.CDN_URL;

export const SOCKET_URL = viteEnv?.DEV
  ? ''
  : viteEnv?.VITE_GATEWAY_URL || viteEnv?.VITE_API_URL;
