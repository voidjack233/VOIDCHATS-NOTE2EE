# Deployment validation checklist

Status: **not executed against a deployed environment by this cleanup**.
Local tests are not a penetration test or a production-readiness certificate.
Use this checklist with an operator-approved target and dedicated test accounts.
Record the deployed revision, host, timestamp, expected result, actual result and
redacted evidence for every item. Never include cookies, JWTs, credentials or
private message bodies in tracked reports.

## Release and database gate

- [ ] Identify the actual target: bare-metal PM2 or containers, database/keyspace,
  MinIO data root, Valkey instance, proxy chain and public hostnames. Do not assume
  a successful local build changed any running process.
- [ ] Take a verified, off-host backup before schema/credential changes. Record
  checksums and a rollback plan that preserves immutable-session enforcement.
- [ ] Confirm `0014_immutable_session_identity.sql` is recorded with the repository
  checksum in `schema_migrations`, and inspect the actual `refresh_tokens.session_id`
  UUID column and unique partial index `refresh_tokens_session_id_idx`. Run
  `npm run migrate:status` from `VOID0000-api` with the approved target configuration;
  status checking is not permission to apply migrations.
- [ ] Do not backfill legacy session IDs. Existing NULL session IDs must remain
  unable to authorize old tokens. This cleanup does not change migration semantics.
- [ ] Build and coordinate API, VOIDADMIN, Phoenix gateway and frontend rollout
  from the same reviewed release. Drain/gate authentication traffic while replacing
  incompatible old instances; do not leave an old gateway or API accepting legacy
  tokens. Verify all replicas, process paths, artifact hashes and readiness afterward.
- [ ] For bare metal, verify the API process uses the intended built `dist` and
  the gateway uses the intended release/build. A restart alone does not build code.
  For containers, verify immutable image digests and migration ordering instead.
- [ ] Publish matching frontend HTML/chunks, verify deep-route reloads and cache
  behavior, and ensure stale clients fail closed and can reach login.
- [ ] Confirm a pre-rollout token without `sid` is denied over HTTP and WebSocket,
  the browser resolves to login rather than looping refresh, and a fresh login works.

## Proxy, transport and exposure

- [ ] Enumerate each hop: browser, CDN/tunnel/load balancer, reverse proxy, service.
  Check effective `TRUST_PROXY` against those actual hops. Never trust client-supplied
  forwarding headers just because they exist. Confirm trusted proxies replace or
  sanitize forwarding headers and direct-origin access cannot spoof the client IP.
- [ ] Use an approved test account to compare rate-limit/client-IP behavior for two
  clients. Supplying forged forwarding headers must not create a new rate-limit
  identity or bypass restrictions. Include the admin interface in this check.
- [ ] Check certificates, hostname/chain, expiry and renewal; verify TLS 1.2/1.3
  negotiation and rejection of SSL/obsolete TLS on the public endpoints. Check
  origin transport separately: HTTP on same-host loopback is not a claim of TLS
  between hosts. Verify encryption/authentication on any cross-host link.
- [ ] Confirm HTTP-to-HTTPS redirect and actual HSTS, CSP, `nosniff`, frame,
  referrer and permissions headers on HTML, deep-route fallback, assets and error
  responses. Ensure CSP permits only the configured API/CDN/VMD/WebSocket origins.
  Local Nginx template tests do not prove deployed edge headers.
- [ ] Verify Secure/HttpOnly/SameSite cookie behavior, allowed origins and CSRF
  rejection through the real proxy. No session/token responses should be shared-cacheable.
- [ ] Inventory listeners with `ss -ltnup` on the host and verify reachability from
  an external authorized machine, including IPv6 and direct origin IPs. Only
  intended public endpoints should be exposed; admin, diagnostics and development
  servers must not be publicly accessible without their intended restrictions.
