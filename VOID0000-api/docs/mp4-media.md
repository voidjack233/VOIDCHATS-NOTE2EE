# MP4 Media Processing

## Contract

One video creates one ingest UUID, private quarantine object and, after
normalization, one ordinary staged attachment. Up to five mixed images, videos
and files remain supported. No native-client changes are included.

    browser File -> authenticated message-service -> private quarantine
                              |
                         PostgreSQL ingest
                              |
                       Valkey Stream (IDs only)
                              |
                  Go media worker, one job at a time
                              |
                  ffprobe -> FFmpeg -> verification
                              |
               private normalized MP4 + WebP poster blobs
                              |
                   atomic ready + staged attachment
                              |
                 existing reserved -> committed lifecycle

PostgreSQL is authoritative. Valkey contains only ingest_id and internal
conversation_id, never media, credentials or ffprobe output. Video does not
use BullMQ, Sharp, the image sanitizer socket or VMD transformations.

Known-length requests stream directly to a presigned MinIO PUT with 64 KiB
backpressure. The installed Node MinIO SDK buffers small putObject(Readable)
calls, so that path is not used. Real MinIO rejects unsigned chunked PUT with
HTTP 411: unknown-length uploads instead spool to a private, bounded temporary
file, then stream a known-length PUT. At most two unknown-length spools run
per process; each is limited to 10 MiB and 60 seconds. This is disk spooling,
not full-file RAM buffering. Known-length PUTs also have a 60-second deadline
and exact byte-count checking. No browser writes directly into storage.

## Limits And Trust

- Source: 1 through 10 * 1024 * 1024 bytes, checked before and during upload.
- Final playable MP4: independently 1 through 10 MiB; oversized output fails.
- Poster: at most 1 MiB, WebP, bounded to 640x360.
- Exactly one video and zero or one audio stream. Extra streams, attached
  pictures, malformed containers/metadata and unusable timestamps are rejected.
- Canonical output: H.264/yuv420p, AAC stereo/48 kHz when audio exists,
  faststart, stripped source metadata, at most 1920x1080 and 60 fps.
- There is **no playback-duration cap**. A tested 20-minute low-bitrate video
  passes. Probe/encoding wall-clock limits are independent resource limits.
- Each FFmpeg/probe process has fixed threads, bounded output capture, 1 GiB
  address-space and output-file limits enforced with Linux prlimit. Commands
  use explicit argv, process-group cancellation, private workspaces, no inherited
  credentials, restricted protocols/demuxers and disabled external MOV data
  references. No shell or URL input is accepted.

Only verified normalized output gets exact `void-sanitized-video: 1` metadata
and video/mp4. Image metadata cannot authorize video. Posters receive the
existing exact sanitized-image marker after generation and validation. Delivery
independently checks stored metadata; client MIME, extension and dimensions
never grant inline trust. Quarantine is distinct/private, without a delivery
route or public policy.

## HTTP And Web

Routes under `/api/conversations/:conversationId/attachments/video-ingests`:

| Operation | Contract |
| --- | --- |
| POST / | Raw File, Content-Type application/octet-stream, optional stable UUID X-Media-Ingest-Id, URI-encoded bounded/untrusted X-Attachment-Filename. Returns 202 with ingest ID and state. |
| GET /:ingestId | Owner/current member only. State/error or ready descriptor. Removed ready attachment returns 410. |
| DELETE /:ingestId | Same ownership/CSRF checks. Cancels active work or deletes a finalized attachment only when still staged, never committed. |

Upload preserves cookie sessions, CSRF, identity resolution, membership, DM
interaction policy, group/channel attachment permissions, attachment rate limits
and staged quotas. Each active ingest reserves 10 MiB against the same uploader
quota lock used by images/files; completion replaces it with actual staged bytes.

Composer slots independently show uploading, waiting, processing, ready or
failed. Removing a slot/entering edit mode cancels best-effort; closing the
composer marks unfinished uploads removed. Account-bound work cannot adopt
another account's credentials. Send waits for every selected attachment:
failures are never silently omitted. Re-select a failed file to retry. Bounded
polling concerns only that ingest, not message history or delivery URLs.

