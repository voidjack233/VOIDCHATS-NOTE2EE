# History latency attribution (2026-09-24)

## MEASUREMENT SETUP

Baseline: `4caf97da7848cf2510492fcca46ffa7a403523cc`. Measurements use the
instrumented, uncommitted working tree, not a changed/deployed PM2 service.
Node 24.13.1, Linux, Intel i5-10210U (4 cores / 8 threads), approximately 12 GiB RAM.

The existing isolated fixture loader executes the current TypeScript HTTP
handlers in VM contexts. It uses real JWT/cached-session validation, the real
fetch limiter, real PostgreSQL 16, real Valkey, the real MinIO signing SDK and
real Scylla queries. There is NO injected datastore delay or mock history result.
The HTTP load client is a separate process. Write routes are not exercised by
this read benchmark; the existing security tests exercise them separately.

PostgreSQL, Valkey and MinIO use temporary isolated instances. Scylla uses a
random temporary RF=1, non-tablet keyspace on the existing local server, with
the repository's actual message/reaction tables. No production rows are read or
modified. The local Scylla server and host resources ARE shared with other work.
Image fixtures contain synthetic finalized blob/attachment metadata; the test
validates generated URLs, not bitmap delivery. No original image bytes are read.

Five warmup requests per scenario are excluded. Each scenario has 20 sequential
requests, then three waves each at concurrency 10, 50 and 100. Additional
reaction pages of 50 and 100 messages have 20 sequential samples each.
Each wave resets ONLY its synthetic user's isolated fetch bucket between
measurements; the real 120/10s limiter and authentication execute on every request.
The benchmark stops on response/shape failure, a request exceeding 2s, or server
RSS above 1 GiB. Scylla DDL alone has a 60s setup/cleanup deadline; measured
driver query deadlines and application settings remain unchanged.

These are small, warm synthetic datasets, not production table-size/network
measurements or an RPS/capacity claim. VM instrumentation, JIT, scenario order,
CPU power management and shared host activity affect absolute timings. Do not
interpret the group scenario being faster than text as a causal group advantage.

Primary final report (2,540 successful measured requests, zero errors):
`benchmark-results/history-latency-2026-09-24T15-17-00.830Z.json`.
An earlier unprofiled run and a separate CPU-profile run also completed all
2,540 requests each. Generated reports/profiles are ignored by Git.

## CURRENT REQUEST FLOW

```text
history timing context -> access JWT + immutable session validation
 -> fetch limiter
 -> canonical conversation PostgreSQL lookup
 -> group storage-channel PostgreSQL lookup (groups only)
 -> membership PostgreSQL lookup
 -> Sentinel history wait -> actual Scylla history SELECT (leader only)
 -> stored-row mapping and visible-page selection
 -> reaction_counts SELECT || current-user user_reactions SELECT
 -> reaction mapping (repeat per 50-ID chunk)
 -> attachment descriptor parsing
 -> conversation/bucket-scoped PostgreSQL attachment/blob batch
 -> bounded delivery: trusted policy -> original SDK signing -> VMD signing
 -> descriptor mapping -> response JSON/send -> response finish
```

Middleware before the message mount (proxy handling, CORS, cookie parsing,
GET CSRF no-op) and network/client parsing are outside the server `total` timer.
The client duration includes the complete local HTTP exchange and body read.

## LATENCY ATTRIBUTION

Mean milliseconds per request at concurrency 1. Nested/parallel stages MUST NOT
be added together. A dash means no operation, not an unmeasured operation.

| Stage | Text 20 | Images 20 | Reactions 20 | Group 20 | Empty |
|---|---:|---:|---:|---:|---:|
| Server total | 5.993 | 13.516 | 6.831 | 5.584 | 2.588 |
| Authentication/session | 0.802 | 0.625 | 0.899 | 0.561 | 0.545 |
| Fetch limiter | 0.402 | 0.224 | 0.307 | 0.278 | 0.236 |
| Conversation resolution | 0.759 | 0.548 | 0.779 | 0.734 | 0.521 |
| Storage resolution | 0.008 | 0.004 | 0.005 | 0.912 | 0.004 |
| Membership | 0.503 | 0.298 | 0.394 | 0.426 | 0.303 |
| History wait including Sentinel | 1.042 | 0.953 | 0.926 | 0.729 | 0.509 |
| Actual Scylla history query | 1.018 | 0.940 | 0.914 | 0.716 | 0.496 |
| Reaction counts query | 1.004 | 0.864 | 1.527 | 0.818 | - |
| Current-user reactions query | 1.016 | 0.725 | 1.153 | 0.746 | - |
| Reaction mapping | 0.009 | 0.010 | 0.695 | 0.010 | - |
| Total reaction branch | 1.229 | 1.088 | 2.427 | 1.017 | 0.006 |
| Attachment PostgreSQL batch | - | 1.487 | - | - | - |
| Trusted policy validation, 20 calls | - | 0.205 | - | - | - |
| Original signing, 20 overlapping calls summed | - | 20.122 | - | - | - |
| VMD signing, 20 synchronous calls summed | - | 3.000 | - | - | - |
| Complete attachment delivery branch | 0.022 | 8.502 | 0.019 | 0.020 | 0.005 |
| Message mapping | 0.366 | 0.301 | 0.322 | 0.265 | 0.001 |
| Descriptor parsing | 0.004 | 0.160 | 0.005 | 0.005 | - |
| Descriptor mapping | - | 0.277 | - | - | - |
| Response JSON/send | 0.424 | 0.645 | 0.361 | 0.337 | 0.231 |

