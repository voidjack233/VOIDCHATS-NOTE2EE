# Message send audit and durable idempotency

Baseline: `9f7ec58f4cda00c7ad7c1d2c5aa738abb9f58b4a`.
Measured September 25-26, 2026 UTC. This is an isolated
correctness/operation-count audit, not a production latency/load test.

## SEND FLOW

`message-server.ts` applies cookie/session authentication and encrypted CSRF;
`routes/conversations/messages.ts` applies the send limiter and DM spam guard.
`messages/create.ts` invokes `sendConversationMessage` and returns 201.

Before: conversation/storage resolution -> membership/viewer/friendship ->
Valkey GET -> attachment permission/metadata/mention validation -> reservation
-> Scylla INSERT -> attachment acknowledgement -> PostgreSQL conversation,
unread and attachment commit -> attachment delivery -> Valkey SET -> recipient
query -> schedule gateway and push -> 201.

Now: validation -> durable claim -> resume canonical message if necessary ->
the same storage/acceptance flow, with operation completion in the unread
transaction -> delivery/cache/recipients -> schedule effects -> scheduling
receipt -> release operation lock -> 201. No history or frontend changes.

## DEPENDENCY GRAPH

| Stage | Dependency |
| --- | --- |
| Auth, CSRF, limiter, spam | Security; before protected send work |
| Conversation -> storage resolution | Data; group resolves its general channel |
| Membership -> viewer/DM/attachment permission | Security; no claim/write before approval |
| Mentions, forwarding, reply, attachment references | Validation; before durable claim |
| PostgreSQL operation claim | Cross-process identity/serialization |
| Reservation | Ownership/lifecycle; after claim, before Scylla |
| Scylla write or positive recovery read | Durable message prerequisite |
| Attachment acknowledgement | Only after successful quorum INSERT |
| Conversation + member + attachment + operation completion | One acceptance transaction |
| Attachment delivery | Response data, after acceptance |
| Cache SET, recipient query | Independent after acceptance; currently awaited |
| Pub/Sub, external push | Scheduled after acceptance, not delivery-acknowledged |

No parallel SQL is issued on a transaction connection. Recipient lookup and
delivery could overlap after acceptance with appropriate resource budgeting;
cache maintenance is optional once a durable operation exists. This patch
does not rearrange them or put push on the request critical path.

## IDEMPOTENCY

The baseline race was reproduced using authenticated HTTP requests, actual
PostgreSQL/Valkey, and a disposable keyspace on local Scylla. A test-only barrier
made all concurrent cache misses observable before writes. No production rows
were read or changed.

| Identical requests | Baseline Scylla rows | Unread increments | Publishes (DM) | Push starts |
| --- | ---: | ---: | ---: | ---: |
| 2 text | 2 | 2 | 4 | 2 |
| 10 text | 10 | 10 | 20 | 10 |
| 2 attachments | 1 | 1 | 2 | 1 |
| 10 attachments | 1 | 1 | 2 | 1 |

Text responses all returned different IDs; the final cache contained only one
winner. Attachment reservations prevented duplicate writes: losers got 425 or
recovered the committed message. Attachments were not protection for text.

Migration 0017 adds `message_send_operations`, unique on
`(user_id, conversation_id, client_message_id)`, with one canonical TimeUuid,
storage conversation, deterministic request hash, creation time, acceptance
completion and notification-scheduling timestamps. There is deliberately no
TTL that would silently turn a delayed retry into a new send.

A PostgreSQL session advisory lock serializes each operation across processes.
Busy callers get retryable 425 (the existing web queue recognizes 425). The
durable row, not the lock or Valkey, survives a crash. Retries with different
content return 409; different keys/users/conversations remain independent.
Deleting/replacing a group's storage channel does not erase the logical group's
claim; a retry against different storage is rejected rather than minting an ID.
An independent Node process was killed while holding a claim; its replacement
recovered the same persisted ID after PostgreSQL released the connection lock.

Retries read the canonical row at LOCAL_QUORUM. They do not overwrite existing
edits or resurrect missing accepted messages. If a pending write is absent,
the same ID/timestamp is written, never a second ID. Completed operations skip
unread updates and ordinary repeated fanout/push.

