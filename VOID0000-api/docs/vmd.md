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

Successful responses use private browser caching until the signed capability
expires. `CDN-Cache-Control: private, no-store` still keeps this stage out of
shared edge caches. The URL signature binds the attachment UUID, fixed variant,
and expiration. The signature key is domain-separated from `ACCESS_SECRET`, or
can be isolated with an optional `VMD_SIGNING_SECRET` override.

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
`/health` response. Cache failure warnings are rate-limited. Shared edge caching
remains disabled at this stage.

V1 supports static JPEG, PNG, WebP, and AVIF inputs. Other attachment types keep
the existing original CDN delivery path.
