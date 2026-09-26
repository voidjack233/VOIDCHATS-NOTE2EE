# Reaction concurrency and scaling audit

Date: 2026-09-26. Baseline: `0cd8f8bc2ec183a2ce4ee5a0b51cf7ee5941d949`.
Results below describe the uncommitted working tree, not a production deployment.

## REACTION FLOW

Before: optimistic frontend toggle -> 220 ms coalescing -> authenticated PUT ->
membership/friendship checks -> message existence -> read current membership ->
three independent Scylla writes -> recipient discovery -> 150 ms gateway batching.

After: the same authorization path, but PUT `{present:true}` ensures membership
and DELETE `{present:false}` ensures absence. One conditional batch changes the
message's summary, revision and user's emoji set in one Scylla partition. HTTP
success follows durable acknowledgement, never a Valkey-only enqueue. Same-state
requests are durable no-ops. Notifications carry absolute versioned snapshots.

Legacy PUT-without-body clients receive 409 `REACTION_CLIENT_UPGRADE_REQUIRED`.
The new client rejects legacy unversioned responses rather than retrying forever.
Deploy API and frontend together; this is an intentional contract change.

## BASELINE OPERATION COUNTS

Warm valid-session DM requests, excluding initial readiness and session recovery:

| Operation | PG statements | Scylla reads before -> after | Scylla write requests before -> after | Valkey session/limiter |
| --- | ---: | ---: | ---: | ---: |
| ADD new emoji | 4 | 3 -> 2 | 3 -> 1 conditional batch | 2 EVALs |
| ADD existing type, new user | 4 | 3 -> 2 | 3 -> 1 conditional batch | 2 EVALs |
| REMOVE | 4 | 2 -> 2 | 3 -> 1 conditional batch | 2 EVALs |
| Already-desired state | 4 | 2 after | 0 after | 2 EVALs |

The new batch has **three CQL statements**, not one physical disk write: CAS
static summary/revision, update/delete the user's emoji set, ensure the summary
row. Paxos adds protocol work. Counts above are driver requests, not replica I/O.
The first use per service process also reads `reaction_schema` once. CAS losses
add a read/batch retry, bounded to eight attempts before retryable 425.

Recipient SQL and enqueue run before HTTP response; actual serialization and
PUBLISH run asynchronously after the unchanged gateway batching timer. Previously
a DM notified one user; now both are notified to reach the actor's other devices.

## CONCURRENCY TESTS

Real HTTP, authentication/CSRF/limiter, isolated PostgreSQL/Valkey, and a random
disposable Scylla keyspace. Table contents were inspected independently of HTTP.

| Initial membership | Concurrent operations | Before actual members / counter | After actual members / count |
| --- | ---: | ---: | ---: |
| absent | 2 | 1 / 2 | 1 / 1 |
| absent | 10 | 1 / 10 | 1 / 1 |
| present | 2 | 0 / -1 | 0 / 0 |
| present | 10 | 0 / -9 | 0 / 0 |

Before, two new emojis at the nine-type boundary both returned 200 and produced
11 types. After, exactly one succeeds and one receives 409; count stays ten.
At ten, a new type is rejected, but another user may add an existing type.
Independent state instances and two separate Node processes reproduce these
checks without sharing the in-process queue. Different-user/same-emoji and
same-user/different-emoji operations also preserve membership/count equality.

## CORRECTNESS FINDINGS

Confirmed before editing: counters can drift permanently and become negative;
the unique-type limit was best effort; retries invert state; actor devices were
excluded from fanout; frontend batched entries incorrectly expected per-entry
conversation/message IDs although the gateway supplies those in the envelope.

The authority is now `reaction_state`, partitioned by storage conversation and
message, with a bounded emoji set per user and a static counts map/revision.
Every mutation uses the same partition's CAS. No independently updated index or
counter remains in the serving path. A permanent empty summary row allows users
who have not reacted to read counts and the empty-state revision. The revision
survives removal of the last reaction, preventing an empty-state version reset.

## PARTIAL FAILURE

Baseline fault injection demonstrated all three divergence classes:

| Failed legacy write | State after failure | Retrying the old toggle |
| --- | --- | --- |
| membership | count 1 and `me:true`, no membership | creates membership but count becomes 2 |
| counter | membership and `me:true`, no count | removes membership and counter becomes -1 |
| user index | membership/count 1, `me:false` | removes the existing reaction instead of repairing the index |

There was no authoritative repair process; a crash between writes could leave
the same inconsistencies. Migration treats `message_reactions` membership as the
chosen legacy source of truth, not already-drifted counters or user indexes.
It cannot reconstruct user intent lost before any membership write succeeded.

