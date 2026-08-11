# Chat Attachment Sanitization

Chat image sanitization runs inside the existing `voidapp-worker-service`, not
inside `voidapp-message-service`.

## Data Flow

```text
browser raw binary upload
  -> message-server reads one bounded in-memory Buffer
  -> permission-restricted Unix socket
  -> worker-server bounded attachment queue
  -> shared Sharp work gate
  -> metadata-safe re-encoded image returned over the socket
  -> message-server hashes the final trusted bytes
  -> message-server creates or reuses one physical MinIO blob
  -> message-server stages a new logical attachment in PostgreSQL
```

Ordinary non-image attachments are identified by the worker and continue
through the existing storage path unchanged. Claimed or recognized images fail
closed if validation or sanitization fails.

Raw chat image bytes exist temporarily only in the message request buffer, Unix
socket/kernel buffers, and the worker process input buffer. They are never
written to disk, MinIO, BullMQ, or Valkey. Only the worker's final trusted bytes
can enter attachment blob storage.

## Storage Deduplication

`attachment_objects` remains the authorization and staged/reserved/committed
lifecycle record. It points to `attachment_blobs`, which owns the physical
content-addressed MinIO object. SHA-256 is computed only from final trusted
bytes after sanitization, so identical uploads reuse one physical blob while
retaining independent attachment IDs, owners, conversations, filenames and
message lifecycle state.

Deleting or expiring a staged attachment removes only its logical reference.
The worker later garbage-collects zero-reference blobs after a 24-hour grace,
under the existing distributed cleanup lock, and verifies the real reference
set before deleting MinIO data. Historical rows are migrated one-to-one with no
invented content hash and therefore are not falsely deduplicated.

The same cleanup run also reconciles physical objects left behind when MinIO
succeeded but the PostgreSQL transaction did not commit. It scans only
`blobs/v1/sha256/`, processes at most 25 objects per run by default, and carries
a private Valkey cursor across runs. An object must be older than the same
24-hour grace before it is eligible. Under the same PostgreSQL advisory lock as
uploads, cleanup rechecks the object and retains it if any `attachment_blobs`
row matches its bucket/key or SHA-256. Malformed paths, recent objects,
same-hash inconsistencies, and uncertain failures are retained and counted;
legacy paths outside the content-addressed prefix are never scanned.

## Inline Delivery Trust

Stored images are eligible for inline protected, signed-CDN, and VMD delivery
only when MinIO metadata contains the exact sanitizer marker
`x-amz-meta-void-sanitized-image: 1` and an approved raster MIME type. Content
type, filename, extension, object key, and message metadata are not sanitizer
proof by themselves.

Historical image objects without that trusted marker fail closed as
`application/octet-stream` attachments. They download instead of rendering
inline; this pass intentionally does not backfill or migrate them.

## Local IPC

The sanitizer uses a versioned, length-prefixed binary protocol over a Unix
domain socket. The worker creates the socket with mode `0600`. The client sends
only a small control frame first; the worker accepts or rejects capacity before
the client sends raw bytes.

Limits:

- control frame: 4 KiB
- one input or output payload: 10 MiB
- input transfer timeout: 15 seconds by default
- complete client operation timeout: 90 seconds by default

The socket is local-only and must not be exposed through Nginx or any public
listener. `ATTACHMENT_SANITIZER_SOCKET_PATH` must be the same absolute path in
the message and worker processes. When it is unset, VOID creates the socket in
a per-user `0700` directory below the OS temporary directory. A configured
socket path is accepted only when its parent directory is owned by the worker
user and has no group/other permission bits.

## Concurrency

Attachment sanitization defaults to one active request and three queued
requests, with at most 30 MiB of reserved input across active and queued work.
Capacity is reserved before upload bytes cross the process boundary.

Avatar BullMQ jobs retain their existing Valkey/base64 payload and storage
behavior. Avatar Sharp work and attachment Sharp work share one aggregate gate,
which defaults to one active Sharp operation. BullMQ may hold multiple active
avatar jobs, but only the bounded gate may enter Sharp/libvips.

Configuration:

- `ATTACHMENT_SANITIZER_CONCURRENCY`
- `ATTACHMENT_SANITIZER_QUEUE_DEPTH`
- `ATTACHMENT_SANITIZER_MAX_PENDING_BYTES`
- `ATTACHMENT_SANITIZER_INPUT_TIMEOUT_MS`
- `ATTACHMENT_SANITIZER_TIMEOUT_MS`
- `SHARP_MAX_CONCURRENT_WORK`

Keep both concurrency values at `1` until production RSS measurements justify
raising them. VMD remains a separate request-time delivery and transformation
service and is not part of this upload sanitizer.

## Failure Behavior

If the worker is unavailable, overloaded, disconnects, times out, or rejects an
image, the upload fails with a controlled response. The API never falls back to
storing the raw image. Restarting `voidapp-worker-service` removes a stale
same-user socket and clean shutdown removes the active socket path.