Final descriptors retain stable attachment URLs plus MIME, bytes, dimensions
and duration. Message responses add signed original/poster URLs and server-only
video_trusted: true. Signed capabilities/trust flags are stripped before sending
descriptors. Rendering uses native video controls, playsInline, no autoplay and
preload="none". Dimensions are reserved before media load and retained during
spoiler/failure states. The signed original is first; the authenticated attachment
URL is the direct native-media fallback. No render Fetch/XHR or blob conversion.
Each failed URL is tried once; a changed URL can retry without remounting.

The authorized API fallback streams MinIO bytes with 200 or single
closed/open/suffix byte ranges (206); invalid ranges return 416. Posters have
an authorized /:attachmentId/poster route. Split-origin CSP media-src must allow
both CDN and API fallback origins; the nginx example includes them. Preserve
Range through proxies and disable request buffering for quarantine POSTs.

## Recovery And Cleanup

    uploading -> queued -> probing -> processing -> finalizing -> ready
                             | retryable infrastructure failure -> queued
                             | permanent error / 3 attempts -> failed
    active ingest -------------------------------------------> cancelled

- Stream media:video:jobs, group media-workers, unique process consumers.
  Group starts at 0. XREADGROUP/XAUTOCLAIM count is one, stream approximately
  capped at 10,000. Terminal work is ACKed/deleted; duplicate delivery is safe.
- Row-locked claims install random expiring leases. Every mutation/finalization
  checks the exact lease. Old workers cannot finalize after cancellation or
  reclaim. Lease ownership is checked during encoding.
- Every minute, bounded reconciliation republishes at most ten stale jobs with
  FOR UPDATE SKIP LOCKED. Lost/trimmed work is recovered from PostgreSQL.
  XADD failure leaves an accepted source queued; request-side publication
  waiting is capped at two seconds.
- Finalization acquires existing uploader quota and sorted SHA-256 locks.
  MP4/poster reuse verifies blob identity, size, MIME, inline approval and exact
  markers. Logical attachment creation and ready status commit atomically with
  a final lease check. Unknown commit results never authorize source deletion.
- Poster references participate in reference-count triggers and all existing
  GC checks. Shared videos retain their posters. Existing attachment GC owns
  untracked normalized blobs after its grace period; no competing blob GC.
- Upload failure removes raw data only after a confirmed failed transition.
  Ready sources are removed after finalization; cleanup retries failures.
  Small batches expire abandoned uploads/queued jobs and retry terminal cleanup
  after three minutes. A rotating quarantine scan removes old unowned objects
  only after database verification.
- Workspaces are removed per job. Crash leftovers need two lease durations
  plus a database check proving no active lease before deletion. SIGTERM
  cancels queue work/commands. Shutdown and rollback waits are bounded.

Scylla schemas, reservation acknowledgement, message idempotency, authentication,
image sanitizer and realtime fanout are unchanged.

## Deployment

Additive migrations, no historical backfill or trust promotion:

- 0015_media_ingests.sql: ingest state, identities, lease, quota and cleanup.
- 0016_video_attachment_metadata.sql: canonical metadata, poster FK/reference
  trigger/index.

Apply both before updated message, normal worker and media worker services.
The normal worker must also be rebuilt: its existing GC now protects poster
references. Test migrations use disposable databases, not the live database.

Bare metal requires maintained FFmpeg/ffprobe and util-linux (prlimit). From
the API root, after backing up PostgreSQL:

```sh
npm run migrate
npm run build
npm run build:media
pm2 startOrReload ecosystem.config.cjs --only voidapp-message-service,voidapp-worker-service,voidapp-media-worker --update-env
```

Deploy the rebuilt web client normally. PM2 runs bin/voidapp-media-worker,
one instance, loopback readiness on 3007, Go memory target 128 MiB, parent
restart threshold 256 MiB and kill timeout 10 seconds. The parent threshold
is NOT a process-tree memory limit; FFmpeg has prlimit bounds. Use a cgroup
for a total hard bare-metal memory budget.