- [ ] Confirm PostgreSQL, Scylla, Valkey, MinIO administration, internal API/gateway
  control ports and sanitizer/transform IPC are bound/firewalled to their intended
  private network or local access. Check Docker-published ports as well as host
  firewall rules. Do not assume a private hostname makes a listener private.
- [ ] Verify anonymous MinIO private-bucket reads/listing/writes are denied. CDN/VMD
  public endpoints must retain their signed-capability requirements. Confirm object
  storage credentials and Unix socket permissions are restricted to intended services.

## Session and credential lifecycle

- [ ] With two separate browser sessions, logout/revoke one session: its protected
  HTTP calls, refresh and existing WebSocket must stop working; the other session
  should retain exactly the access allowed by the selected revocation operation.
- [ ] Logout-everywhere/revoke-all must deny every old session and close its sockets.
  In an isolated staging exercise, repeat with missing/incomplete Valkey session
  indexes; PostgreSQL must remain the authoritative revocation inventory.
- [ ] Replace a login on the same device and replay the prior access token: it must
  not adopt the replacement `sid`. Old expiry/disconnect commands must not affect
  the replacement session. Verify both HTTP and gateway behavior.
- [ ] Change password, reset via the normal reset flow, and reset via VOIDADMIN.
  Verify old credentials/tokens are denied, old sockets disconnect, and any intended
  replacement session uses the correct new identity. Do not record reset secrets.
- [ ] In staging, remove required invalidation/publication availability and repeat
  the credential operation. It must fail visibly rather than claim successful
  invalidation. Verify documented fail-closed partial-failure behavior and recovery.
  Do not stop production Valkey/gateway to perform this test without separate approval.
- [ ] Exercise refresh in two tabs, an expired access token with a valid refresh,
  invalid refresh, and gateway reconnect/resume. Verify bounded retries, no startup
  request storm, and no revoked-session resurrection after cache or pub/sub recovery.
- [ ] Queue a send under account A, switch to B while CSRF/refresh is pending, and
  verify the old operation cannot send as B. Repeat A -> B -> A and logout. Inspect
  requests without capturing reusable credentials.

## Data recovery and functional smoke tests

- [ ] Restore PostgreSQL, Scylla and MinIO into an isolated target using the actual
  deployed schemas/bucket names, not historical examples copied blindly from docs.
  Verify attachment mappings, object checksums/metadata, memberships and sampled
  history agree across the restored stores. Measure recovery time and data loss window.
- [ ] Ensure restoring session/cache data cannot resurrect revoked credentials.
  Agree on deliberate re-login/invalidation before promoting a restored environment.
  A backup command succeeding is not evidence that restoration works.
- [ ] Login, email verification/reset and enabled 2FA methods work for dedicated
  accounts; invalid credentials and unauthorized requests are rejected cleanly.
- [ ] Two accounts exchange DM/group messages in both directions, including after
  reconnect. Verify immediate, exactly-once display, persisted history and denial
  of an unrelated/non-member conversation subscription.
- [ ] Upload an image and a permitted file; send, reopen and download. Verify staged
  cancel/cleanup, sanitizer rejection, immutable edit attachments, signed original
  delivery and VMD fallback/expiry using native browser image requests.
- [ ] Verify push permission/subscription, delivery to an eligible inactive device,
  unsubscribe and logout behavior. Confirm active/private content is not leaked to
  the wrong account/device.
- [ ] Verify WebSocket disconnect/reconnect, presence recovery, message history
  reconciliation and no duplicate messages or refresh loops after network loss.
- [ ] Observe errors, latency, queue saturation, restart counts and resource usage
  during the smoke test and agreed monitoring window. Redact sensitive logs.

## Sign-off

- [ ] Attach evidence for each completed item and explicitly mark failures or checks
  not run. Obtain operator approval before production fault injection or scanning.
- [ ] Record separate authorization/scope for any future live penetration test.
  Passing this checklist or the local regression suites does not constitute one.
