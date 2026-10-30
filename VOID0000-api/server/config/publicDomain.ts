function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw new Error('PUBLIC_DOMAIN must be a hostname without a scheme, path, or port');
  }
  return domain;
}

export function getPublicDomain(env: NodeJS.ProcessEnv = process.env): string {
  const domain = env.PUBLIC_DOMAIN?.trim();
  if (!domain && env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_DOMAIN is required in production');
  }
  return normalizeDomain(domain || 'localhost');
}

export function getPublicOrigin(subdomain = '', env: NodeJS.ProcessEnv = process.env): string {
  const host = subdomain ? `${subdomain}.${getPublicDomain(env)}` : getPublicDomain(env);
  return `https://${host}`;
}

export function getFrontendOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRONT_URL?.trim() || (
    env.NODE_ENV === 'production' ? getPublicOrigin('', env) : 'http://localhost:5173'
  );
}

export function getCdnOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CDN_URL?.trim() || getPublicOrigin('cdn', env);
}

export function getVmdPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMD_PUBLIC_URL?.trim() || (
    env.NODE_ENV === 'production'
      ? getPublicOrigin('vmd', env)
      : `http://localhost:${env.VMD_SERVICE_PORT || '3006'}`
  );
}

export function getCookieDomain(env: NodeJS.ProcessEnv = process.env): string {
  return env.COOKIE_DOMAIN?.trim() || `.${getPublicDomain(env)}`;
}

export function getAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([
    getFrontendOrigin(env),
    getPublicOrigin('', env),
    'http://localhost:5173',
    'http://localhost',
  ])];
}

export function getEmailFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.EMAIL_FROM?.trim() || `"Void App" <no-reply@${getPublicDomain(env)}>`;
}