The original-signing sum is NOT 20 ms of serial CPU: up to eight asynchronous
SDK promises overlap within a page. Its mean per operation was 1.006 ms. The
entire attachment branch was 8.502 ms INCLUDING its 1.487 ms PostgreSQL lookup.
VMD signing is synchronous, so its 3.000 ms/page is directly visible local work.

## CONCURRENCY RESULTS

Client p50 / p95 milliseconds. N=20 at concurrency 1; N=30/150/300 at 10/50/100.

| Scenario | 1 | 10 | 50 | 100 |
|---|---:|---:|---:|---:|
| Text | 7.33 / 9.15 | 38.18 / 49.00 | 110.01 / 174.39 | 153.30 / 269.90 |
| Images | 14.90 / 18.31 | 58.43 / 92.35 | 257.03 / 419.33 | 477.83 / 790.67 |
| Reactions | 7.44 / 9.83 | 29.21 / 35.60 | 116.52 / 161.96 | 193.61 / 304.16 |
| Group | 5.47 / 10.71 | 12.43 / 22.15 | 66.63 / 99.84 | 149.72 / 203.36 |
| Empty | 3.08 / 5.18 | 9.55 / 13.92 | 41.96 / 64.21 | 86.45 / 113.16 |

Maximum request latency was 887.31 ms (images, concurrency 100). No measured
request failed, bypassed fetch limiting, or performed a MinIO stat.

## POSTGRESQL

The application does not configure pool size; installed pg-pool defaults to 10.
The benchmark explicitly matches 10 rather than using the test fixture's normal 4.
Acquisition timings include promise scheduling/new-connection time as well as
waiting for a free slot. Query timings are client-observed, not server-only SQL.

| Scenario at concurrency 100 | Acquisition mean / p95 ms | Peak pending | Query mean ms |
|---|---:|---:|---:|
| Text | 21.89 / 70.85 | 89 | 8.38 |
| Images | 80.80 / 364.35 | 90 | 23.31 |
| Reactions | 28.57 / 108.41 | 90 | 9.52 |
| Group | 15.82 / 46.63 | 90 | 4.78 |
| Empty | 10.42 / 19.54 | 90 | 3.39 |

Pool waiting is measurable. At concurrency 1 acquisition averages only
0.046-0.077 ms for the five main scenarios. After-load EXPLAIN ANALYZE on the
same image fixture returned server execution times of 0.021 ms (conversation),
0.019 ms (membership), and 0.397 ms (20 attachments). These after-load plans do
not measure SQL during contention, but strongly caution against interpreting a
23 ms client callback delay as a 23 ms SQL execution or blindly enlarging pools.

Dependency graph: canonical ID must precede membership and storage resolution.
Those two metadata reads are technically independent after canonical resolution;
the current code already reads channel metadata before membership. No overlap
was added: savings affect groups only, and permission-sensitive work must remain
behind the membership result. History needs authorized storage identity;
attachment lookup needs IDs from that authorized page. It must not be moved
before authorization. Reactions and attachment hydration are independent AFTER
the authorized page exists, but overlapping them would increase pressure and is
not supported by these CPU/pool results. No SQL merge/cache/schema change.

## SCYLLA

Scylla is the largest datastore contributor for ordinary text and reaction pages
at concurrency 1; image pages add a larger PostgreSQL metadata branch and local
signing. The two reaction queries are already concurrent within each 50-ID chunk.
History must produce the page's IDs before those reads can safely start.

| Reaction-heavy page | Count / user queries | Sum count-query ms | Sum user-query ms | Reaction mapping ms | Whole reaction branch ms |
|---|---:|---:|---:|---:|---:|
| 20 messages | 1 / 1 | 1.527 | 1.153 | 0.695 | 2.427 |
| 50 messages | 1 / 1 | 2.232 | 1.726 | 1.665 | 4.165 |
| 100 messages | 2 / 2 | 5.009 | 3.626 | 3.163 | 8.578 |

