# Session lifecycle re-audit remediation

Base: `f11f6070eccc03c04bb5e9d41bd0be915ddf8921`.
This is working-tree remediation, not a deployed-production certification.
No live database, environment files, PM2 configuration or deployment was changed.

## Reproductions and fixes

All five failures were reproduced against the original code before production
source changes, using isolated PostgreSQL/Valkey and a local Chromium harness.

| Finding | Confirmed root cause | Fix and invariant |
| --- | --- | --- |
| 1. Pool exhaustion/deadlock | Post-COMMIT login activation acquired another connection while its caller still retained the original. Holding all ten pool connections left ten activations waiting indefinitely. | Activation reuses the caller's committed client. Login, 2FA completion and password change release it before independent post-login work. The pool size is unchanged. Tests occupy every pool slot, then issue twenty operations against the ten-slot pool. |
| 2. Queued send crosses accounts | Queue generation checks ran after `sendMessage`; an operation waiting for CSRF/refresh could later retry with the browser's replacement account cookies. | An immutable client account-operation scope permanently invalidates old work on A -> B, including A -> B -> A. Queue stop aborts its sends. Checks precede CSRF, refresh and every request/retry. The API independently checks the optional `X-VOID-Account-ID` assertion against signed credentials before granting CSRF, refreshing or admitting protected work. |
| 3. Revoke-all misses sessions | Expiring/incomplete `user_sessions` indexes hid individually live session keys from invalidation. | PostgreSQL refresh rows, locked in the caller's transaction, enumerate revocation targets. The Valkey index is display-only. Touch repairs it but correctness does not depend on it. Revocation atomically fences the immutable session, conditionally deletes its cache and publishes its disconnect. |
| 4. Admin credential changes leave sockets alive | The admin process invoked a shared helper whose optional API publisher was never initialized; disconnect publication was silently skipped. | Admin, normal password change and password reset call the same required invalidation helper before COMMIT. Direct awaited Valkey publication requires a subscriber; unavailable publication fails the request and rolls back the credential transaction. The actual admin subprocess is regression-tested, not only a mocked helper. |
| 5. Old access token adopts replacement | HTTP recovery selected any active user/device row; Phoenix learned the generation from the current cache rather than from the signed token. | Login creates an immutable UUID `sid`, stored in PostgreSQL, cache, access JWT and refresh JWT. Refresh retains it; replacement login changes it. HTTP/cache recovery and Phoenix require an exact match. Old expiry/disconnect commands cannot update or close the replacement generation. |

The five before-fix reproductions are retained outside Git in
`/tmp/void-lifecycle-lNOue7/before.mjs`, `before-browser.mjs` and
`before-gateway.exs`. These scripts assert the old undesirable behavior and are
not the maintained regression suite.

## Lifecycle and failure semantics

- SQL issuance and revocation lock the account before its refresh rows. Refresh
  uses the compatible account-then-token lock order, including expiry cleanup.
- Cache recovery holds a shared lock on the exact active, unexpired `sid` row
  while installing the cache. It cannot select a different device generation.
- A 31-day `auth:revoked-session:<sid>` fence exceeds the maximum 30-day refresh
  token lifetime. Create, touch, refresh and Phoenix reject fenced identities.
  Even a delayed cache write delivered after SQL connection loss cannot revive
  that sid. Session-store cache creation, validation, revocation and fence lookup
  have a two-second deadline.
- Credential revocation publishes before SQL COMMIT. Failed required publication
  rolls SQL back, but any already-issued fence/disconnect is intentionally not
  undone. That sid stays denied; a fresh login with the still-current credentials
  can create a new sid. This is fail-closed partial failure, not a distributed
  transaction or delivery acknowledgement from every individual socket.
- Already identified sockets recheck liveness before incoming operations and
  outgoing events. Pub/sub disconnection closes sockets rather than retaining
  potentially missed revocations; subscription restoration revalidates them.
- Normal refresh still rotates the refresh token and preserves exact predecessor
  receipt recovery. The login sid does not rotate with each refresh.
- Logout targets the token's exact sid, so an old logout cannot revoke a
  replacement login. Revocation failures return 503 instead of false success;
  existing local-cookie cleanup behavior is retained.
- Client cancellation cannot undo a request already authorized/dispatched before
  an account change. It prevents subsequent side effects/retries, and the server
  expected-account assertion prevents an old operation being authorized as B
  even when cookie changes precede delivery of the browser's storage event.

## Files changed

Paths below are relative to the repository root. Tests remain under
`scripts/tests` and the gateway's existing `test` directory.

API production files:

```text
VOID0000-api/db/migrations/0014_immutable_session_identity.sql
VOID0000-api/server/auth/types.ts
VOID0000-api/server/auth/middleware/authenticateUser.ts
VOID0000-api/server/auth/middleware/requestAccount.ts
VOID0000-api/server/auth/services/tokenService.ts
VOID0000-api/server/auth/services/sessionService.ts
VOID0000-api/server/auth/services/loginSessionService.ts
VOID0000-api/server/auth/services/credentialInvalidation.ts
VOID0000-api/server/auth/routes/login.ts
VOID0000-api/server/auth/routes/logout.ts
VOID0000-api/server/auth/routes/refresh.ts
VOID0000-api/server/auth/routes/change-password.ts
VOID0000-api/server/auth/routes/reset-password.ts
VOID0000-api/server/auth/routes/sessions.ts
VOID0000-api/server/auth/routes/twoFactor/verify-login.ts
VOID0000-api/server/gateway/control.ts
VOID0000-api/server/routes/csrf/index.ts
VOIDADMIN/server.js
```

Gateway and frontend production files:

```text
VOID0000-api/void_gateway/lib/void_gateway/socket_auth.ex
VOID0000-api/void_gateway/lib/void_gateway/event_dispatcher.ex
VOID0000-api/void_gateway/lib/void_gateway/gateway_subscriber.ex
VOID0000-api/void_gateway/lib/void_gateway_web/handlers/socket_handler.ex
VOID0000-www/src/Services/Auth/client/authOperationScope.ts
VOID0000-www/src/Services/Auth/client/authClient.ts
VOID0000-www/src/Services/Chat/chatStorageAccount.ts
VOID0000-www/src/Services/Chat/messageService.ts
VOID0000-www/src/Services/Chat/queuedSendRecovery.ts
```

Tests and report:

```text
VOID0000-api/scripts/tests/security/sessionLifecycleFixture.js
VOID0000-api/scripts/tests/security/sessionLifecycle.test.js
VOID0000-api/scripts/tests/security/adminSessionInvalidation.test.js
VOID0000-api/scripts/tests/security/auditHardening.test.js
VOID0000-api/scripts/tests/security/twoFactorLoginCompletion.test.js
VOID0000-api/scripts/tests/auth/tokenService.test.js
VOID0000-api/void_gateway/test/void_gateway/socket_revocation_test.exs
VOID0000-api/void_gateway/test/void_gateway/connection_registry_test.exs
VOID0000-www/scripts/tests/auth/accountRequestIsolation.test.mjs
docs/security-reaudit-hardening-2026-09-11.md
```

## Exact verification

Backend integration tests use a disposable PostgreSQL schema on port 15439 and
Valkey on port 16389. The fixture applies migration 0014 only in its isolated
schema. MinIO is fenced to an unused port; no attachment objects are modified.
Backend and gateway tests must not run simultaneously: backend tests deliberately
remove their sole subscriber to verify publication failure.

Backend commands below used this prefix from `VOID0000-api`:

```bash
env PGHOST=127.0.0.1 PGPORT=15439 PGDATABASE=postgres PGUSER=void0000 PGPASSWORD=test VALKEY_HOST=127.0.0.1 VALKEY_PORT=16389 VALKEY_DB=0 MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=19099 MINIO_ACCESS_KEY=test MINIO_SECRET_KEY=test-storage-secret ACCESS_SECRET=isolated-lifecycle-access-secret-123456789 REFRESH_SECRET=isolated-lifecycle-refresh-secret-123456789
```

Provision isolated services before repeating these tests; do not point this
fixture at an application database. The admin subprocess test also requires a
current API `dist` build and binds only port 14979 on loopback.

| Directory | Command | Final result |
| --- | --- | --- |
| API, prefix above | `node --import tsx --test scripts/tests/security/sessionLifecycle.test.js` | 19 passed |
| API, prefix above | `node --import tsx --test --test-concurrency=1 scripts/tests/auth/*.test.js scripts/tests/security/*.test.js` | 90 passed, 0 failed |
| API, prefix above | `node --import tsx --test --test-name-pattern='pool slot\|racing account-wide\|delayed cache\|SQL/cache recovery\|actual password reset' scripts/tests/security/sessionLifecycle.test.js` | Repeated five concurrency/failure tests: 5 passed |
| WWW | `node --import tsx --test scripts/tests/auth/*.test.ts scripts/tests/chats/*.test.ts scripts/tests/messages/*.test.ts scripts/tests/messages/*.test.tsx scripts/tests/attachments/*.test.ts scripts/tests/presence/*.test.ts scripts/tests/performance/*.test.ts` | 161 passed, 0 failed |
| WWW | `node --test --test-concurrency=1 scripts/tests/auth/*.test.mjs scripts/tests/performance/*.test.mjs` | 13 passed, 0 failed; real Chromium/IndexedDB, external requests blocked |
| Root | `node --test scripts/tests/security/*.test.mjs` | 2 passed, isolated Nginx |
| API | `npm run typecheck` | Passed |
| API | `npm run lint -- --quiet` | Passed using Node 22.22.0 |
| API | `npm run build` | Passed using Node 22.22.0 |
| WWW | `npm run build -- --configLoader runner` | TypeScript/Vite passed using Node 20.20.0 |
| API | `go test -race -count=1 ./vmd ./scripts/tests/vmd-go` | Passed, uncached; Go implementation unchanged |
| VOIDADMIN | `node --check server.js` | Passed |
| Root | `git diff --check` | Passed |