Dockerfile.media provides a separate non-root image with FFmpeg/ffprobe and
runtime libraries. Compose/voidctl include media-worker, migration/readiness
ordering, one replica, CPU 1, memory 1536 MiB, pids 64, read-only root, 64 MiB
tmpfs, dropped capabilities and data-network-only access. No public worker
port. Processor tests also run inside this image without network access.

Existing PG/Valkey/MinIO settings are reused. Optional settings belong here,
not in .env.example:

| Setting | Default |
| --- | --- |
| MEDIA_WORKER_HOST / MEDIA_WORKER_PORT | 127.0.0.1 / 3007 |
| MINIO_MEDIA_QUARANTINE_BUCKET | media-quarantine, distinct/private |
| MEDIA_TEMP_ROOT | OS temp / void-media-<uid> |
| MEDIA_FFPROBE_PATH / MEDIA_FFMPEG_PATH | /usr/bin/ffprobe / /usr/bin/ffmpeg |
| MEDIA_FFPROBE_TIMEOUT_SECONDS | 15, permitted 1-60 |
| MEDIA_FFMPEG_TIMEOUT_SECONDS | 180, permitted 1-600 |

Existing ATTACHMENT_STAGED_TTL_SECONDS is respected. Invalid explicit numerical
settings fail startup. Source/final sizes and local concurrency are fixed.
/health reports liveness. /ready checks migrations, Valkey, private storage
and executables without exposing secrets. Bounded structured logs report
ingest/stage, timing, attempts, bytes and dimensions, not raw media/signatures.

## Repeatable Verification

Prerequisites: Node 22+, Go, PostgreSQL 16 binaries, Valkey, MinIO,
FFmpeg/ffprobe/prlimit, and web Playwright Chromium. From the API root:

```sh
npm run typecheck
npm run lint
npm run build
npm run build:media
node scripts/tests/run-isolated.mjs
go test ./...
go test -race -count=3 ./media/... ./scripts/tests/media-go
go vet ./media/... ./scripts/tests/media-go
```

The isolated runner refuses occupied fixture ports 15439/16389, creates fresh
PG/Valkey/MinIO and runs backend/security/profile tests. Media fixtures apply
all SQL migrations through 0016. Tests exercise raw HTTP -> queue -> Go ->
normalized trusted delivery, retry/lease fencing, dedup/poster ownership, Range,
and Chromium playback/seeking. Missing prerequisites fail or explicitly skip;
tests never fall back to live storage.

From the web root:

```sh
npm run lint
npm run build
node --test --test-concurrency=1 scripts/tests/attachments/video.test.mjs
```

Keep physical Android/iOS Safari playback, background/resume, real multi-video
network uploads and production smoke tests on the release checklist. Isolated
integration tests are not a production rollout or penetration test.

### Implementation Validation

Validated locally on 2026-09-16: 264 backend tests, 161 frontend unit tests
and 17 browser tests passed, with no skips. Media Go tests passed three runs
under the race detector; all API Go packages, Go vet and voidctl tests passed.
API/web typechecking and production builds, the media executable, and API/web/
media container builds passed. The media container also passed real FFmpeg
normalization tests with its non-root, no-network and resource restrictions.

Backend lint and targeted video lint passed. Full frontend lint still reports
68 errors and 18 warnings; linting the corresponding HEAD sources confirmed
these are pre-existing. No lint rules were weakened for this feature.

Bare-metal rollout on 2026-09-16: backed up PostgreSQL, applied 0015/0016
(zero pending migrations), rebuilt the API/media worker, reloaded the message
and normal worker services, and started the Go media worker through PM2.
Message/media readiness checks returned 200. Public message preflight returned
204 with the allowed origin; unauthenticated history access still returned 401.
PM2 definitions were saved. These checks do not replace authenticated browser
or physical-device playback verification. The separate Docker stack was not
rolled out as part of this bare-metal deployment.
