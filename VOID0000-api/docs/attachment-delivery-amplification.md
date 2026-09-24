# Attachment Delivery Request Amplification

Audited baseline: `c9ad6353ffd3df34a09672c5fb84d47bae460fa3`.
Counts below describe successful requests, distinct authorized attachment IDs,
and eligible images. They are operation counts, not throughput measurements.

## Request Amplification

| Case | Attachment PostgreSQL queries | MinIO stats before -> after* | Original presigns | VMD capabilities |
| --- | ---: | ---: | ---: | ---: |
| A: 20 messages, no attachments | 0 | 0 -> 0 | 0 | 0 |
| B: 20 messages, 5 images | 1 | 5 -> 0 | 5 | 15 |
| C: 20 messages, 20 images | 1 | 20 -> 0 | 20 | 60 |
| D: one message, N distinct images | 1 | N -> 0 | N | 3N |
| E: case C requested again, URLs still valid | 1 | 20 -> 0 | 20 | 60 |
| F: case C requested again after expiry | 1 | 20 -> 0 | 20 | 60 |

*The optimized count applies to finalized content-addressed blobs with complete
server-established policy. Historical/incomplete rows retain one stat each.
Different logical IDs pointing to one physical blob are still separate delivery
identities. Repeated occurrences of the same ID within a page are deduplicated.
A video with a trusted poster previously added two stats and two presigns; it
now adds zero stats when both persisted policies qualify, and still two presigns.

Every case above generates **zero image HTTP requests, cache-object reads,
source-byte reads or transforms inside the history request**. Those are separate
browser/VMD requests and depend on viewport eligibility, cache state and failure.

## Hot Path

`messages/history.ts` resolves the conversation, checks membership, retrieves
Scylla messages and reactions, and calls `attachSignedAttachmentUrls`.
Normally a nonempty 20-message page uses one Scylla history query (a 50-row
chunk, selecting 21 for `has_more`) and two reaction queries. The loop permits
up to 12 history queries; reactions use chunks of 50 IDs. Sentinel coalesces
simultaneous identical history queries within the process, not later requests.

Before hydration, a DM/channel normally requires two PostgreSQL queries:
conversation identity and membership. A group root adds a query resolving its
storage channel. The attachment query above is additional. Authentication can
add SQL recovery queries when the cached session is absent.

On the valid cached-session path, session validation uses one Valkey Lua call.
The current messages router also runs its send limiter, DM spam guard and fetch
limiter for history GETs: two limiter Lua calls plus one spam-key GET and an
11-command spam pipeline with a conversation ID. These are request-level costs,
not per-attachment costs; attachment hydration itself uses no Valkey. This pass
does not change rate-limit/security routing or its existing accounting behavior.

## Confirmed Bottlenecks

`createSignedAttachmentDelivery` previously always called MinIO `statObject`
for each distinct protected attachment. That lookup rediscovered content type,
exact sanitized-image/video marker and filename for inline/response-header
policy, and incidentally checked object existence. It did **not** use size,
ETag, version or dimensions to sign originals. A trusted video also statted its
poster. This was network I/O even for images never requested by the browser.

## Not Bottlenecks

Descriptor parsing, deduplication, policy checks, serialization and HMACs are
local CPU operations; no evidence justifies moving them to Go. The installed
MinIO SDK calls `getBucketRegionAsync` and `checkAndRefreshCreds` during signing,
but our clients specify a region and static credentials: both avoid network I/O.
Tests exercise the real SDK with a transport that throws if signing connects.

VMD generates small/medium/large: three capability HMACs per eligible image.
The current default signing path also derives its domain-separated key three
times, for another three local HMACs. Case C is 60 capability HMACs plus 60 key
derivations, unchanged. These are not 120 storage requests. No CPU benchmark or
meaningful signing bottleneck is claimed.

## Changes Made

The existing single attachment lookup now selects blob `content_hash`,
`content_type`, `inline` and `status`, including corresponding poster fields.
The delivery policy accepts them only for a ready blob with a canonical
content-addressed object key matching its hash, a Boolean inline value and an
allowed exact content type. Unknown/inconsistent metadata falls back to MinIO.
One shared response-parameter formatter keeps filenames, disposition and cache
headers identical regardless of which policy source was used.