Changed-frontend lint command, from WWW, using Node 22.22.0 (passed):

```bash
node node_modules/eslint/bin/eslint.js src/Services/Auth/client/authClient.ts src/Services/Auth/client/authOperationScope.ts src/Services/Chat/chatStorageAccount.ts src/Services/Chat/messageService.ts src/Services/Chat/queuedSendRecovery.ts scripts/tests/auth/accountRequestIsolation.test.mjs --quiet
```

Gateway command, from `VOID0000-api/void_gateway`:

```bash
env ASDF_ELIXIR_VERSION=1.17.3-otp-27 VALKEY_HOST=127.0.0.1 VALKEY_PORT=16389 VALKEY_DB=0 GATEWAY_HOST=127.0.0.1 GATEWAY_PORT=14019 ACCESS_SECRET=isolated-lifecycle-access-secret-123456789 SECRET_KEY_BASE=isolated-lifecycle-key-base-1234567890123456789012345678901234567890 mix test
```

Result: **19 passed, 0 failed**. This includes signed JWT upgrade, already
identified sockets, stale disconnect/expiry commands, the actual running
pub/sub subscriber and disconnect-on-pub/sub-loss behavior.

```bash
env ASDF_ELIXIR_VERSION=1.17.3-otp-27 mix format --check-formatted lib/void_gateway/event_dispatcher.ex lib/void_gateway/gateway_subscriber.ex lib/void_gateway/socket_auth.ex lib/void_gateway_web/handlers/socket_handler.ex test/void_gateway/connection_registry_test.exs test/void_gateway/socket_revocation_test.exs
```

Formatting passed. Total non-overlapping backend/frontend/browser/gateway/root
suites: **285 tests passed**, plus the Go suite. Targeted/repeated runs above
are subsets and are not counted twice.

## Re-audit and remaining limits

- Rechecked both cache-hit and SQL recovery authorization, exact sid matching,
  delayed cache writes, concurrent refresh/revoke, incomplete indexes,
  credential rollback, admin subprocess publication and stale socket commands.
- Browser tests cover suspension during CSRF, refresh, CSRF retry, queue stop,
  account switching and A -> B -> A. Same-account concurrent requests still
  share refresh/CSRF operations. Binary upload auth tests remain passing.
- Existing 2FA challenge consumption/backup-code tests remain passing; the
  challenge protocol was not redesigned. Attachments, VMD, message storage,
  timeline and fanout routing were not changed.
- Full frontend lint remains red: **152 errors**, all in untouched files.
  One pre-existing missing error-cause diagnostic in the touched timeout helper
  was corrected. Checked against `git show HEAD` and the lint file inventory.
- One Node 24 lint run segfaulted; Node 22 completed successfully. One Node 22
  Vite build failed parsing esbuild output; the final Node 20 build passed.
  These tool failures are recorded, not treated as passing runs or diagnosed as
  application defects. No dependency/environment-file changes were made.
- The pre-existing untracked root `package.json` is malformed. It was left alone;
  `--configLoader runner` avoids its known Vite config-bundling failure.
- Logs remain outside Git at `/tmp/void-lifecycle-lNOue7/`. This is not a live
  production penetration test or proof against every distributed failure.
- Isolated PostgreSQL/Valkey were stopped after verification. No test listeners
  remain on ports 15439, 16389, 14979 or 14019.

## Required deployment step (not performed)

**Do not merely restart an old build or roll out only one auth component.**

Migration 0014 introduces nullable `refresh_tokens.session_id` without backfill.
Legacy JWTs/rows cannot establish identity and intentionally require sign-in
again. Coordinate the API services, VOIDADMIN's compiled helper and Phoenix so
old issuers/validators do not overlap new session semantics. Apply the migration
before starting the new services, with the matching gateway subscriber available
for required revocation publication. Deploy the matching frontend as well.

The current device/session model is unchanged; `sid` identifies an individual
login generation and is not a new device limit. Production migration, process
reload, commit and push were not performed during this task.