Pre-migration Valkey mappings can be adopted after verifying stored identity.
A missing/unavailable mapped message is uncertain, not permission to create
another. Cache outages cannot erase an existing durable operation. A cache
failure on a first-seen key fails retryably because a legacy mapping might
exist. Historical mappings already expired/evicted cannot be reconstructed:
Scylla does not store the old client key. No historical backfill is claimed.
Requests without a client key retain legacy non-idempotent semantics.

## FAILURE WINDOWS

| Failure point | Result and recovery for keyed sends |
| --- | --- |
| Before claim | No write; retry may establish a new operation |
| Claim acknowledged/unknown, before Scylla | Durable canonical ID if claim committed; inspect it on retry |
| Scylla throws, including write timeout | Pending operation/reservation retained; quorum-read/rewrite same ID |
| After Scylla, before PG BEGIN or during PG updates | Scylla may exist with pending PG state; retry reconciles once |
| During COMMIT, outcome unknown | Never compensate by deleting canonical Scylla row; inspect completion |
| COMMIT actually succeeded | Completion and unread committed together; retry does not increment again |
| COMMIT rolled back | Completion absent; retry performs acceptance once |
| Delivery/member-query failure after acceptance | Client can receive 500; retry returns canonical row and resumes unscheduled effects |
| Cache SET failure | Logged; PG still authoritative; accepted send can return 201 |
| Fanout/response connection failure | Message remains accepted; same-ID retry; notification caveat below |

Baseline unknown-COMMIT reproduction: HTTP 500, unread **1**, Scylla rows **0**,
because text compensation deleted an actually accepted row. After correction:
HTTP 500, unread **1**, Scylla rows **1**; retry returns that ID without another
increment. The unkeyed compatibility path also no longer deletes after an
unknown COMMIT, but cannot give keyless callers exactly-once retry semantics.

Attachment reservations remain protected while an operation is pending.
The worker cannot release them to staged cleanup after a stale negative read.
A positive exact sender/attachment-set read can commit recovery, including a
reservation already committed by the worker, without fabricating an INSERT
acknowledgement. Failed acknowledgement/malformed reads/mismatches remain safe.
An abandoned pending operation is retained, not automatically discarded.

## OPERATION COUNTS

Counts include protocol SQL statements such as BEGIN/COMMIT and lock functions,
not PostgreSQL internal FK/trigger work. Hot valid session cache, new client
key, no legacy mapping, finalized trusted image blobs, successful first attempt.
Push SQL below is separate, never included in these request counts.

| Scenario | PG before -> after | Explicit PG transactions | Scylla read/write | Valkey commands | PUBLISH | MinIO stat |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| DM text, 2 members | 8 -> 14 | 1 | 0 / 1 | 16 | 2 | 0 |
| Group text, 10 members | 8 -> 14 | 1 | 0 / 1 | 16 | 10 | 0 |
| Channel text, 10 members | 7 -> 13 | 1 | 0 / 1 | 16 | 10 | 0 |
| Group text + mention | 9 -> 15 | 1 | 0 / 1 | 16 | 10 | 0 |
| DM, one image | 20 -> 26 | 3 | 0 / 1 | 16 | 2 | 0 |
| DM, five images | 20 -> 26 | 3 | 0 / 1 | 16 | 2 | 0 |
| Group, 100 or 1,000 members | 8 -> 14 | 1 | 0 / 1 | 16 | N | 0 |

Images add one batched delivery metadata query, not one per image. Presigning
is 1/5 local signing calls with explicit-region fixture MinIO. Legacy objects
may still require stat; this audit does not change that policy.

## POSTGRESQL

Normal DM baseline: three authorization/context SELECTs, BEGIN, two UPDATEs,
COMMIT, one recipient SELECT = eight statements. New flow adds try-lock,
operation SELECT/INSERT, completion UPDATE, scheduling UPDATE, unlock = six.
Membership and friendship are distinct security facts. Group storage resolution,
channel-parent attachment policy, mention membership, and fanout recipient
discovery are not interchangeable authorization queries.

