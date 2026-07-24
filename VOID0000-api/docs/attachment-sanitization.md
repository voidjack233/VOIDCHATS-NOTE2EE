# Chat Attachment Sanitization

Chat image sanitization runs inside the existing `voidapp-worker-service`, not
inside `voidapp-message-service`.

## Data Flow

```text
browser JSON/base64 upload
  -> message-server decodes one in-memory Buffer
  -> permission-restricted Unix socket
  -> worker-server bounded attachment queue
  -> shared Sharp work gate
  -> metadata-safe re-encoded image returned over the socket
  -> message-server writes only the sanitized bytes to MinIO
  -> message-server commits attachment ownership in PostgreSQL
```

Ordinary non-image attachments are identified by the worker and continue
through the existing storage path unchanged. Claimed or recognized images fail
closed if validation or sanitization fails.

Raw chat image bytes exist temporarily only in the message request buffer, Unix
socket/kernel buffers, and the worker process input buffer. They are never
written to disk, MinIO, BullMQ, or Valkey. The message API still prepares every
file before writing any object, and it removes successful MinIO writes if a
later object or database operation fails.

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
