import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

import {
  createVmdImageDelivery,
  createVmdResponsiveImageDelivery,
  getVmdSigningKey,
  verifyVmdImageCapability,
  VMD_CAPABILITY_EXPIRY_BUCKET_SECONDS,
  VMD_IMAGE_VARIANTS,
  VMD_RESPONSIVE_IMAGE_VARIANTS,
} from '../../../server/vmd/capability.js';

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const SIGNING_KEY = Buffer.alloc(32, 7);
const PUBLIC_ORIGIN = 'https://vmd.invalid';
const TTL_SECONDS = 60 * 60;
const BUCKET_START = Date.parse('2026-07-27T12:00:00.000Z');

function createOptions(now) {
  return {
    now,
    publicOrigin: PUBLIC_ORIGIN,
    signingKey: SIGNING_KEY,
    ttlSeconds: TTL_SECONDS,
    expiryBucketSeconds: VMD_CAPABILITY_EXPIRY_BUCKET_SECONDS,
  };
}

test('same attachment and variant reuse one capability URL within an expiry bucket', () => {
  const first = createVmdImageDelivery(
    ATTACHMENT_ID,
    'medium',
    createOptions(BUCKET_START + 1_000),
  );
  const second = createVmdImageDelivery(
    ATTACHMENT_ID,
    'medium',
    createOptions(BUCKET_START + (4 * 60 + 59) * 1_000),
  );
  const nextBucket = createVmdImageDelivery(
    ATTACHMENT_ID,
    'medium',
    createOptions(BUCKET_START + 5 * 60 * 1_000),
  );

  assert.equal(second.display_url, first.display_url);
  assert.equal(second.display_url_expires_at, first.display_url_expires_at);
  assert.notEqual(nextBucket.display_url, first.display_url);
});

test('responsive delivery derives once and is byte-identical to independent variant signing', t => {
  const previous = process.env.VMD_SIGNING_SECRET;
  process.env.VMD_SIGNING_SECRET = 'a'.repeat(64);
  t.after(() => { if (previous === undefined) delete process.env.VMD_SIGNING_SECRET; else process.env.VMD_SIGNING_SECRET = previous; });
  const original = crypto.createHmac;
  let derivations = 0, signatures = 0;
  crypto.createHmac = (...args) => {
    const hmac = original(...args), update = hmac.update;
    hmac.update = function (value, ...rest) {
      if (value === 'void:vmd:capability-signing-key:v1') derivations++;
      if (typeof value === 'string' && value.startsWith('void-vmd-v1\n')) signatures++;
      return update.call(this, value, ...rest);
    };
    return hmac;
  };
  syncBuiltinESMExports();
  t.after(() => { crypto.createHmac = original; syncBuiltinESMExports(); });
  const options = { ...createOptions(BUCKET_START + 1000), signingKey: undefined };
  const delivery = createVmdResponsiveImageDelivery(ATTACHMENT_ID, options);
  assert.equal(derivations, 1); assert.equal(signatures, 3);
  for (const variant of VMD_RESPONSIVE_IMAGE_VARIANTS) {
    const single = createVmdImageDelivery(ATTACHMENT_ID, variant, options);
    assert.equal(delivery.display_variants[variant].url, single.display_url);
    assert.equal(delivery.display_variants[variant].expires_at, single.display_url_expires_at);
  }
  const before = derivations;
  createVmdResponsiveImageDelivery(ATTACHMENT_ID, createOptions(BUCKET_START));
  assert.equal(derivations, before, 'explicit caller keys do not invoke configured derivation');
});