One operation connection is reused by reservation/ack transactions, delivery
lookup and recipient lookup. No nested pool acquisition is introduced. Ten
independent attachment sends succeeded with a four-connection pool. Holding
that connection through post-commit work does consume capacity; measure before
further changes. PostgreSQL's one unread UPDATE still modifies O(N) member rows.

## SCYLLA

Normal send uses one INSERT. Keyed text now uses explicit LOCAL_QUORUM like
attachments. Recovery uses LOCAL_QUORUM reads; a pending negative read may be
followed by one canonical INSERT. No schema change or new Scylla index.
Keyed failures never issue destructive compensation. Existing unkeyed rollback
DELETE retains LOCAL_QUORUM and is allowed only before COMMIT was attempted.
Actual local reproduction used RF=1: it proves duplicate rows and SQL effects,
not multi-replica partition behavior. Fault injection covers uncertain responses.

## VALKEY

Sixteen client commands before fanout: session EVAL, limiter EVAL, spam GET,
eleven spam commands in **one pipeline**, idempotency GET and SET. That is six
awaited command/batch exchanges, not sixteen network round trips. Lua's internal
commands are not separate client commands. Existing durable retries skip the
legacy lookup and completed retries skip SET. Rate limits/spam checks still run.

## REALTIME FANOUT

One member query, N full-envelope serializations and N PUBLISH commands,
including sender echo. `sendLiveEventToUser` starts an async dynamic import;
`publishToGateway` launches `publisher.publish().catch(...)` without awaiting
delivery. No room, event name, payload contract or gateway code was changed.

Measured fixed-path fanout sink (real isolated Valkey, same envelope; gateway
dynamic-import/transport boundary replaced by a counted publisher):

| Members | Serialization ms | Publish enqueue ms | Envelope bytes | Event-loop max delay ms |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 0.03 | 0.06 | 1,254 | No sample |
| 10 | 0.06 | 0.20 | 6,270 | No sample |
| 100 | 0.31 | 1.38 | 62,700 | No sample |
| 1,000 | 2.93 | 13.32 | 627,000 | 19.87 |

The monitor resolution is 10 ms; short requests may yield no delay sample,
not proof of zero delay. These are local samples, not a production p99.
CPU enqueue pressure is distinct from waiting for Redis/socket delivery.
The new scheduling marker suppresses normal retry fanout, not all crash-window
duplicates: a failure after publish but before marking can repeat events with
the same `event_id`. Push can likewise repeat. A marker is not an outbox or a
delivery receipt. Conversely, asynchronous publisher failure after marking can
still lose realtime delivery; existing history/reconnect reconciliation remains
necessary. No exactly-once notification claim is made.

## PUSH NOTIFICATIONS

The real dispatcher, real PostgreSQL queries and production capacity gate were
measured separately; external provider I/O was replaced by a 1 ms task.
Unconfigured VAPID means zero work. Configured: one sender-name SELECT, one
batched eligible-subscription SELECT, and one UPDATE per attempted subscription
on ordinary success/failure. Four recipient users at a time, at most ten
subscriptions each, global-per-process gate of eight active/64 waiting jobs.
The capacity slot includes the SQL status update, not just provider I/O.

| Members, one subscription each | SELECTs | UPDATEs/deliveries | Peak active | Simulated completion ms |
| --- | ---: | ---: | ---: | ---: |
| 2 | 2 | 1 | 1 | 3.47 |
| 10 | 2 | 9 | 4 | 7.72 |
| 100 | 2 | 99 | 4 | 54.19 |
| 1,000 | 2 | 999 | 4 | 522.66 |

A separate 12-subscription/10-member test verifies the ten-per-user cap: 90
deliveries, 90 updates, peak eight, for both success and provider rejection.
One dispatch is bounded, not 1,000 simultaneous PG connections. Total work is
still linear, up to `2 + 10*(N-1)` statements, and several API processes multiply
the capacity. Queue saturation can reject work. A failed success UPDATE may
also enter failure bookkeeping and add another UPDATE. No push redesign here.

## ACK CRITICAL PATH