Data has six reaction types/message and three current-user reactions. Scaling
is visible, including mapping, but does not justify changing the reaction schema.

The application configures two local driver connections/host; the installed
driver's protocol-v3+ default is 2,048 requests/connection. The maximum sampled
driver in-flight count was 67, far below that capacity. No BusyConnectionError
or history query timeout occurred. Backend shard/storage contention is NOT
independently measured; longer client timings also include event-loop delay.
This is not proof that production Scylla cannot contend.

## VALKEY

One cached immutable-session EVAL and one fetch-limiter EVAL per request;
5,080 measured commands in the final run. Existing single-client behavior is
unchanged. No send/spam work returns to GET/HEAD. Cold/missing session-cache
fallback is outside this normal cached-session dataset and remains tested by
the security suite. Valkey is not the dominant sequential latency contributor.

## SENTINEL

Final run: joins / history attempts (three waves combined):

| Scenario | Concurrency 10 | 50 | 100 |
|---|---:|---:|---:|
| Text | 17/30 | 109/150 | 235/300 |
| Images | 23/30 | 116/150 | 247/300 |
| Reactions | 22/30 | 117/150 | 258/300 |
| Group | 21/30 | 113/150 | 248/300 |
| Empty | 23/30 | 120/150 | 261/300 |

At concurrency 1 joins are zero, correctly: completed results are not cached.
At 100, identical history reads save 78.3-87.0% of history SELECTs, but do not
coalesce user-specific reaction or attachment work. Each snapshot's `started`
equals `succeeded`; `failed=0`, `bypassed=0`, final `active=0`, configured
`maxActive=5000`. In this same-key workload the history flight itself never
requires more than one active key. `maxActive` is capacity, NOT an observed peak.
These intentionally identical bursts are not a claim about ordinary independent
conversations. Existing key-isolation/capacity/error tests remain unchanged.

## LOCAL CPU

20-image response: 42,076 bytes versus 8,176 text bytes. Descriptor parsing
0.160 ms, descriptor mapping 0.277 ms, JSON/send 0.645 ms. Serialization is
measurable but not the primary sequential cost. Stored metadata JSON parsing is
included in message mapping; attachment JSON parsing is separately timed.

A separate optional Node inspector profile was collected ONLY in the benchmark:
`benchmark-results/history-images-2026-09-24T15-13-05.596Z.cpuprofile`.
Across its 500 measured image requests, samples attributed by ancestor stack
included approximately 1,187 ms in MinIO SDK work and 1,375 ms in VMD generation,
roughly half of sampled time excluding idle and profiler frames. Native crypto
init/update/digest, URL construction and canonical signing are visible. This is
sampling evidence, not exact per-function CPU accounting. The fixture loader
and timing wrappers also contribute overhead. The production implementation
does NOT enable inspector, event-loop polling, or CPU profiling.

## EVENT LOOP

At concurrency 1 the 2 ms-resolution monitor had p95 delay around 2.2-2.3 ms;
an image request still occasionally occupied a longer synchronous interval.
At concurrency 100, image p95 delay was 60.65 ms, maximum 73.20 ms, request-wave
utilization 99.86%. Text p95 was 13.38 ms and reactions 21.84 ms. Utilization is
sampled over request waves; delay histograms also include the 100 ms inter-wave
pauses. High utilization alone is not proof of blocking; the delay and separate
CPU profile provide the supporting evidence. No production event-loop hook.

## DOMINANT COST

Sequential text: Scylla history/reactions, then authentication/PostgreSQL.
Sequential reaction-heavy: reaction queries plus reaction mapping.
Sequential images: delivery/signing (8.50 ms total branch, 7.02 ms excluding PG).
Concurrent images: saturated local execution and PG acquisition queueing dominate
observed latency, with delayed I/O callbacks. PostgreSQL is the largest measured
datastore-associated waiting surface at high concurrency, not a proven slow SQL engine.

Best next candidate: investigate redundant synchronous original/VMD signing
work using the native production process profile, preserving key derivation,
expiry and authorization contracts. Do not increase pools, change languages,
cache responses, or redesign reactions based on these local measurements.

## CHANGES MADE

Observability and reusable benchmark only. No functional production optimization.
Fixed-stage counters, sums, maxima and non-cumulative latency buckets appear
under existing message `/health` -> `metrics.history`; existing Sentinel metrics
remain intact. Snapshot retrieval does no I/O. Memory is constant, labels are
fixed, and there are no request IDs, tokens, URLs or keys in metrics. Errors and
closed responses complete timers at most once. Only GET/HEAD history enters
the timing context; other routes do not populate history metrics.

