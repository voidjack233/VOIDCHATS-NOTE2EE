# Security hardening follow-up - 8 September 2026

Source audit: [security-audit-2026-09-06.md](security-audit-2026-09-06.md),
reviewed base `c68776cee7536b7ce49286cf08669fb296544a89`.
At the validation checkpoint, these changes were not yet committed or deployed. This is
targeted remediation and regression validation, not a production penetration test.

## Application findings

| Finding | Implemented change | Validation and limits |
| --- | --- | --- |
| F01: link-preview SSRF | Binary address policy rejects private/reserved addresses, including dotted and hexadecimal IPv4-mapped IPv6. Existing DNS pinning and redirect checks remain. | Address, DNS-answer and redirect regression tests. No live internal endpoint probing. |
| F02: push destinations/work | Supported provider allowlist, bounded keys/endpoints, public-address DNS validation/pinning, normal TLS verification, no redirects, 10-second delivery deadline and 16 KiB response limit. Delivery has 8 active slots and 64 pending slots with a 10-second queue wait limit. Account/device quotas are 10/2; subscription ownership cannot be stolen. Subscribe/test endpoints are rate-limited. | Real isolated PostgreSQL quota/concurrency tests; intercepted HTTPS tests for private DNS, response limits and deadline. Observed maximum active work: 8. No real push was sent. Legacy oversized subscription collections are not migrated or deleted automatically. |
| F03: revoked session resurrection | Atomic Valkey validation/touch and revocation; creation updates the session and account index together. Cache recovery holds a PostgreSQL shared lock on the active refresh row through cache creation, coordinating with revocation updates. | Real isolated PostgreSQL/Valkey interleavings cover touch/revoke, revoke-all and recovery blocked behind revocation. |
| F04: pending gateway revocation | Register pending sockets before the second liveness check; verify the same session generation at IDENTIFY/RESUME. Pending sockets receive disconnect commands, but not normal account events or presence credit. Admission is capped atomically at 8 sockets per account per gateway process. Capacity closes with 1013, not an auth-failure code. | Registry/handler tests cover pending disconnect, revoked IDENTIFY/RESUME, replaced generations and retryable capacity rejection. Not a cross-replica global socket quota. |
| F05: password-change attempts | Reserve the existing account-sensitive-action budget before database acquisition or credential verification; add an IP budget and bound current-password input. Backup codes use the existing conditional consumption helper. | 20 simultaneous attempts: 5 reach the verification/database boundary, 15 return 429. Existing 2FA regression suite also passes. |
| F06: password-change invalidation | Ordinary and admin password changes invalidate refresh tokens and reset links transactionally, then invalidate cache/gateway access. Ordinary changes explicitly issue a replacement current-device session. Login rechecks the password hash under lock; pending 2FA login is bound to that hash. | SQL invalidation and stale pending-login tests pass. Full deployed user/admin password-change workflows were not exercised. Post-commit infrastructure failures can return an error after the password changed; this is not distributed atomicity across PostgreSQL, Valkey and the gateway. |
| F07: inconsistent group permissions | Shared operation-specific decisions intersect audience restrictions and role switches. Profile, icon, nickname and invite routes use them; relevant web controls agree. Owners retain authority. Invite creation/approval remain admin/owner-only. | Helper matrix plus actual profile route test: owner-disabled admin edit returns 403 before mutation. |
| F08: cross-account chat cache/drafts | Account-specific IndexedDB stores, sender-scoped queue reads/writes, retiring old writers, stopped queue recovery, account-bound sync persistence and runtime-cache generations. Cross-tab account changes stop old writers. | Headless Chromium with real IndexedDB verifies shared-conversation isolation, late write rejection and delayed sync completion after switching accounts. Legacy global databases are not adopted into an account. |
| F09: spoofed security IP | Security identity uses Express `req.ip`, not raw CF/XFF. Repository proxy templates overwrite XFF and strip unverified CF identity. | Header-spoof helper tests pass. Actual Cloudflare ingress and deployed proxy trust configuration still need operator validation. |
| F10: unfriended DM interaction | Sending, attachment upload, typing and reactions require accepted friendship for a DM in addition to existing membership checks. Historical reads are unchanged. | Shared authorization tests and source tracing; no real account messages were sent. |

## Deployment and dependencies

- Both frontend Nginx templates include the same security headers at HTML/SPA locations that otherwise lose inherited headers. Baseline CSP blocks framing, objects and foreign base URLs. It is not a complete script/connect allowlist; that needs deployment-specific validation.
- The backup script sets `umask 077`. No backup/restore was executed.
- Go modules require 1.26.6; the VMD builder is pinned to the verified 1.26.6 image digest. Deployed binaries/images have not been rebuilt or restarted by this task.
- Compatible lockfile fixes were applied with `npm audit fix --ignore-scripts`; the frontend additionally needed its existing peer-resolution workaround, `--legacy-peer-deps`. No forced downgrades were applied.
- Final API audit: **6 affected package entries, 2 high and 4 moderate**. `adm-zip`/`cassandra-driver` remain; npm proposes a cassandra-driver downgrade to 4.2.0. `decode-uri-component`, `query-string`, `stream-json` and `minio` remain; npm proposes MinIO 7.1.3. These require a separate compatible dependency plan, not automatic acceptance of scanner suggestions. Entries include dependency parents and are not six proven application exploits.
- Final frontend and admin npm audits: **0 findings** each.
- Go `govulncheck`: VMD has **0 symbol-level findings**, with 2 imported-package and 23 module-level advisories not reported reachable from application calls. voidctl reports no vulnerabilities. These results do not scan container OS packages or prove every deployed binary safe.