MUST COMPLETE BEFORE ACK: existing security/validation, durable claim, canonical
Scylla write/recovery, acknowledged attachment handling, atomic PG acceptance,
response delivery hydration, existing cache SET attempt and recipient lookup,
effect scheduling/marker, operation-lock release. Never move acceptance after ACK.

MAY OCCUR AFTER DURABLE ACCEPTANCE: signing, cache maintenance, recipient
discovery, fanout and push. HTTP does **not** await Pub/Sub delivery or external
push completion; scheduling CPU can nevertheless delay its event loop. Cache
SET is now redundant for new correctness but retained for compatibility.

## LATENCY RESULTS

Five additional warm sequential samples per fixed-path scenario, isolated HTTP,
no TLS/remote network, real PG/Valkey/Scylla, counted gateway boundary. Fresh
attachment references per send; no repeated-attachment authorization bypass.

| Scenario | Warm median ms | Min-max ms |
| --- | ---: | --- |
| DM text | 7.52 | 7.29-7.58 |
| Group 10 | 7.24 | 6.63-8.27 |
| Channel 10 | 7.88 | 7.11-8.05 |
| Group + mention | 7.25 | 6.85-8.31 |
| One image | 11.02 | 10.60-12.12 |
| Five images | 12.99 | 12.85-13.48 |
| Group 100 | 9.14 | 8.51-9.30 |
| Group 1,000 | 41.29 | 32.50-42.41 |

Baseline first samples were 23.81 ms DM, 23.28 group-10, 26.67 channel,
15.27 mention, 32.93 one image, 45.79 five images, 25.89 group-100 and 65.59
group-1,000. They are not a matched warm distribution; **no speedup claim**.
An earlier working-tree run measured DM/group-1,000 medians of 24.79/76.42 ms;
the variation further rules out treating these local numbers as a production
speedup. The primary change adds durable work rather than optimizing statement count.

Reports contain per-query durations aligned with SQL, Scylla durations, auth,
limiter, spam, context/storage, membership, DM permission, mentions, pool wait,
delivery, recipient lookup, serialization/enqueue, HTTP and publish-drain times.
Nested timers must not be summed twice. Example first group-1,000 sample:
member UPDATE 16.46 ms, recipient query 1.48 ms, Scylla 0.61 ms, scheduling
approximately 16.25 ms. Delivery hydration/signing one/five images took 1.45/2.26 ms in first
samples. No permanent high-cardinality metrics were added.

## CONFIRMED ISSUES

Text cache-miss race and unknown-COMMIT destructive rollback reproduced and
corrected. Attachment reservations prevented baseline duplicate messages but
could return 425/409 rather than recover a pending send. Linear fanout CPU,
unread row updates and push bookkeeping are measured costs. Pub/Sub/push crash
durability remains a separate issue, not silently called solved.

## CHANGES MADE

One primary correctness change: durable send-operation ownership and recovery.
Supporting changes reuse the caller's DB connection, protect pending attachment
reservations from cleanup, and recover exactly matching stored attachments.
No membership/fanout/push architecture, rate-limit, auth, frontend, VMD or
Scylla-schema redesign; no packages or environment settings added.

## BEFORE / AFTER

Both 2 and 10 identical text requests now create one Scylla row, one unread
increment, two DM publishes and one push start. Attachment requests retain those
same counts. Contention returns 425; subsequent retries return the canonical ID.
Unknown successful COMMIT retains one Scylla row instead of deleting it.

## SECURITY

Current membership/viewer/friendship/attachment permissions still precede any
operation lookup or write. A previously successful key does not let a newly
restricted viewer send. Ownership, exact reservation/sender/attachment IDs,
trusted metadata, immutable sessions, CSRF, send limiter and spam guard remain.
Malformed/unavailable reads are not proof of absence. No required invalidation,
authorization or sanitizer condition was weakened.

## TESTS

Node 24.13.1, from `VOID0000-api`:

```sh
node --import tsx --test scripts/tests/messages/sendIdempotency.test.js
node --import tsx scripts/audit-message-send.mjs --local-scylla --fixed
node --import tsx scripts/tests/run-isolated.mjs
npm run typecheck
npm run lint
npm run build
git diff --check
```