After: failure before the conditional batch leaves everything unchanged; an
injected lost acknowledgement after the batch leaves one consistent committed
state. Retrying the desired state neither duplicates nor reverses it. Mutation
reads use LOCAL_SERIAL so an idempotent no-op cannot ignore an outstanding Paxos
decision after a timeout. Batch acknowledgement uses LOCAL_QUORUM and
LOCAL_SERIAL, with automatic batch replay disabled. A local process crash can
lose an HTTP response or notification, not create a half-membership/half-count
commit. Pending HTTP callers have not received durable success.

This relies on single-partition conditional semantics, not ordinary cross-table
batch atomicity. Do not add nonconditional writers to `reaction_state`.
See [Scylla LWT and serial reads](https://docs.scylladb.com/manual/stable/features/lwt.html)
and [batch isolation scope](https://docs.scylladb.com/manual/stable/cql/dml/batch.html).

## POSTGRESQL

DM: conversation lookup, membership, accepted friendship, one recipient query.
Group root: conversation lookup, storage-channel resolution, membership, one
recipient query. Direct channel: conversation lookup, membership, recipients.
The first two cases require four statements; direct channel requires three.
These retrieve distinct facts. Membership authorization and recipient enumeration
are not interchangeable. No per-recipient queries or nested pool acquisitions
were introduced, and no PG client is held while waiting for a reaction CAS.

## SCYLLA

Uncontended sampled DM request latency before/after, ms: new ADD 8.86/9.54,
existing-type ADD 12.27/9.56, REMOVE 9.00/9.79. These single samples are not
latency distributions or proof of universally faster writes. Conditional storage
is justified primarily by the reproduced correctness failures.

An isolated prototype compared uncoordinated CAS contention with local per-message
serialization: the final repeat at 100 callers took approximately 5.59 s median
with 4,383 CAS retries, versus 96.9 ms and zero retries for serialized work. Therefore
the implementation keeps a small process-local scheduler, not a distributed
write-behind queue. At most 512 requests per message and 1,024 total are held;
requests aged over five seconds are rejected before starting. Driver timeouts
still bound an active database call. Separate processes remain protected by CAS.

History still uses bounded partition-batched hydration, not per-message reads or
all-user scans. The new query returns at most two rows per message: the summary
and the viewer's emoji set, each set bounded by ten. Chunk size remains 50;
Sentinel message flights, pagination, authorization and attachment work are unchanged.
Counts and `me` are read together, avoiding a cross-query mixed-version result.

Two initial prototypes were rejected because they were slower. The compact set
representation was measured against the actual old queries plus mapping, using
100 paired samples after five warmups, alternating execution order:

| Messages, six reacted emojis each | Old p50 / p95 ms | New p50 / p95 ms |
| --- | ---: | ---: |
| 20 | 1.561 / 2.456 | 1.352 / 3.557 |
| 50 | 2.766 / 3.367 | 2.150 / 3.018 |

The replacement is faster at the median for both and at p95 for 50, and uses one
query instead of two. **The 20-message p95 regressed in this local run**; this is
not a blanket latency improvement claim. The raw distributions are retained.
History returns the same `count`/`me` contract plus revision metadata, including
`reaction_revision` on messages with no remaining reactions. The cache projection
preserves that optional field without changing synchronization policy.

## VALKEY

Two warm critical-path EVALs are unchanged: immutable-session authorization and
the existing per-user reaction limiter. No reaction bytes, counter authority,
buffered durability or write-behind were moved into Valkey. No new infrastructure
or dependencies were added. Direct Scylla storage completed the measured bursts
correctly; the measurements do not justify introducing write-behind recovery risks.

## GATEWAY FANOUT

The existing 150 ms per-user/conversation/message buffer remains. Reaction entry
payloads now include `revision`, `counts`, and the actor's `mine` emoji set. The
client inherits conversation/message identity from the REACTIONS_BATCH envelope,
rejects older revisions and commits the whole batch in one state update. Both
individual event handlers remain for compatibility with the dispatcher.

| Concurrent users/members | Before queued / publishes | After queued / publishes | After serialized bytes |
| --- | ---: | ---: | ---: |
| 10 | 90 / 10 | 100 / 10 | 28,490 |
| 100 | 9,900 / 400 | 10,000 / 400 | 2,714,000 |
| 500 | 249,500 / 10,636 | 250,000 / 9,079 | 68,253,014 |

Micro-batching materially reduces publishes, but not O(mutations * members)
enqueue work. The actor is intentionally included now, and snapshots are larger
than deltas. At 500, measured enqueue CPU total was 289.4 ms, serialization total
265.1 ms, publish-promise p50/p95 12.48/32.29 ms. Publish durations overlap and are
not additive end-to-end latency. The fixture invokes the real batching code and
isolated Redis PUBLISH; it is not 500 real Phoenix-connected browsers.

Gateway batching remains best effort in process memory. A crash before flush can
lose notifications; durable state remains readable. No notification-outbox or
guaranteed delivery claim is made. Earlier conversation-level batching could
reduce the measured O(N*M) cost, but changing gateway targeting, protocol and
authorization was not justified for this correction.

## FRONTEND

Immediate optimistic UI and 220 ms coalescing are retained. Three rapid
add/remove/add taps issue one ADD; add/remove issues zero requests. Only one
request per message/emoji is in flight. HTTP uses explicit desired state;
unknown outcomes followed by changed intent send an explicit compensation.
425/429/5xx and network errors retry at bounded backoff, at most three retries.
Disposed/account-switched work cannot acquire another account's credentials.

Absolute revisions handle own echoes, delayed HTTP responses, repeated batches,
other-tab changes and stale history. Empty snapshots have a revision as well.
The real hook + fetchWithAuth ran in two Chromium tabs against an isolated HTTP
fixture and actual gateway event emitter. It verified CSRF/account headers,
PUT/DELETE, one batched update, convergence and account-switch cancellation. This
was not a manual test with two production accounts.

## HOT-MESSAGE BENCHMARK

Local synthetic benchmark, one burst per size, distinct users on one group
message; isolated PG pool max 10, disposable RF=1 Scylla with tablets disabled,
isolated Valkey and real authenticated route. All cleanup completed. These are
not production capacity numbers, RF=3 partition-failure tests or multi-DC claims.

| Users | Before request p50 / p95 ms | After p50 / p95 ms | After event-loop max ms | After count / memberships |
| --- | ---: | ---: | ---: | ---: |
| 10 | 53.39 / 56.27 | 42.09 / 60.77 | 10.94 | 10 / 10 |
| 100 | 380.02 / 611.92 | 431.27 / 613.47 | 24.40 | 100 / 100 |
| 500 | 2,184.11 / 3,919.07 | 2,226.10 / 3,383.45 | 78.18 | 500 / 500 |

All requests returned 200; no negative counts, lost memberships, CAS exhaustion
or 11-type states occurred after correction. At 500: 2,000 PG statements, 1,000
Scylla reads, 500 conditional batches, 1,000 session/limiter EVALs. Per-operation
PG p50/p95 2.11/4.09 ms; Scylla 2.03/5.15 ms; Valkey EVAL 1.30/3.18 ms.
Request latency also includes queue wait and fanout. Measurements include test
instrumentation and local shared-host effects. No 1,000-user burst was run: 500
already enqueues 250,000 events and serializes 68 MB, enough to identify fanout
pressure without doubling the caller count and quadrupling recipient work.

## CHANGES MADE

- `server/reactions/{state,index,migrate}.ts`: atomic authority, bounded scheduling, verified migration.
- `db/scylla-migrations/0001_atomic_reactions.cql`, `scripts/migrate-reactions.ts`: additive schema and explicit drained-writer copy.
- `server/routes/conversations/{reactions,batchReactions}.ts`: desired-state route and new authoritative hydration.
- `server/routes/conversations/messages/{shared,history,byId}.ts`: reaction-only hydration/revision integration.
- `server/gateway/client.ts`: three snapshot fields in the existing batch entries; no timer or targeting redesign.
- Web `reactionSync.ts`, `useReactions.ts`, `messageService.ts`: desired-state controller and gateway-envelope correction.
- Web `chatTypes.ts`, `chatStore.ts`, `chatSyncCore.ts`: optional revision field and one-field cache projection.
- Focused scripts/tests and existing history/media fixtures: isolated assertions, benchmark, migrations, two-process/two-tab races and compatibility.
- `docs/future-notes.md`: removed; this measured audit replaces its speculative write-behind proposal.

## BEFORE / AFTER

Read/toggle + three inconsistent durable projections -> explicit desired state
and one conditional authority. Racy ten-type check -> CAS-protected strict limit.
Increment/decrement event replay -> absolute revisions. Actor-tab divergence ->
actor-inclusive fanout. Per-entry identity assumption -> batch-envelope identity.
History remains batched, now with at most two bounded rows per message.

## SECURITY

Authentication, immutable sessions, CSRF, per-user rate limiting, membership,
DM friendship, emoji normalization/length/grapheme checks, message existence,
logical/public/storage conversation resolution and existing viewer rules remain.
No auth result is inferred from cached reaction state. The old handler allowed
member viewers to react; this pass neither adds a new viewer denial nor removes
one. An in-flight request retains existing authorization timing, not a new ACL
transaction spanning gateway delivery. Auth, attachment/VMD and send persistence
implementations were not modified.

## TESTS

Commands run from `VOID0000-api` with Node 24.13.1:

```sh
node --import tsx scripts/audit-reactions.mjs --local-scylla --fixed
node --import tsx scripts/tests/messages/reactionStateProbe.mjs
node --import tsx --test --test-concurrency=1 scripts/tests/messages/reactions.test.js scripts/tests/messages/historyRequestWork.test.js scripts/tests/attachments/attachmentDeliveryIo.test.js
node --import tsx scripts/tests/run-isolated.mjs
npm run typecheck
npm run lint
npm run build
```

Focused backend: 36 passed. Full isolated backend: 329 + 6 profile/Phoenix
integration tests passed. Typecheck, full API lint and production build passed.
Phoenix `mix test` with fixture Valkey, random port and generated secrets: 19
passed (same fixture isolation as `scripts/tests/media/fixtures.js`, not live
gateway/Valkey). No Go sources changed. No live migration or restart was run.

Commands run from `VOID0000-www`:

```sh
node --import tsx --test --test-concurrency=1 scripts/tests/messages/reactionSync.test.ts scripts/tests/messages/reactionsBrowser.test.mjs scripts/tests/messages/messageSyncRevalidation.test.ts
node --import tsx --test --test-concurrency=1 scripts/tests/*/*.test.ts scripts/tests/*/*.test.tsx scripts/tests/*/*.test.mjs
npm run lint
npm run build
```

Focused frontend: 27 passed. Build includes `tsc -b` and Vite, both passed.
Full frontend: 222 passed, two failures outside reactions: the deployed media
timeline test requires an explicit `MEDIA_TEST_DEPLOYED_URL`, and the poster/video
fallback test times out waiting for its failure label. The latter also fails on
the untouched baseline. No deployed target was silently selected for that test.
Lint of every changed frontend file passed. Full frontend lint retains 68
errors/15 warnings; the untouched baseline has 68 errors/16 warnings. No global
rules or ignores were weakened. The existing media playback failure was also
reproduced from a clean archive of the baseline in `/tmp`.

From repository root, `git diff --check` passed.

Raw evidence (ignored, not committed), under `VOID0000-api/benchmark-results/`:

- Baseline: `reaction-audit-2026-09-26T01-16-09.053Z.json`.
- Final compact/serial-read run: `reaction-audit-2026-09-26T15-32-20.999Z.json`.
- Rejected per-emoji-row snapshot: `reaction-audit-2026-09-26T15-13-56.813Z.json`.

## DOC CLEANUP

Reaction Scaling was the sole item in `docs/future-notes.md`. Its unsupported
future write-behind design is replaced by this completed audit, concrete bounds,
measured fanout cost, test results and operational rollout requirements.

## REMAINING

This working tree is **not deployed**. New reaction/history readers intentionally
fail closed until the migration readiness marker exists. Operator rollout:

1. Back up legacy reaction tables and drain ALL old/new reaction writers across replicas.
2. Review `npm run migrate:status`, then apply the additive schema with the existing migration runner (`npm run migrate`). Review other pending migrations first.
3. Run `npx tsx scripts/migrate-reactions.ts` for inventory (no copy/readiness writes).
4. Run `npx tsx scripts/migrate-reactions.ts --apply --writers-stopped`. Copy uses idempotent conditional writes; verify membership and aggregate counts before readiness is published.
5. Deploy/restart the built API and matching frontend together; verify add/remove, two tabs and history. A fresh installation also needs the readiness step even with zero legacy memberships.

No legacy tables are dropped. Failed/interrupted copies are resumable with
writers still stopped; the serving gate stays closed. Already-ready copies are
not replayed over newer state. A legacy message with >10 actual emoji types
blocks readiness for explicit operator review; no reaction is arbitrarily
discarded. If an operator changes the legacy source to resolve such a conflict,
the incomplete target also needs explicit reconciliation before resuming; the
script refuses extra/mismatched target memberships rather than deleting them.
Do not resume the old code after new writes start and assume its old
tables are current. Rollback requires a reviewed data reconciliation plan.

Measured limits: serial hot-message latency remains seconds at 500 callers;
fanout grows quadratically when every member reacts; 20-message history p95 did
not improve in the recorded run. Local-only scheduling cannot eliminate CAS
contention across many service replicas. Multi-replica/DC failover and genuine
production-device delivery remain deployment checks. No 1,000-user or live
production penetration/capacity test was performed. These limits do not justify
changing acknowledged reaction durability to Valkey-only write-behind.
