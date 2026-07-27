import { createHmac, timingSafeEqual } from 'crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_CAPABILITY_TTL_SECONDS = 60 * 60;
const MIN_CAPABILITY_TTL_SECONDS = 5 * 60;
const MAX_CAPABILITY_TTL_SECONDS = 60 * 60;
const SIGNING_KEY_CONTEXT = 'void:vmd:capability-signing-key:v1';
export const VMD_CAPABILITY_EXPIRY_BUCKET_SECONDS = 5 * 60;

export const VMD_IMAGE_VARIANTS = Object.freeze({
  thumb: Object.freeze({ bound: 160, quality: 72 }),
  small: Object.freeze({ bound: 480, quality: 78 }),
  medium: Object.freeze({ bound: 960, quality: 82 }),
  large: Object.freeze({ bound: 1600, quality: 84 }),
});
export const VMD_RESPONSIVE_IMAGE_VARIANTS = Object.freeze([
  'thumb',
  'small',
  'medium',
  'large',
]);

function parseInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function resolveCapabilityTtlSeconds(value = process.env.VMD_SIGNED_URL_TTL_SECONDS) {
  const parsed = parseInteger(value);
  if (parsed === null) {
    return DEFAULT_CAPABILITY_TTL_SECONDS;
  }
  return Math.min(
    MAX_CAPABILITY_TTL_SECONDS,
    Math.max(MIN_CAPABILITY_TTL_SECONDS, parsed),
  );
}

function resolveCapabilityExpiresAt(now, ttlSeconds, bucketSeconds) {
  const nowSeconds = Math.floor(now / 1000);
  const configuredBucket = Number.isSafeInteger(bucketSeconds) && bucketSeconds > 0
    ? bucketSeconds
    : VMD_CAPABILITY_EXPIRY_BUCKET_SECONDS;
  // Keep at least 75% of short configured TTLs while retaining five-minute
  // buckets for the normal one-hour capability.
  const effectiveBucket = Math.max(
    1,
    Math.min(configuredBucket, Math.floor(ttlSeconds / 4)),
  );
  return Math.floor((nowSeconds + ttlSeconds) / effectiveBucket) * effectiveBucket;
}

function resolvePublicOrigin(value = process.env.VMD_PUBLIC_URL) {
  const fallback = process.env.NODE_ENV === 'production'
    ? 'https://vmd.void0000.online'
    : `http://localhost:${process.env.VMD_SERVICE_PORT || 3006}`;
  const origin = new URL(value || fallback);

  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('VMD_PUBLIC_URL must be an HTTP(S) origin without a path');
  }

  return origin.origin;
}

export function getVmdSigningKey() {
  const sourceSecret = process.env.VMD_SIGNING_SECRET || process.env.ACCESS_SECRET;
  if (!sourceSecret || sourceSecret.length < 32) {
    throw new Error('VMD requires VMD_SIGNING_SECRET or ACCESS_SECRET with at least 32 characters');
  }

  // Domain separation prevents capability signatures from sharing the JWT key directly.
  return createHmac('sha256', sourceSecret)
    .update(SIGNING_KEY_CONTEXT)
    .digest();
}

export function isVmdImageVariant(value) {
  return typeof value === 'string' && Object.hasOwn(VMD_IMAGE_VARIANTS, value);
}

function buildCapabilityPayload(attachmentId, variant, expiresAt) {
  return `void-vmd-v1\n${attachmentId.toLowerCase()}\n${variant}\n${expiresAt}`;
}

function signCapability(attachmentId, variant, expiresAt, signingKey) {
  return createHmac('sha256', signingKey)
    .update(buildCapabilityPayload(attachmentId, variant, expiresAt))
    .digest('base64url');
}

export function createVmdImageDelivery(
  attachmentId,
  variant = 'medium',
  {
    now = Date.now(),
    publicOrigin = resolvePublicOrigin(),
    signingKey = getVmdSigningKey(),
    ttlSeconds = resolveCapabilityTtlSeconds(),
    expiryBucketSeconds = VMD_CAPABILITY_EXPIRY_BUCKET_SECONDS,
  } = {},
) {
  if (!UUID_PATTERN.test(attachmentId || '')) {
    throw new TypeError('VMD attachment id must be a UUID');
  }
  if (!isVmdImageVariant(variant)) {
    throw new TypeError(`Unsupported VMD image variant: ${variant}`);
  }

  const expiresAt = resolveCapabilityExpiresAt(
    now,
    ttlSeconds,
    expiryBucketSeconds,
  );
  const signature = signCapability(attachmentId, variant, expiresAt, signingKey);
  const url = new URL(
    `/v1/images/${encodeURIComponent(attachmentId.toLowerCase())}/${variant}`,
    publicOrigin,
  );
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('sig', signature);

  return {
    display_url: url.toString(),
    display_url_expires_at: expiresAt * 1000,
  };
}

export function createVmdResponsiveImageDelivery(
  attachmentId,
  options = {},
) {
  const now = options.now ?? Date.now();
  const deliveries = Object.fromEntries(
    VMD_RESPONSIVE_IMAGE_VARIANTS.map((variant) => [
      variant,
      createVmdImageDelivery(attachmentId, variant, {
        ...options,
        now,
      }),
    ]),
  );
  const medium = deliveries.medium;

  return {
    ...medium,
    display_variants: Object.fromEntries(
      VMD_RESPONSIVE_IMAGE_VARIANTS.map((variant) => [
        variant,
        {
          url: deliveries[variant].display_url,
          expires_at: deliveries[variant].display_url_expires_at,
          width: VMD_IMAGE_VARIANTS[variant].bound,
        },
      ]),
    ),
  };
}

export function verifyVmdImageCapability({
  attachmentId,
  variant,
  expiresAt,
  signature,
  now = Date.now(),
  signingKey = getVmdSigningKey(),
}) {
  if (!UUID_PATTERN.test(attachmentId || '')) {
    return { ok: false, code: 'VMD_ATTACHMENT_ID_INVALID', status: 400 };
  }
  if (!isVmdImageVariant(variant)) {
    return { ok: false, code: 'VMD_VARIANT_UNSUPPORTED', status: 400 };
  }

  const parsedExpiresAt = parseInteger(expiresAt);
  if (parsedExpiresAt === null) {
    return { ok: false, code: 'VMD_EXPIRATION_INVALID', status: 400 };
  }
  if (parsedExpiresAt <= Math.floor(now / 1000)) {
    return { ok: false, code: 'VMD_CAPABILITY_EXPIRED', status: 410 };
  }
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, code: 'VMD_SIGNATURE_INVALID', status: 403 };
  }

  const expected = Buffer.from(
    signCapability(attachmentId, variant, parsedExpiresAt, signingKey),
    'base64url',
  );
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, code: 'VMD_SIGNATURE_INVALID', status: 403 };
  }

  return {
    ok: true,
    expiresAt: parsedExpiresAt,
  };
}