Focused tests cover 2/10 concurrent text/attachment requests, changed payload,
sequential retry, Scylla failure before/after write, PG update failure, COMMIT
applied/not-applied, delivery and recipient failure, cache failure, independent
keys/conversations/users, pool-capacity concurrency, worker reconciliation,
failed acknowledgement/malformed reads/mismatches, edits, missing accepted
rows, cross-process crash recovery, and bounded push SQL/delivery.

Phoenix: `mix test` with `MIX_ENV=test`, isolated Valkey, a free loopback
`GATEWAY_PORT`, generated `ACCESS_SECRET`/`PHX_SECRET_KEY_BASE` and
`ERL_FLAGS='+S 2:2 +SDcpu 1 +SDio 1'`: **19 passed**. No live gateway used.
The backend isolated runner also runs real browser/Phoenix profile integration.

An earlier broad run had intermittent failures in untouched password-change,
backup-code and browser-test paths; the serial rerun passed 311 backend + six
profile tests. They were not silenced or fixed by changing auth. Final validation
after adding cache/scheduling and storage-channel deletion regressions:
**314 backend + six profile/gateway integration tests passed**, zero failures.
This includes all 28 focused send tests.
Typecheck, full API lint, production build and diff checks also passed.

## FILES CHANGED

- `db/migrations/0017_message_send_operations.sql`: durable identity/completion.
- `server/routes/conversations/messages/sendOperation.ts`: claim and lifetime.
- `server/routes/conversations/messages/sendMessage.ts`: integrate recovery.
- `server/attachments/lifecycleCore.ts`: reuse connection, positive recovery.
- `server/attachments/reservationReconciliation.ts`: pending-operation fence.
- `server/routes/conversations/messages/shared.ts`: caller-owned queryable.
- `server/utils/attachmentDelivery.ts`: caller-owned queryable; policy unchanged.
- `scripts/tests/messages/sendAuditFixture.js`: isolated authenticated send path.
- `scripts/tests/messages/sendIdempotency.test.js`: behavioral regressions.
- `scripts/tests/messages/sendOperationProcess.mjs`: crash/independent-process fixture.
- `scripts/tests/messages/pushAuditFixture.js`: real dispatcher/SQL measurement.
- `scripts/audit-message-send.mjs`: repeatable disposable-keyspace audit.
- `scripts/tests/messages/historyRequestWork.test.js`: new dependency wiring.
- `scripts/tests/attachments/attachmentDeliveryIo.test.js`: dependency wiring.
- `scripts/tests/attachments/attachmentMessageConsistency.test.js`: updated guard assertion.
- `docs/message-send-audit.md`: evidence, scope and rollout requirements.

## REMAINING

Migration 0017 was applied **only to isolated fixtures**, not production. Drain
old message writers; migrate; deploy the updated attachment worker fence and
message service together before allowing sends. Do not mix old/new writers:
old code does not honor the durable claim. Session advisory locks require
direct PostgreSQL/session pooling, not transaction-mode PgBouncer.

No existing duplicates were deleted, no live services restarted, no commit or
push performed. Production load/latency, multi-replica Scylla partitions and
provider delivery remain untested. Durable pending operations need the same
client payload to finish; no background payload replay or automatic unsafe
reservation expiry was added. Retention/operator handling is a follow-up.

NEXT performance pass: large-group fanout serialization/enqueue pressure and
push bookkeeping, alongside the unavoidable N-row unread UPDATE. Profile in
deployment before changing semantics; Pub/Sub durability/outbox decisions must
be explicit rather than moving work after 201 and concealing loss.

Local evidence (ignored generated output, not committed):
- Baseline: `benchmark-results/send-audit-2026-09-25T15-46-44.780Z.json`.
- Earlier fixed samples: `benchmark-results/send-audit-2026-09-25T16-01-05.311Z.json`.
- Final fixed + warm samples: `benchmark-results/send-audit-2026-09-26T00-04-54.736Z.json`.
- Full validation: `/tmp/void-send-validation-final.log`.
