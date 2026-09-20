import { createHash } from 'crypto';
import { Router, type Response } from 'express';
import {
  isVmdImageVariant,
  verifyVmdImageCapability,
  type VmdImageVariant,
} from './capability.js';
import { VmdMediaError } from './imageVariants.js';
import type { VmdRenderedImage } from './storage.js';

const ALLOWED_QUERY_KEYS = new Set(['exp', 'sig']);
const BROWSER_STALE_GRACE_SECONDS = 30;

function getSingleQueryValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function setMediaCacheHeaders(
  res: Response,
  expiresAt: number,
  now: number,
  body: Buffer,
  providedEtag?: string,
): string {
  const remainingSeconds = Math.max(0, expiresAt - Math.floor(now / 1000));
  const etag = providedEtag || `"${createHash('sha256').update(body).digest('base64url')}"`;
  const sharedDirectives = [
    'public',
    `max-age=${remainingSeconds}`,
    'must-revalidate',
    'no-transform',
  ];
  const browserDirectives = [
    'private',
    `max-age=${remainingSeconds}`,
    `stale-while-revalidate=${BROWSER_STALE_GRACE_SECONDS}`,
    'no-transform',
  ];
  if (remainingSeconds > 0) {
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

function sendError(res: Response, status: number, code: string) {
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
}: {
  renderImage: (
    attachmentId: string,
    variant: VmdImageVariant,
  ) => Promise<VmdRenderedImage>;
  signingKey?: Buffer;
  now?: () => number;
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
      if (!isVmdImageVariant(req.params.variant)) {
        return sendError(res, 400, 'VMD_VARIANT_UNSUPPORTED');
      }
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
