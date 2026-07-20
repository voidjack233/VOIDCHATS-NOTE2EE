# VOID Media Delivery (VMD)

VMD serves bounded display variants for private chat images. Original attachment
downloads continue to use signed `cdn.void0000.online` URLs.

## Request Flow

1. An authenticated message request verifies conversation membership.
2. Image attachment metadata receives both the original `url` and a temporary
   `display_url` capability.
3. The browser puts `display_url` directly in the image `src` attribute.
4. VMD validates the capability, resolves the attachment UUID through
   `attachment_objects`, checks its private persistent variant cache, and
   returns WebP. Only a cache miss reads and transforms the private original.

VMD does not accept external URLs or client-provided object keys.

## Variants

| Variant | Maximum bound |
| --- | ---: |
| `thumb` | 160 px |
| `small` | 480 px |
| `medium` | 960 px |
| `large` | 1600 px |

All variants preserve aspect ratio and use `withoutEnlargement`, so small source
images are never upscaled. V1 issues `medium` URLs for normal message rendering.

## Production Routing

Run `voidapp-vmd-service` on loopback port `3006`. Route
`vmd.void0000.online` to `http://127.0.0.1:3006`. The service intentionally
exposes only:

- `GET /health`
- `GET /ready`
- `GET /v1/images/:attachmentId/:variant?exp=...&sig=...`

The frontend Content Security Policy must include
`https://vmd.void0000.online` in `img-src`. No VMD origin is needed in
`connect-src` because persisted image rendering is a native browser image
request, not Fetch/XHR.

## Caching And Privacy

Successful responses allow browser and shared-edge caching only for the signed
capability's remaining lifetime. The URL signature binds the attachment UUID,
fixed variant, and expiration. The signature key is domain-separated from
`ACCESS_SECRET`, or can be isolated with an optional `VMD_SIGNING_SECRET`
override.

VMD sends `public`, matching `max-age`/`s-maxage`, `must-revalidate`,
`no-transform`, and `immutable` directives. `CDN-Cache-Control` and
`Cloudflare-CDN-Cache-Control` carry the same bounded shared-cache lifetime.
The lifetime is calculated after rendering and can never extend beyond `exp`.
Errors and invalid capabilities send `no-store` for every cache-control layer.

Cloudflare must use the complete URL as the cache key. Configure one Cache Rule:

- match hostname `vmd.void0000.online` and path beginning `/v1/images/`
- mark the response eligible for cache
- use the default cache key with all query parameters included
- set Edge TTL to **Use cache-control header if present, bypass cache if not**
- set Browser TTL to **Respect origin**
- do not use an Edge Cache TTL override, Cache Everything override with a fixed
  TTL, stale serving beyond origin directives, or query-string normalization

Never ignore or remove `exp` or `sig` from the cache key. The edge may serve a
cached response without contacting VMD, so the exact signed capability must be
the identity that originally populated that entry.

Generated variants persist in the private `vmd-variants` MinIO bucket. The
object key is:

```text
variants/v1/<attachment UUID>/<source fingerprint>/<variant>.webp
```

The source fingerprint is SHA-256 over the trusted original object key, MinIO
ETag, version ID, size, and last-modified value. Changing any source identity or
the VMD cache version creates a new entry. Cached bytes carry a SHA-256 checksum
and are regenerated if metadata or bytes do not match. MinIO object writes are
atomic; if a cache write fails, VMD still serves the generated response.

The dedicated cache bucket stays private and has a 30-day lifecycle on the
`variants/` prefix. This bounds orphaned attachment variants and old cache
versions without recursive cleanup in request paths. An expired active variant
is regenerated lazily on its next request.

Different images use a bounded FIFO work queue: two MinIO-read/Sharp pipelines
run concurrently and up to eight wait briefly before VMD returns `503`. Sentinel
still coalesces simultaneous requests for the same attachment and variant.

VMD exposes low-noise persistent-cache, transform, and queue counters in its
`/health` response. Cache failure warnings are rate-limited.

## Supported Inputs And Limits

VMD supports static JPEG, PNG, WebP, AVIF, GIF, and TIFF. Sharp reports AVIF as
HEIF with AV1 compression; HEIC/HEIF using HEVC remains unsupported because the
installed runtime does not advertise reliable HEIC file decoding.

Animated GIF and animated WebP are preserved as animated WebP, including frame
delays and loop count. Animation is limited to 60 frames, 12 million decoded
pixels per frame, and 30 million decoded pixels total. Static images are limited
to 25 million decoded pixels. The original source remains capped at 12 MiB and a
persisted generated variant at 16 MiB.

SVG is rejected before Sharp parsing and is never returned raw by VMD. Animated
PNG, multi-page TIFF, and other unsupported multi-page inputs are rejected
rather than silently flattened to their first frame. Audio, video, PDF, ZIP,
and other attachments continue to use original CDN delivery.
