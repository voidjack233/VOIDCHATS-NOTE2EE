const DEFAULT_ADMIN_HOST = '127.0.0.1';
const DEFAULT_ADMIN_PORT = 4310;
const MIN_ADMIN_PASSWORD_LENGTH = 16;
const OBVIOUSLY_WEAK_PASSWORDS = new Set([
  'admin',
  'administrator',
  'changeme',
  'letmein',
  'password',
  'password123',
  'qwerty',
  'welcome',
]);

function getRequiredValue(env, name) {
  const value = typeof env[name] === 'string' ? env[name] : '';
  if (!value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getPort(value) {
  const normalized = value == null || String(value).trim() === ''
    ? String(DEFAULT_ADMIN_PORT)
    : String(value).trim();
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('ADMIN_PANEL_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function isLoopbackAdminHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }

  const octets = normalized.split('.');
  return octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function isObviouslyWeakPassword(username, password) {
  const normalized = password.trim().toLowerCase();
  const normalizedUsername = username.trim().toLowerCase();
  return (
    password.length < MIN_ADMIN_PASSWORD_LENGTH ||
    OBVIOUSLY_WEAK_PASSWORDS.has(normalized) ||
    normalized === normalizedUsername ||
    normalized === `${normalizedUsername}123` ||
    /^(admin|administrator|changeme|letmein|password|qwerty|welcome)+\d*$/.test(normalized) ||
    /^\d+$/.test(normalized) ||
    /^(?:0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiopasdfghjklzxcvbnm)+$/.test(normalized) ||
    /^(.{1,8})\1+$/.test(normalized) ||
    new Set(normalized).size < 6 ||
    /^(.)\1+$/.test(normalized)
  );
}

export function resolveAdminConfig(env = process.env) {
  const username = getRequiredValue(env, 'ADMIN_PANEL_USERNAME');
  const password = getRequiredValue(env, 'ADMIN_PANEL_PASSWORD');
  const host = typeof env.ADMIN_PANEL_HOST === 'string' && env.ADMIN_PANEL_HOST.trim()
    ? env.ADMIN_PANEL_HOST.trim()
    : DEFAULT_ADMIN_HOST;
  const isDevelopment = env.NODE_ENV === 'development';
  const allowWeakDevelopmentPassword =
    isDevelopment && env.ADMIN_PANEL_ALLOW_WEAK_PASSWORD === 'true';

  if (
    username.trim().toLowerCase() === 'admin' &&
    password.trim().toLowerCase() === 'admin'
  ) {
    throw new Error('Unsafe default admin credentials are not allowed');
  }

  if (!allowWeakDevelopmentPassword && isObviouslyWeakPassword(username, password)) {
    throw new Error(
      `ADMIN_PANEL_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters and not obviously weak`,
    );
  }

  if (
    env.NODE_ENV === 'production' &&
    !isLoopbackAdminHost(host) &&
    env.ADMIN_PANEL_ALLOW_NON_LOOPBACK !== 'true'
  ) {
    throw new Error(
      'Production VOIDADMIN must use a loopback host unless ADMIN_PANEL_ALLOW_NON_LOOPBACK=true',
    );
  }

  return Object.freeze({
    host,
    port: getPort(env.ADMIN_PANEL_PORT),
    username: username.trim(),
    password,
  });
}
