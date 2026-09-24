# Message History Request Amplification

Baseline: `020f54c1bfc10152239512344f97242d9b246894`.
The completed attachment policy optimization is unchanged.

## Current History Flow

The actual route is `GET /api/conversations/:conversationId/messages?limit=20`,
not a literal `/messages/history` endpoint. The message entrypoint applies
CORS/security headers, JSON/cookie parsing, CSRF middleware (GET/HEAD bypass),
`noCache`, and `authenticateUser` before the messages router. None of those
header/parsing steps performs storage I/O. Authentication verifies the access
JWT locally and validates/touches its immutable session in Valkey.

Before this change the router used:

```ts
router.use(messagesSendLimiter, dmSpamGuard, createRouter);
router.use(messagesFetchLimiter, historyRouter);
```

`createRouter` handles only `POST /`. Express executes the preceding middleware
for GET too, then falls through to the fetch limiter/history handler. Thus each
read consumed a send token and recorded a message/fanout event. The policies
and spam counters are explicitly send-oriented; no read authorization depends
on them. This is a router scope error, not duplicate session authorization.
Author intent cannot be proven from names alone; the executable behavior is
proven by the baseline operation-count test and the write/read contracts.

History resolves the requested conversation, optionally resolves a group's
storage channel, verifies membership, parses cursors, enters Sentinel for each
Scylla history chunk, hydrates reactions, then hydrates attachments and returns
JSON. Reactions and attachment hydration remain outside the history flight.

## Request Operation Count

Healthy cached session, successful request, one ordinary 20-message page, no
concurrent matching flight. Counts are application datastore commands: one EVAL
is one Valkey command, not each internal Lua instruction. Each pipelined command
is counted, but `pipeline()` and `exec()` are not extra Redis commands. Startup,
connection handshakes, driver preparation and retries are not per-request counts.

| Request | PostgreSQL before / after | Scylla before / after | Reaction reads (included) | Valkey before / after | MinIO metadata |
| --- | ---: | ---: | ---: | ---: | ---: |
| DM/channel, no attachments | 2 / 2 | 3 / 3 | 2 / 2 | 15 / 2 | 0 / 0 |
| DM/channel, 20 finalized images | 3 / 3 | 3 / 3 | 2 / 2 | 15 / 2 | 0 / 0 |
| Group root, no attachments | 3 / 3 | 3 / 3 | 2 / 2 | 15 / 2 | 0 / 0 |
| Group root, finalized attachments | 4 / 4 | 3 / 3 | 2 / 2 | 15 / 2 | 0 / 0 |

Empty history has no reaction or attachment queries. Larger pages split reaction
IDs into chunks of 50. Legacy attachment policies may still require MinIO;
this pass neither revisits nor changes that behavior.

## Confirmed Redundancy

Removed from GET/HEAD only: one send-limiter EVAL, one spam-block GET, and eleven
spam pipeline commands. That is **13 fewer Valkey commands** and three fewer
Valkey exchanges (EVAL, GET, pipeline), not thirteen separate round trips.
Scrolling no longer consumes send/fanout budgets or creates send-spam blocks.

## Required Operations

| Operation | Classification | Reason / decision |
| --- | --- | --- |
| Local JWT/account identity checks | REQUIRED FOR SECURITY | Token integrity and account isolation; unchanged |
| Session validation/touch EVAL | REQUIRED FOR SECURITY | Immutable sid/revocation fence plus existing TTL/index touch; unchanged |
| Session recovery SQL/cache creation | CONDITIONAL, REQUIRED FOR SECURITY | Only when cached validation fails; unchanged |
| Fetch token bucket EVAL | REQUIRED FOR RATE LIMITING | Read budget; unchanged |
| Send bucket EVAL on history | LEGACY / REDUNDANT | Router scope error; removed from reads only |
| Spam block GET and pipeline on history | LEGACY / REDUNDANT | Account reads were recorded as sends/fanout; removed from reads only |
| Conversation identity SQL | REQUIRED FOR CORRECTNESS | Resolve public/internal ID and type; unchanged |
| Group storage-channel SQL | CONDITIONAL, REQUIRED FOR CORRECTNESS | Different entity, not repeated identity lookup; unchanged |
| Membership SQL | REQUIRED FOR SECURITY | Per-request current membership before Sentinel; unchanged |
| Scylla history read(s) | REQUIRED FOR CORRECTNESS | Current message page; unchanged |
| Reaction counts + current-user reaction reads | REQUIRED FOR CORRECTNESS | Count and `me` from separate partitioned tables; unchanged |
| Batched attachment SQL | CONDITIONAL, REQUIRED FOR SECURITY/CORRECTNESS | Conversation/bucket-scoped authorized blob metadata; unchanged |
| Sentinel map/counter operations | Local read coalescing | No Valkey/SQL of its own; unchanged |

