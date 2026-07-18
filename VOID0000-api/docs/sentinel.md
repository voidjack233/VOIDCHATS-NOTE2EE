# Sentinel Read Coalescing

Sentinel is a process-local, read-only single-flight layer between API routes and storage. When concurrent requests use the same precise flight key, only the first callback reaches storage. The other callers await that same promise. Sentinel retains no completed results, so it is not a cache.

## Current Coverage

- Exact ScyllaDB message-history chunks are coalesced after conversation membership is verified.
- Private attachment metadata lookups and MinIO object metadata reads are coalesced after membership is verified.
- Private attachment bodies at or below `SENTINEL_MAX_BUFFERED_ATTACHMENT_BYTES` are coalesced into one bounded buffer.
- Larger attachment bodies keep the existing per-response streaming path to avoid excessive Node.js heap use.

Writes never pass through Sentinel.

## Usage

```js
import sentinel, { createSentinelKey } from './sentinel/index.js';

const key = createSentinelKey('postgres.example.by-id', accountId, recordId);
const result = await sentinel.guard(key, () => pool.query(query, [accountId, recordId]));
```

Build a key from every value that can change the storage result. Perform authentication and authorization before entering the guard. Never put credentials, tokens, message contents, or other secrets in a flight key.

The callback must be read-only, and callers must treat the shared result as immutable. Both successful and failed flights are removed immediately after settlement, allowing the next request to fetch fresh data.

## Limits

- `SENTINEL_MAX_ACTIVE_FLIGHTS` defaults to `5000`. Once reached, new unique reads bypass coalescing rather than growing the map without bound. Set it to `0` to disable all coalescing.
- `SENTINEL_MAX_BUFFERED_ATTACHMENT_BYTES` defaults to `1048576` (1 MiB) and cannot exceed the attachment upload limit. Set it to `0` to stream every attachment.
- `SENTINEL_MAX_TOTAL_BUFFERED_ATTACHMENT_BYTES` defaults to `33554432` (32 MiB). When concurrent unique object reads exhaust that process-wide budget, those requests fall back to streaming instead of allocating more buffers. Set it to `0` to disable body buffering while retaining metadata coalescing.
- Flights are local to one Node.js process. They do not deduplicate work across PM2 workers or hosts. The current message service runs as one process, so message and attachment integrations share one Sentinel instance. A future multi-process message service would require distributed coordination for cross-process coalescing.
- Sentinel does not add timeouts. Storage clients remain responsible for their own deadlines; dropping a still-running flight early would allow duplicate work.