No migration, additional cache, service, package, queue or concurrency increase.
The existing bound remains 8 by default, maximum 32, **per mapper invocation**,
covering original delivery, optional poster delivery and VMD signing. It is not
a process-wide I/O bound.

## Before Flow

Authorized messages -> parse/dedupe -> one PostgreSQL attachment join -> N MinIO
stats -> local original presigns -> local responsive VMD capabilities -> JSON.

## After Flow

Authorized messages -> parse/dedupe -> same PostgreSQL join with existing policy
columns -> local policy validation -> same local presigns/capabilities -> JSON.
Legacy or incomplete policies still use the original stat/marker path.

## Operation Reduction

Each trusted image removes exactly one history-time storage metadata request,
including repeated pages and message-by-ID expiry refreshes. No SQL query or
presign was removed. Tests assert counts for 0/1/5/20 images, multiple images,
duplicate IDs, valid repeated generations, expired generations, files and video.

## VMD

Unchanged. Capability verification is stateless and happens before render work.
An origin render resolves the attachment in PostgreSQL, stats the source to
verify its independent exact marker and fingerprint, then checks the persistent
variant cache (stat plus bounded read and checksum validation). A cache hit
reads derived bytes, **not source bytes**, and does not transform. A miss reads
source bytes and uses the existing bounded queue and IPC Sharp transformer;
valid output is written back to the persistent cache. Same attachment/variant
flights are coalesced. Queue, timeout and error behavior remain unchanged.

Five-minute expiry buckets still give identical URLs for the same logical
attachment/variant/bucket/key across authorized users. That permits shared CDN
reuse when configured, without per-user cache fragmentation. Actual edge hit
rates were not measured. `exp` and `sig` remain part of the key; shared-cache TTL
ends at capability expiry. Browser-private 30-second stale grace is unchanged.
Original URLs retain `private, no-store`; they are not the shared-cache path.

## Frontend

Unchanged. Entire history pages receive delivery metadata, but row and individual
media viewport gates delay native image loading until near the viewport. The
timeline uses small/medium; the viewer uses medium/large and original fallback.
Original URLs are still eagerly signed even if only a VMD variant is loaded.
Removing them would change direct fallback, original downloads, files and video
for a local CPU saving, so lazy original delivery was deliberately rejected.

An expired image invokes a generation-bounded refresh. `MessageViewV2` coalesces
concurrent requests per conversation/message through `getMessageById`, not per
attachment and not globally across different messages. That route rechecks
membership, reads the message, and hydrates its attachments. The refresh patches
only an existing visible message and persists the attachments to its existing
IndexedDB record. Loaded-image retention, no trimmed-message insertion, cached
restoration and Jump to Present remain untouched.

## Security

Image policy is persisted by `uploadProcessor.ts`/`lifecycleCore.ts` after the
real sanitizer returns and the canonical object write succeeds. Non-image files
are persisted as non-inline octet-stream. The Go media worker persists video and
poster policies only after normalization and verifies their exact storage
markers before committing. Deduplication checks stored policy for conflicts.
Application writers do not rewrite a ready content-addressed blob in place.

Migration 0011 deliberately left historical hash/type/inline fields NULL. Those
rows are **not** inferred trusted from descriptor MIME, names or dimensions.
No backfill is needed or performed. PostgreSQL supplies policy only after the
same conversation-and-bucket-scoped attachment lookup; membership, ownership,
staged commitment and immutable-edit checks are unchanged. There is no new
authorization cache. VMD and protected byte/Range routes still independently
check storage metadata; signed URL TTLs and response contracts are unchanged.

The removed stat was not a byte-integrity hash verification. Object availability
is now detected at byte delivery rather than preflighted on modern history
hydration; direct image failure/fallback remains the existing client behavior.
Out-of-band operator corruption of both trusted database policy and storage is
not made safe by this optimization and must not be treated as an upload path.

## Tests

From `VOID0000-api`, with Node 24 and Go on PATH:

