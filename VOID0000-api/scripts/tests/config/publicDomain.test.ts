import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAllowedOrigins,
  getCdnOrigin,
  getCookieDomain,
  getEmailFrom,
  getFrontendOrigin,
  getPublicDomain,
  getPublicOrigin,
  getVmdPublicOrigin,
} from '../../../server/config/publicDomain.js';

test('public domain config derives every standard production origin', () => {
  const env = { NODE_ENV: 'production', PUBLIC_DOMAIN: 'Chat.Next-Year.Example' };

  assert.equal(getPublicDomain(env), 'chat.next-year.example');
  assert.equal(getPublicOrigin('api', env), 'https://api.chat.next-year.example');
  assert.equal(getFrontendOrigin(env), 'https://chat.next-year.example');
  assert.equal(getCdnOrigin(env), 'https://cdn.chat.next-year.example');
  assert.equal(getVmdPublicOrigin(env), 'https://vmd.chat.next-year.example');
  assert.equal(getCookieDomain(env), '.chat.next-year.example');
  assert.equal(getEmailFrom(env), '"Void App" <no-reply@chat.next-year.example>');
  assert.deepEqual(getAllowedOrigins(env), [
    'https://chat.next-year.example',
    'http://localhost:5173',
    'http://localhost',
  ]);
});

test('explicit public origin overrides are retained for custom deployments', () => {
  const env = {
    NODE_ENV: 'production',
    PUBLIC_DOMAIN: 'chat.example',
    FRONT_URL: 'https://app.custom.example',
    CDN_URL: 'https://media.custom.example',
    VMD_PUBLIC_URL: 'https://video.custom.example',
    COOKIE_DOMAIN: '.custom.example',
    EMAIL_FROM: 'VOID <mail@custom.example>',
  };

  assert.equal(getFrontendOrigin(env), 'https://app.custom.example');
  assert.equal(getCdnOrigin(env), 'https://media.custom.example');
  assert.equal(getVmdPublicOrigin(env), 'https://video.custom.example');
  assert.equal(getCookieDomain(env), '.custom.example');
  assert.equal(getEmailFrom(env), 'VOID <mail@custom.example>');
});

test('public domain refuses URLs and ports instead of creating unsafe origins', () => {
  assert.throws(
    () => getPublicDomain({ PUBLIC_DOMAIN: 'https://not-a-domain.example/path' }),
    /PUBLIC_DOMAIN/,
  );
  assert.throws(
    () => getPublicDomain({ PUBLIC_DOMAIN: 'chat.example:443' }),
    /PUBLIC_DOMAIN/,
  );
});

test('production requires an explicit public domain while development uses localhost', () => {
  assert.throws(() => getPublicDomain({ NODE_ENV: 'production' }), /PUBLIC_DOMAIN is required/);
  assert.throws(() => getPublicDomain({ NODE_ENV: 'production', PUBLIC_DOMAIN: '  ' }), /PUBLIC_DOMAIN is required/);
  assert.equal(getPublicDomain({ NODE_ENV: 'development' }), 'localhost');
  assert.equal(getFrontendOrigin({ NODE_ENV: 'development' }), 'http://localhost:5173');
});