## Exact verification

For backend integration tests, only the isolated PostgreSQL at 127.0.0.1:15439
and Valkey at 127.0.0.1:16389 were used. The group-route test now mocks MinIO
startup methods, and subsequent runs additionally fence MinIO to an unused port.
From `VOID0000-api`, each of the two test commands below used this prefix:

```bash
env PGHOST=127.0.0.1 PGPORT=15439 PGDATABASE=postgres PGUSER=void0000 PGPASSWORD=isolated-test VALKEY_HOST=127.0.0.1 VALKEY_PORT=16389 VALKEY_DB=0 MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=19099 MINIO_ACCESS_KEY=isolated-test MINIO_SECRET_KEY=isolated-test-storage-key
```

The prefix is not a production configuration. Provision isolated test services
before repeating these commands; do not substitute the application database.

| Working directory | Command after the prefix where specified | Result |
| --- | --- | --- |
| VOID0000-api | `node --import tsx --test --test-concurrency=1 scripts/tests/security/*.test.js scripts/tests/auth/tokenService.test.js` | 69 passed, 0 failed |
| VOID0000-api | `node --import tsx --test --test-concurrency=1 scripts/tests/attachments/*.test.js` | 152 passed, 0 failed |
| VOID0000-www | `node --import tsx --test scripts/tests/auth/*.test.ts scripts/tests/chats/*.test.ts scripts/tests/messages/*.test.ts` | 105 passed, 0 failed |
| VOID0000-www | `node --test scripts/tests/auth/chatAccountIsolation.test.mjs` | 1 passed, real browser IndexedDB, no external application requests |
| Repository root | `node --test scripts/tests/security/nginxHeaders.test.mjs` | 2 passed, isolated real Nginx |
| VOID0000-api | `npm run typecheck` | Passed |
| VOID0000-api | `npm run lint -- --quiet` | Passed |
| VOID0000-api | `npm run build` | Passed |
| VOID0000-www | `npm run build -- --configLoader runner` | TypeScript and Vite build passed |
| VOID0000-api | `go test -race ./vmd ./scripts/tests/vmd-go` | Passed (cached results on final repeat) |
| voidctl | `go test ./...` | Passed (cached results on final repeat) |
| VOID0000-api | `govulncheck ./vmd/...` | No symbol-level findings; caveat above |
| voidctl | `govulncheck ./...` | No findings |
| VOIDADMIN | `node --check server.js` | Passed |
| Repository root | `bash -n scripts/backup-voidapp.sh` | Passed |
| Repository root | `git diff --check` | Passed |

Gateway command, from `VOID0000-api/void_gateway`:

```bash
env ASDF_ELIXIR_VERSION=1.17.3-otp-27 VALKEY_HOST=127.0.0.1 VALKEY_PORT=16389 VALKEY_DB=0 GATEWAY_HOST=127.0.0.1 GATEWAY_PORT=14019 ACCESS_SECRET=isolated-security-test-access-secret-1234567890 SECRET_KEY_BASE=isolated-security-test-phoenix-secret-key-base-123456789012345678901234567890 mix test
```

Result: **12 tests, 0 failures**. Formatting checks passed on the five changed
gateway source/test files. Total of the enumerated Node/browser/gateway/Nginx
suites: **341 tests passed**, plus the Go suites.

Final npm scans in each Node project used
`npm audit --package-lock-only --ignore-scripts --json`.
API exits 1 because the six documented entries remain; frontend/admin exit 0.

## Operational notes and remaining verification

- The pre-existing untracked root `package.json` contains a stray `s` after its JSON object. Normal Vite config bundling fails on it. It was left unchanged; the runner config loader provided a successful build without editing that unrelated file.
- Admin password replacement now imports the API's compiled credential-invalidation helper. The API build must exist alongside VOIDADMIN before using that operation.
- Logout/account change deliberately discards outgoing-account cache and unsent queued messages. Old global data has no trustworthy owner and is not imported. A legacy open tab can delay IndexedDB deletion; updated clients never read those legacy stores.
- Current tests are isolated component/integration checks, not a full authenticated production-browser regression pass. Real browser password changes, admin recovery, push-provider delivery and deployed proxy/client-IP attribution remain smoke-test items.
- **Test-isolation incident:** an early group-route test imported MinIO's existing startup initialization and reapplied the configured live bucket policies (public avatar buckets, private chat attachments). This was unintended and disclosed during the task. No attachment objects were uploaded/deleted. The test now mocks those calls; subsequent runs use the unused MinIO port as an additional boundary.
- No database migration, environment-file edit, PM2 reconfiguration or deployment was performed during the security validation. Commit/push and production builds are a separate follow-up. Test PostgreSQL/Valkey instances were stopped after verification; logs remain under `/tmp/void-security-tests-yPtoLM/`, outside Git.
