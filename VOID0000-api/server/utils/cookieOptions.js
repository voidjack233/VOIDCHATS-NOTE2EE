const PRODUCTION_COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '.void0000.online';

function stripPort(host = '') {
  const value = String(host).trim().toLowerCase();
  if (!value) return '';

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }

  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount > 1) {
    return value;
  }

  return value.split(':')[0];
}

function isLocalHost(host = '') {
  const hostname = stripPort(host);
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  );
}

function isLocalOrigin(origin = '') {
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLocalCookieRequest(req) {
  if (!req) return false;

  return (
    isLocalHost(req.hostname) ||
    isLocalHost(req.get?.('host')) ||
    isLocalHost(req.get?.('x-forwarded-host')) ||
    isLocalOrigin(req.get?.('origin')) ||
    isLocalOrigin(req.get?.('referer'))
  );
}

export const getCookieOptions = (maxAge = null, req = null) => {
  const useProductionCookieScope =
    process.env.NODE_ENV === 'production' && !isLocalCookieRequest(req);

  const options = {
    httpOnly: true,
    secure: useProductionCookieScope,
    sameSite: 'Lax',
    path: '/',
  };

  if (useProductionCookieScope) {
    options.domain = PRODUCTION_COOKIE_DOMAIN;
  }

  if (maxAge) {
    options.maxAge = maxAge;
  }

  return options;
};