```sh
node --import tsx --test scripts/tests/attachments/attachmentDeliveryIo.test.js
node scripts/tests/run-isolated.mjs
npm run typecheck
npm run lint
npm run build
go test -race ./vmd/... ./scripts/tests/vmd-go ./media/... ./scripts/tests/media-go
```

The focused tests use real delivery/policy/signing code, counted storage/SQL
boundaries, isolated PostgreSQL/MinIO uploads and actual signed downloads, plus
the real history, by-ID and send code with fixture persistence/session inputs.
The full isolated suite covers sanitizer, lifecycle, Range playback, VMD and
security behavior. Do not use the generic `npm test` without its isolated service
environment: some tests intentionally assert fixed isolated ports.

From `VOID0000-www`:

```sh
node --import tsx --test scripts/tests/*/*.test.ts scripts/tests/messages/*.test.tsx
MEDIA_TEST_DEPLOYED_URL=https://void0000.online node --test --test-concurrency=1 scripts/tests/attachments/*.test.mjs scripts/tests/auth/*.test.mjs scripts/tests/chats/*.test.mjs scripts/tests/performance/*.test.mjs
node --test scripts/tests/attachments/mediaPerformance.test.mjs
node --test scripts/tests/attachments/video.test.mjs
node --test scripts/tests/messages/trimGeometry.test.mjs
# Local production-build rerun, with Vite preview running on port 5198:
TRIM_DEPLOYED_URL=http://127.0.0.1:5198 node --test scripts/tests/messages/trimGeometry.test.mjs
npm run lint
npm run build
```

`mediaTimeline.test.mjs` additionally needs an explicit `MEDIA_TEST_DEPLOYED_URL`;
it intercepts API/WS/media and is not a production backend integration test.

Validation results:

- Focused delivery regression: 11 passed, including real isolated PostgreSQL,
  MinIO upload/download and counted signing operations.
- Full isolated API runner: 269 passed plus 6 isolated profile/gateway tests,
  275 total, zero failures. Repeated after the final poster-bucket join change.
- API typecheck, lint and production build passed.
- Go VMD/media tests passed under the race detector.
- Frontend unit tests: 187 passed, zero failures. Includes delivery expiry,
  responsive viewer sources, pagination, cached restoration and refresh/window
  integrity.
- Frontend TypeScript/production build passed (`npm run build` runs both).
- Full frontend lint remains at 68 errors and 16 warnings in unchanged files.
- Combined browser run: 17 passed, 4 failed (including the parent of a failing
  desktop media subtest). Standalone reruns passed all 3 media-frame tests and
  the video upload/account-isolation test. The latter's combined-run assertion
  had assumed arrival order for two concurrent uploads.
- The existing poster-first video test still times out waiting for its failure
  overlay after dispatching synthetic error events. It uses local mocked video
  responses, not this API change. It is unresolved, not reported as passing.
- Deployed-bundle mixed-media geometry, browser account-switch/CSRF/refresh,
  IndexedDB account isolation and routed profile tests passed. These intercept
  backend traffic and are not live production end-to-end verification.
- Local production-build history/trim browser regression: 1 passed, covering
  older/newer trimming at 1280px and 390px in compact and comfortable density.
  Maximum measured surviving-row displacement was 0.5px. The prior Vite-dev run
  reached the desktop comfortable case before Chromium's target crashed; its
  measurement-handoff check had already passed with zero accounting difference.

An initial generic `npm test` run was stopped after isolation guard failures;
the successful backend result above comes from the isolated runner, not that
run. Test logs are under `/tmp/void-delivery-*`; generated outputs are untracked.

## Files Changed

- `server/utils/attachmentDelivery.ts`: select/use existing blob policy.
- `server/utils/attachmentContentPolicy.ts`: validate persisted policy and share response parameters.
- `scripts/tests/attachments/attachmentDeliveryIo.test.js`: operation counts and compatibility/route regressions.
- This audit document.

## Remaining

Legacy/incomplete rows still perform storage metadata I/O. VMD still stats source
objects at origin for its independent integrity/cache-identity check. Original
presigns and HMAC counts are intentionally unchanged. No production load test,
RPS improvement, CDN hit-rate improvement or deployment is claimed by this audit.
The unchanged frontend lint findings and poster-first browser regression remain
outside this backend request-amplification patch.