No UNKNOWN operation was removed. History has no extra presence, publish,
push-notification, DM-friendship or write-permission query. Friendship and role
restrictions remain enforced where applicable in send/typing paths.

## Rate Limiting

GET/HEAD now skip only the write-guard router and still encounter the existing
fetch limiter before history, message-by-ID and context routes. Its policy stays
120 tokens per 10 seconds per user. Exhaustion still returns 429/Retry-After.

The send policy remains 30 tokens per 60 seconds per user, with unchanged spam
windows, escalating blocks and fanout tracking. POST creation still completes
before the fetch limiter, exactly as before. To avoid an unrelated behavioral
change, all other non-read methods also retain their prior send/spam/fetch guards:
typing, read receipts, edits and deletes were not reclassified in this pass.
Existing limiter/spam fail-open-on-Valkey-error behavior is unchanged.

## Reactions

Twenty messages produce two parallel prepared Scylla calls: `reaction_counts`
uses the conversation partition and message-ID IN list; `user_reactions` uses
the conversation/user partition and the same ID list. These answer different
questions. Scylla cannot join the tables; fetching individual reaction users to
recompute counts would increase/unbound work. Keep the current batching: two
calls per 50 IDs, zero for an empty page. This is appropriate for the schema,
not a claim of optimality for every conceivable schema/workload.

## PostgreSQL

No duplicated conversation or membership read was found in this history path.
Group-to-channel resolution is required because the group and message storage
channel are different records. Attachment lookup is already one batched query.
No global permission cache or new request context cache is added.

A cache-missed session may add one refresh-token lookup, then pool acquisition,
BEGIN, the locked authoritative refresh-token check, cache CREATE EVAL and
COMMIT (or a failure/rollback). No matching active sid returns 401 instead. This
conditional security path is intentionally excluded from normal cached counts.

## Scylla

The normal page executes one history query with a 50-row chunk, collecting at
most 21 messages for the 20-row response and `has_more`, plus two reaction reads.
The existing loop is capped at 12 iterations; no pagination or consistency
settings change. Concurrent identical authorized history chunks can share one
execute through Sentinel; reaction results are still computed per user.

## Valkey

Before: session EVAL + send EVAL + spam GET + eleven pipelined commands + fetch
EVAL = 15 commands across five awaited exchanges.

The pipeline contains message ZREMRANGEBYSCORE, three ZCOUNT, ZADD, EXPIRE;
fanout ZREMRANGEBYSCORE, ZADD, two ZCOUNT, EXPIRE. All history routes supply a
conversation ID. Triggering a new spam block adds a conditional SET; an existing
block exits early. Neither is part of the healthy successful baseline.

After: session EVAL + fetch EVAL = 2 commands/exchanges. Session touching still
occurs inside the existing validation Lua; it has not been removed or weakened.

## Sentinel

The unchanged history key covers storage conversation, query mode/direction,
cursor and fetch chunk size. Those determine the SQL parameters and result;
page-size slicing and public-ID mapping happen separately for each caller.
Membership is checked before entering the guard. No completed result is cached.

The existing message-service `/health` now returns `metrics.sentinel`, sourced
from `getSnapshot()`. It exposes aggregate counters and gauges only, with no keys
or identifiers and no datastore reads. See [Sentinel](sentinel.md) for exact
counter semantics. Default capacity remains 5000 and capacity still bypasses
coalescing rather than blocking/rejecting reads. No distributed coordination.

Attachment-query coalescing was considered and **not added**. A canonical key
could use conversation, bucket and sorted distinct UUIDs (preferably a bounded
digest). It is safe only after request authorization and must not share mutable
caller results. Identical clients following one history flight could overlap,
but no production overlap/duration evidence establishes meaningful benefit for
this already-batched query. New messages cap attachments at five and pages at
100, but historical descriptors also need a defensible key-size bound. Sorting,
hashing and another flight integration are deferred rather than speculative.

