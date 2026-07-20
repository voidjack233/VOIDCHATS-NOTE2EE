import { createHash } from 'crypto';
import { Router } from 'express';
import { verifyVmdImageCapability } from './capability.js';
import { VmdMediaError } from './imageVariants.js';

const ALLOWED_QUERY_KEYS = new Set(['exp', 'sig']);

function getSingleQueryValue(value) {
  return typeof value === 'string' ? value : null;
}

function setMediaCacheHeaders(res, expiresAt, now, body, providedEtag) {
  const remainingSeconds = Math.max(0, expiresAt - Math.floor(now / 1000));
  const etag = providedEtag || `"${createHash('sha256').update(body).digest('base64url')}"`;
  const sharedDirectives = [
    'public',
    `max-age=${remainingSeconds}`,
    'must-revalidate',
    'no-transform',
  ];
  const browserDirectives = [
    ...sharedDirectives,
    `s-maxage=${remainingSeconds}`,
    'proxy-revalidate',
  ];
  if (remainingSeconds > 0) {
    browserDirectives.push('immutable');
    sharedDirectives.push('immutable');
  }

  res.setHeader('Cache-Control', browserDirectives.join(', '));
  res.setHeader('CDN-Cache-Control', sharedDirectives.join(', '));
  res.setHeader('Cloudflare-CDN-Cache-Control', sharedDirectives.join(', '));
  res.setHeader('ETag', etag);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return etag;
}

function sendError(res, status, code) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  return res.status(status).json({
    success: false,
    code,
  });
}

export function createVmdRouter({
  renderImage,
  signingKey,
  now = Date.now,
}) {
  if (typeof renderImage !== 'function') {
    throw new TypeError('createVmdRouter requires renderImage');
  }

  const router = Router();

  router.get('/v1/images/:attachmentId/:variant', async (req, res) => {
    const queryKeys = Object.keys(req.query);
    if (queryKeys.some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
      return sendError(res, 400, 'VMD_QUERY_INVALID');
    }

    const requestNow = now();
    const verification = verifyVmdImageCapability({
      attachmentId: req.params.attachmentId,
      variant: req.params.variant,
      expiresAt: getSingleQueryValue(req.query.exp),
      signature: getSingleQueryValue(req.query.sig),
      now: requestNow,
      ...(signingKey ? { signingKey } : {}),
    });

    if (!verification.ok) {
      return sendError(res, verification.status, verification.code);
    }

    try {
      const image = await renderImage(req.params.attachmentId, req.params.variant);
      const etag = setMediaCacheHeaders(
        res,
        verification.expiresAt,
        now(),
        image.body,
        image.etag,
      );

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Content-Length', String(image.body.length));
      return res.end(image.body);
    } catch (error) {
      if (error instanceof VmdMediaError) {
        if (error.status === 503) {
          res.setHeader('Retry-After', '1');
        }
        return sendError(res, error.status, error.code);
      }

      console.error('[VMD] image delivery failed', {
        attachment_id: req.params.attachmentId,
        variant: req.params.variant,
        error: error instanceof Error ? error.message : String(error || ''),
      });
      return sendError(res, 500, 'VMD_DELIVERY_FAILED');
    }
  });

  return router;
}