test('key reuse observes secret rotation, fallback and invalid configuration without retaining mutable keys', t => {
  const oldVmd = process.env.VMD_SIGNING_SECRET, oldAccess = process.env.ACCESS_SECRET;
  t.after(() => {
    if (oldVmd === undefined) delete process.env.VMD_SIGNING_SECRET; else process.env.VMD_SIGNING_SECRET = oldVmd;
    if (oldAccess === undefined) delete process.env.ACCESS_SECRET; else process.env.ACCESS_SECRET = oldAccess;
  });
  const options = { ...createOptions(BUCKET_START + 1000), signingKey: undefined };
  process.env.VMD_SIGNING_SECRET = 'a'.repeat(64);
  const first = createVmdResponsiveImageDelivery(ATTACHMENT_ID, options);
  const firstKey = getVmdSigningKey(); firstKey.fill(0);
  assert.deepEqual(createVmdResponsiveImageDelivery(ATTACHMENT_ID, options), first);
  process.env.VMD_SIGNING_SECRET = 'b'.repeat(64);
  const rotated = createVmdResponsiveImageDelivery(ATTACHMENT_ID, options);
  assert.notEqual(first.display_url, rotated.display_url);
  const firstUrl = new URL(first.display_url);
  assert.equal(verifyVmdImageCapability({ attachmentId: ATTACHMENT_ID, variant: 'medium', now: options.now,
    expiresAt: firstUrl.searchParams.get('exp'), signature: firstUrl.searchParams.get('sig') }).ok, false);
  delete process.env.VMD_SIGNING_SECRET; process.env.ACCESS_SECRET = 'b'.repeat(64);
  assert.deepEqual(createVmdResponsiveImageDelivery(ATTACHMENT_ID, options), rotated);
  process.env.VMD_SIGNING_SECRET = 'invalid';
  assert.throws(() => createVmdResponsiveImageDelivery(ATTACHMENT_ID, options), /at least 32 characters/);
  delete process.env.VMD_SIGNING_SECRET; delete process.env.ACCESS_SECRET;
  assert.throws(() => createVmdResponsiveImageDelivery(ATTACHMENT_ID, options), /at least 32 characters/);
  assert.doesNotThrow(() => createVmdResponsiveImageDelivery(ATTACHMENT_ID, createOptions(BUCKET_START)));
});

test('bucketed expiration never exceeds TTL and retains a safe lifetime floor', () => {
  const now = BUCKET_START + (4 * 60 + 59) * 1_000;
  const delivery = createVmdImageDelivery(
    ATTACHMENT_ID,
    'small',
    createOptions(now),
  );
  const remainingSeconds = (delivery.display_url_expires_at - now) / 1_000;

  assert.ok(remainingSeconds <= TTL_SECONDS);
  assert.ok(
    remainingSeconds >= TTL_SECONDS - VMD_CAPABILITY_EXPIRY_BUCKET_SECONDS,
  );
});

test('responsive delivery signs fixed variants with one bucketed expiration', () => {
  const delivery = createVmdResponsiveImageDelivery(
    ATTACHMENT_ID,
    createOptions(BUCKET_START + 30_000),
  );
  const variants = delivery.display_variants;

  assert.deepEqual(Object.keys(variants), VMD_RESPONSIVE_IMAGE_VARIANTS);
  assert.equal(variants.thumb, undefined);
  assert.equal(delivery.display_url, variants.medium.url);
  assert.equal(delivery.display_url_expires_at, variants.medium.expires_at);

  const expirations = new Set();
  const urls = new Set();
  for (const variant of VMD_RESPONSIVE_IMAGE_VARIANTS) {
    const descriptor = variants[variant];
    const url = new URL(descriptor.url);
    const expiresAt = Number(url.searchParams.get('exp'));
    const signature = url.searchParams.get('sig');
    expirations.add(descriptor.expires_at);
    urls.add(descriptor.url);

    assert.equal(descriptor.width, VMD_IMAGE_VARIANTS[variant].bound);
    assert.equal(descriptor.expires_at, expiresAt * 1_000);
    const verification = verifyVmdImageCapability({
      attachmentId: ATTACHMENT_ID,
      variant,
      expiresAt: String(expiresAt),
      signature,
      now: BUCKET_START + 30_000,
      signingKey: SIGNING_KEY,
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.expiresAt, expiresAt);
  }

  assert.equal(expirations.size, 1);
  assert.equal(urls.size, VMD_RESPONSIVE_IMAGE_VARIANTS.length);
});