## Changes Made

Only production changes: read/write middleware scoping in the messages router,
and aggregate Sentinel metrics in the existing message-service health response.
Two focused test files and audit/observability documentation accompany them.

## Before / After

Before: auth -> send limiter -> spam tracking -> fetch limiter -> authorization
-> history/reactions -> attachment hydration.

After: auth -> fetch limiter -> authorization -> history/reactions -> attachment
hydration. Non-read paths retain the previous guard order and policies.

## Security

HTTP auth, sid revocation, expected-account isolation, CSRF on mutations,
membership, viewer/DM restrictions, attachment scoping, all write guards and
read throttling remain enforced. The intended behavioral change is that reads
are no longer throttled/penalized as sends; it is not a claim that the accidental
old effective read limit remains identical. No stale authorization cache exists.

## Tests

All commands from `VOID0000-api` with Node 24 on PATH:

```sh
# Executed before changing the production router:
HISTORY_BASELINE=1 node --import tsx --test --test-name-pattern='history request operation counts' scripts/tests/messages/historyRequestWork.test.js
# After the change:
node --import tsx --test scripts/tests/messages/historyRequestWork.test.js scripts/tests/sentinel/sentinel.test.js
node scripts/tests/run-isolated.mjs
npm run typecheck
npm run lint
npm run build
```

Baseline: 3 passing tests, reproducing 15 Valkey commands for both text-only and
20-image requests. Tests use actual cookie/JWT/sid/CSRF middleware, real isolated
PostgreSQL/Valkey, production router/history/delivery code, and a counted Scylla
adapter. They are not a deployed Scylla load test. No production data is used.

Regressions cover read token exhaustion; HEAD/by-ID/context read protection;
unauthenticated, foreign-account, revoked-session and non-member denial;
viewer/DM send restrictions; POST send/fanout limits and CSRF; unchanged write
guards; no read pollution of send counters; user-specific reactions; flight key
dimensions; joining, failure cleanup, no caching, capacity bypass and disabling;
and real health-handler exposure without sensitive fields or storage work.

Final results:

- Focused history/Sentinel run: 14 passed, zero failed. Repeated after adding
  token-exhaustion, viewer-denial, unchanged POST command-count and image-delivery
  assertions. Normal history measured exactly 2 Valkey commands after the fix.
- Full isolated backend runner: 283 passed plus 6 profile/gateway tests,
  **289 passed**, zero failed; run twice. Includes auth/security, lifecycle,
  attachment, media, VMD and the new history/Sentinel regressions.
- TypeScript typecheck, full API lint and production build all exited 0.
- `git diff --check` passed. No frontend code changed or unrelated frontend
  lint/browser-regression repair was attempted.
- Logs: `/tmp/void-history-baseline.log`, `/tmp/void-history-focused-final.log`,
  `/tmp/void-history-api-suite-final.log`, `/tmp/void-history-types.log`,
  `/tmp/void-history-lint-final.log`, `/tmp/void-history-build.log`.

The request-level concurrency test observed one tracked history leader and one
join for two authorized callers, four separate reaction reads, and no entry for
the unauthorized caller. A later identical request started fresh work. The
capacity test observed one leader, one join and one bypass with capacity one;
disabled mode bypassed both calls. Failed leaders released their flight once.
The health test verified those aggregate values without another database call.

## Files Changed

- `server/routes/conversations/messages.ts`
- `server/entrypoints/message-server.ts`
- `scripts/tests/messages/historyRequestWork.test.js`
- `scripts/tests/sentinel/sentinel.test.js`
- `docs/sentinel.md`
- This document.

## Remaining

The largest remaining group of external operations is the necessary database
work: three PostgreSQL and three Scylla calls for an ordinary finalized-image DM
page, versus two Valkey commands. Counts do not establish which is slowest;
latency/overlap measurements are needed before another optimization. Aggregate
Sentinel health counters do not attribute live joins to individual read paths.
Frontend lint/video regressions, VMD, deployment and the prior attachment-policy
optimization were not modified. No production load/latency improvement is claimed.