`history_wait` counts each authorized waiter; `scylla_messages` counts actual
executions only. `total` includes rejected requests; stage errors and counts
must be considered before treating a mixed health interval as successful-read
latency. Histogram percentiles are bucket upper bounds; benchmark client
percentiles are exact sample quantiles. Counters reset with the process and
must be differenced over intervals, like existing Sentinel counters.

## BEFORE / AFTER

No claimed speedup. Before: operation counts and aggregate Sentinel statistics.
After: attributable stage timing, real datastore measurements, pool wait, event
loop evidence and a repeatable workload. Previous PG/Scylla/Valkey/MinIO operation
counts remain unchanged. Zero functional optimization is deliberate: observed
CPU/pool pressure is not evidence for safe SQL/pool/schema changes, and a further
signing change deserves a dedicated native-process comparison first.

## SECURITY

No change to authentication, immutable sessions, revocation, CSRF, membership,
pagination, reactions, attachment policy, signing TTLs, VMD verification, send
limits or spam controls. Unauthorized callers still cannot reach history
Sentinel, Scylla message/reaction reads or attachment signing. No caching or
parallel protected work was added. No environment, migration, deployment,
frontend or Go changes. No production data migration or service restart.

## TESTS

From `VOID0000-api`, with Node 24 and the existing local service binaries on PATH:

```sh
node --import tsx scripts/benchmark-history-latency.mjs --local-scylla
node --import tsx scripts/benchmark-history-latency.mjs --local-scylla --cpu-profile
node --import tsx --test scripts/tests/messages/historyMetrics.test.js scripts/tests/messages/historyRequestWork.test.js scripts/tests/sentinel/sentinel.test.js scripts/tests/attachments/attachmentDeliveryIo.test.js
node --import tsx scripts/tests/run-isolated.mjs
npm run typecheck
npm run lint
npm run build
git diff --check
```

Focused tests: 26 passed. Full isolated API suite: 290 passed (284 plus 6 profile
integration tests), including history, Sentinel, auth/session, group membership,
reactions, attachment lifecycle/policy and rate/spam checks. Typecheck, API lint,
production build and whitespace validation passed. Metrics tests cover fixed
cardinality, snapshot isolation, success/failure propagation, once-only completion,
and excluding non-history work. Existing router security tests now run with the
same history/auth timing middleware used by the service.

## FILES CHANGED

- `server/health/historyMetrics.ts`: bounded, history-scoped aggregate timers.
- `server/entrypoints/message-server.ts`: context/auth timing and health snapshot.
- `server/routes/conversations/messages.ts`: fetch-limiter timing only.
- `server/routes/conversations/messages/history.ts`: history, branch and mapping timing.
- `server/routes/conversations/messages/shared.ts`: metadata, membership and reaction timing.
- `server/utils/attachmentDelivery.ts`: PG/policy/signing timing only.
- `server/utils/attachmentDeliveryCore.ts`: descriptor parsing/mapping timing only.
- `scripts/benchmark-history-latency.mjs`: controlled real-store benchmark and optional profile.
- `scripts/tests/messages/historyLatencyFixture.js`: isolated actual-route fixture and probes.
- `scripts/tests/messages/historyMetrics.test.js`: aggregate-metrics regression coverage.
- `scripts/tests/messages/historyRequestWork.test.js`: exercise timed auth/history mount.
- `scripts/tests/media/fixtures.js`: shared metrics dependency and optional test pool size.
- `scripts/tests/sentinel/sentinel.test.js`: verify health metrics remain aggregate/no-I/O.
- `.gitignore`: exclude generated benchmark artifacts.
- `docs/history-latency-attribution.md`: setup, results, interpretation and commands.

## REMAINING

No production capacity conclusion, live traffic test or deployed metric interval
was collected. Scylla server-internal wait, large/cold datasets, realistic mixtures
of unrelated conversations, cold session fallback latency and WAN/proxy effects
remain unmeasured. Benchmark client/server code is isolated via the existing VM
test loader; validate absolute CPU costs in the native built service before a
signing optimization. Do not conflate these local results with live latency.

Setup errors are retained in ignored reports: the first attempt hit Scylla's
counter/tablet incompatibility, corrected to the repository migration policy.
A later repeat timed out during CREATE TABLE and DROP KEYSPACE at the driver's
12s default, before any measured requests. Read-only verification confirmed its
temporary keyspace was gone. The final run uses the bounded setup-only DDL
deadline, completed successfully and reported no cleanup errors. Those failed
setup attempts are excluded from request percentiles, not silently counted as
successful benchmark runs.
