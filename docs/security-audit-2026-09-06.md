**Security audit — 6 September 2026**

Reviewed commit: `c68776cee7536b7ce49286cf08669fb296544a89`. Review and dependency queries ran on 5–6 September 2026. Application source and configuration were not changed. The pre-existing untracked root `package.json` was left untouched.

The review identified **10 application findings: one High and nine Medium**. Fix the link-preview SSRF first, then address revocation, password changes, and account isolation. Severity reflects the prerequisites described below; dependency scanner severities are listed separately.

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| F01 | High | Link previews reach private IPv4 addresses through IPv6 notation | Actual route with isolated loopback HTTP server |
| F02 | Medium | Push subscriptions permit arbitrary HTTPS destinations and unbounded delivery work | Actual subscription/delivery functions with mocked database and intercepted transport |
| F03 | Medium | In-flight session validation can restore a revoked session | Actual session store with controlled mock interleaving |
| F04 | Medium | Gateway revocation misses connections awaiting identification | Actual handler/registry/dispatcher with stubbed I/O |
| F05 | Medium | Password-change password and 2FA attempts have no attempt budget | Actual handler with mocked verification and database |
| F06 | Medium | Password changes leave old sessions and reset links valid | Source tracing and successful mocked password change |
| F07 | Medium | Group permission switches disagree with API authorization | Source tracing and four assertions against permission helpers |
| F08 | Medium | Switching accounts can expose another account's unsent draft | Actual queue-loading hook and reconciliation with synthetic records |
| F09 | Medium | Caller-supplied forwarding headers control security IP identity | Actual IP helper with synthetic requests |
| F10 | Medium | Former friends can continue sending through an existing DM | Source tracing across unfriend, DM admission, and message send |

**F01 — High: IPv4-mapped IPv6 bypasses link-preview private-address checks**

Location: [linkPreview/index.ts](../VOID0000-api/server/routes/linkPreview/index.ts), lines 151–182, 197–225, 732–735. Authentication and the per-user preview limiter are applied in [account-server.ts](../VOID0000-api/server/entrypoints/account-server.ts), line 164.

`isPrivateIPv6()` recognizes an IPv4-mapped address only when the suffix after `::ffff:` is dotted IPv4. The URL parser normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`; that hexadecimal suffix is not recognized as IPv4, and the function classifies the address as public. The subsequent request correctly pins the validated address, but it pins a private destination that passed faulty validation.

An authenticated user can cause HTTP(S) requests to loopback and private IPv4 destinations reachable from the account service. HTML titles and preview metadata can be returned to the requester. Other targets can still receive GET requests, although the endpoint does not return arbitrary raw response bodies. The exact impact depends on reachable internal services.

Validation used a temporary HTTP server bound only to `127.0.0.1` on an automatically assigned port and invoked the actual preview route. No existing service was contacted:

```text
127.0.0.1          -> HTTP 400, Blocked preview host
[::ffff:7f00:1]    -> HTTP 200, title=isolated-audit-loopback-marker
```

Fix: parse addresses into their binary form, normalize IPv4-mapped IPv6 to IPv4, and apply a comprehensive public-address policy. Retain DNS pinning and validation on every redirect. Add regression coverage for dotted and hexadecimal mapped addresses, private DNS answers, and redirects to those addresses.

**F02 — Medium: unrestricted push endpoints and delivery work**

Location: [webPush.ts](../VOID0000-api/server/notifications/webPush.ts), lines 73–89, 183–185, 228–249; [notifications/index.ts](../VOID0000-api/server/routes/notifications/index.ts), lines 20–37 and 77–88. The mount at account-server.ts:163 has authentication but no notification-specific limiter.

Subscription validation checks only that the endpoint and key fields are nonempty strings. An authenticated user can register a destination of their choosing and trigger delivery with `/api/notifications/test`. There is no provider allowlist, private-address rejection, subscription quota, or bounded delivery concurrency. `sendNotification()` receives no timeout. The installed transport also accumulates response text without an application-enforced size limit.

This provides a restricted SSRF path and an availability risk when push is configured. Requests use HTTPS, POST, and an encrypted push payload; normal TLS verification remains enabled, and raw responses are not exposed through the test API. This finding does not establish arbitrary HTTP access or a TLS bypass. Many subscriptions or slow/large responses from an attacker-controlled HTTPS server can consume server resources.

With generated test-only VAPID/subscription keys, a mocked database accepted `https://127.0.0.1:8443/audit`; interception of `https.request` observed `{hostname:"127.0.0.1", port:"8443", method:"POST", timeout:null}`. No network request was sent. The local API environment has push configured; the Compose environment does not. No secret values were recorded.

Fix: permit explicitly supported push-provider destinations, validate endpoint and key sizes, prevent private-address connections at delivery time, and enforce per-account/device quotas. Add delivery deadlines, bounded response handling and concurrency, and subscribe/test rate limits.

**F03 — Medium: session validation can recreate revoked sessions**

Location: [sessionService.ts](../VOID0000-api/server/auth/services/sessionService.ts), lines 79–91, 101–104, 115–122 and 158–167; [authenticateUser.ts](../VOID0000-api/server/auth/middleware/authenticateUser.ts), lines 54–79.

`validate()` and `touch()` read the session and later write it with an unconditional `SET`. A concurrent revocation can delete the key between these operations, after which validation recreates it with a 30-day TTL. The session is also removed from the account's session index, so the recreated entry can escape later enumeration-based revocation. Authentication trusts an existing cache entry without checking the revoked refresh-token row.

The prerequisite is an authenticated request overlapping logout, remote session revocation, or password reset. Subsequent access requests with the old access token can remain authorized until that token expires, at most approximately 15 minutes. The 30-day cache TTL does not by itself make the old JWT or revoked refresh token valid for 30 days.

Controlled mock interleaving of the actual store produced: read old session → revoke deletes key → resume validation → key exists again.

Fix: make validation/touch and liveness updates atomic, conditional on the same still-valid session generation. Coordinate session creation/recovery and revocation so the SQL-to-cache recovery path cannot recreate a session from an observation made before revocation. Test validation, touch, recovery, logout, and revoke-all interleavings.

**F04 — Medium: pending gateway connections miss revocation**

Location: [socket_auth.ex](../VOID0000-api/void_gateway/lib/void_gateway/socket_auth.ex), lines 29–36 and 91–108; [socket_handler.ex](../VOID0000-api/void_gateway/lib/void_gateway_web/handlers/socket_handler.ex), lines 101–117, 282–288 and 472–478; [event_dispatcher.ex](../VOID0000-api/void_gateway/lib/void_gateway/event_dispatcher.ex), lines 80–82 and 173–179; [logout.ts](../VOID0000-api/server/auth/routes/logout.ts), lines 125–127.

The gateway checks session liveness during WebSocket upgrade. A connection waiting for IDENTIFY/RESUME remains outside the connection registry. Revocation deletes the session and broadcasts a disconnect to registered sockets only. A pending connection can miss that command, identify afterward, and start receiving account events without another authoritative session check. Heartbeats do not close this gap.

Someone controlling an authenticated connection must upgrade before revocation and identify afterward within the 10-second identification deadline. The resulting connection can receive later events until the original access-token expiry, potentially almost 15 minutes. Token expiry is still enforced.

An isolated execution of the actual handler, registry, and dispatcher demonstrated that a pending socket missed a disconnect command, subsequently received READY, and then received a synthetic `MESSAGE_CREATE`. Presence, serialization, and storage I/O were stubbed.

Fix: make pending connections visible to revocation before checking session liveness again, then allow identification/event delivery only for a valid session generation. Cover both IDENTIFY and RESUME and clean up pending connections on termination. A liveness check performed only before registration still leaves a smaller race.

**F05 — Medium: no attempt budget on password changes**

Location: [change-password.ts](../VOID0000-api/server/auth/routes/change-password.ts), lines 27, 122–155 and 183–190; [auth/routes/index.ts](../VOID0000-api/server/auth/routes/index.ts), password-change mount; account-server.ts:124–131.

The password-change route authenticates and checks CSRF but has no account-scoped attempt reservation or rate limiter. Wrong passwords and wrong TOTP/email codes return distinguishable responses without consuming a security-attempt budget. The other sensitive 2FA action routes have an attempt-budget service, but this route does not use it. TOTP/email verification precedes current-password verification.

An attacker already holding a valid session can repeatedly guess the additional credentials required to change the password. For accounts without 2FA, repeated password verification also performs expensive Argon2 work while a database transaction is open. This does not establish an unauthenticated password-change bypass.

With database and cryptographic checks mocked, 20 consecutive wrong-password requests and 20 consecutive wrong-TOTP requests all reached verification and returned 401; none returned 429. Middleware mounts were separately inspected to confirm no outer password-change limiter.

Fix: atomically reserve an account-scoped attempt before any password or 2FA verification, use the existing sensitive-action limit service, and bound source-level traffic. Reject excessive attempts before opening a transaction or performing Argon2 work. Test failed password, TOTP, email, and backup-code attempts, including concurrency.

**F06 — Medium: password changes preserve old access paths**

Location: [change-password.ts](../VOID0000-api/server/auth/routes/change-password.ts), lines 194–207; [VOIDADMIN/server.js](../VOIDADMIN/server.js), lines 320–348. Compare the more complete recovery flow in [reset-password.ts](../VOID0000-api/server/auth/routes/reset-password.ts), lines 62–83.

User-initiated and admin-initiated password changes only replace `users.password_hash`. They do not revoke refresh tokens, clear session records, disconnect gateways, or invalidate outstanding password-reset links. A previously stolen session therefore survives a password change and can continue refreshing. An outstanding reset link can also overwrite the new password while the link remains valid, normally up to one hour.

This matters when a user or operator changes a password to recover from suspected compromise. The separate forgotten-password reset endpoint already revokes sessions and deletes reset records; the finding concerns the ordinary password-change and admin-edit paths.

A successful mocked execution of the ordinary change handler updated the password and returned 200 without issuing any refresh-token or reset-token invalidation. Source tracing confirms the admin path has the same omission.

Fix: centralize credential-change invalidation. Revoke other sessions, or all sessions for operator recovery, clear reset links and relevant pending security challenges, invalidate caches, and disconnect affected sockets. If preserving the current session, rotate it explicitly. Apply the same procedure to admin password replacement.

**F07 — Medium: stored group permissions do not consistently control mutations**

Location: [PermissionsTab.tsx](../VOID0000-www/src/components/Chat/Groups/ConversationSettings/PermissionsTab.tsx), lines 318–325; [root/update.ts](../VOID0000-api/server/routes/conversations/root/update.ts), lines 34–37; [root/icon.ts](../VOID0000-api/server/routes/conversations/root/icon.ts), lines 63–65 and 154–156; [conversationNickname.ts](../VOID0000-api/server/routes/conversations/members/conversationNickname.ts), lines 50–59; [groupPermissions.ts](../VOID0000-api/server/utils/groupPermissions.ts), lines 10–22.

The owner UI exposes admin switches for editing the group profile and member nicknames. Turning them off saves `admin_can_edit_group_profile:false` and `admin_can_edit_member_nicknames:false`. The mutation routes instead check only the corresponding `who_can_*` fields, which default to `admins`. An admin can therefore still rename the group, replace/remove its icon, or edit other members' nicknames after the owner disables those switches.

The inverse inconsistency exists in [invites.ts](../VOID0000-api/server/routes/conversations/invites.ts), lines 206 and 298: invite creation/approval checks only admin booleans and ignores the audience restrictions accepted by permissions.ts:67–89. Those invitation audience fields currently have no visible UI controls, so the profile/nickname case is the clearest user-facing reproduction.

Four offline assertions against the actual permission helpers confirmed both kinds of disagreement. Fix: use one operation-specific permission decision across API and UI; explicitly define how audience restrictions and admin switches combine. Add route-level tests proving owner-disabled operations return 403 for admins.

**F08 — Medium: retained queued messages leak drafts across accounts**

Location: [queuedSendStore.ts](../VOID0000-www/src/Services/Chat/queuedSendStore.ts), lines 8, 43–45 and 86–93; [authService.ts](../VOID0000-www/src/Services/Auth/services/authService.ts), lines 137–141; [useMessageListRealtime.ts](../VOID0000-www/src/Services/hooks/Chats/MessageList/useMessageListRealtime.ts), lines 67–93.

Queued messages are stored in a global IndexedDB database keyed by conversation and local message ID. Logout clears localStorage/sessionStorage but leaves IndexedDB. The queue-loading hook reads all queued records for the conversation and displays their text without requiring `record.sender_id` to match the signed-in account.

If account A leaves an unsent queued message, logs out, and account B signs into the same browser profile and opens the same shared conversation, B can see A's private unsent text. This requires a shared browser profile and conversation; it is not remote cross-account database access. Ordinary cached messages also remain readable locally in the global `void_messages` store after logout.

The actual hook and reconciliation logic, executed with a synthetic queue, placed A's draft into B's visible messages. Automatic queued-send recovery already filters by sender at queuedSendRecovery.ts:294–295; normal automatic cross-account resending was not demonstrated.

Fix: partition both stores and their read APIs by account, enforce sender ownership when loading queued records, and purge outgoing-account data on logout/session invalidation after stopping writers. Test account switches with pending sends and shared conversations.

**F09 — Medium: security IP identity trusts unverified headers**

Location: [securityUtils.ts](../VOID0000-api/server/utils/securityUtils.ts), lines 41–47; [deploy/nginx/default.conf.template](../deploy/nginx/default.conf.template), line 32; [rateLimits/policies.ts](../VOID0000-api/server/middleware/rateLimits/policies.ts), IP-scoped login/reset/register/captcha limits.

`getClientIP()` takes `CF-Connecting-IP` or the first `X-Forwarded-For` value before considering Express's trust-aware `req.ip`. The supplied Nginx configuration appends to X-Forwarded-For and does not remove arbitrary CF-Connecting-IP. On a deployment path where a trusted upstream does not overwrite those headers, the caller can choose their rate-limit and security-log IP identity.

Synthetic requests with the same socket and `req.ip` value produced three different security identities when the headers changed. This undermines IP-wide throttling and log attribution, including captcha limits. Login also has subject and device limits; changing the IP alone does not bypass all login throttles. An exclusively enforced Cloudflare path that overwrites these headers may mitigate this deployment-specific exposure.

Fix: use `req.ip` with an explicitly constrained proxy trust configuration. Normalize forwarding headers at the first trusted edge, and accept Cloudflare identity only on a verified Cloudflare ingress path. Express documents the trust-chain and header-overwrite requirements in its [proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

**F10 — Medium: existing DMs bypass the friendship requirement after removal**

Location: [friends/remove.ts](../VOID0000-api/server/routes/friends/remove.ts), lines 10–18 and 35–40; [conversations/dm.ts](../VOID0000-api/server/routes/conversations/dm.ts), lines 41–53; [messages/sendMessage.ts](../VOID0000-api/server/routes/conversations/messages/sendMessage.ts), lines 224–232 and 469–484.

DM admission explicitly checks accepted friendship for existing as well as new conversations and returns “You can only DM friends.” Unfriending deletes the accepted friendship but only sets the existing conversation memberships to hidden. The actual message-send path checks membership and viewer role, without checking that a DM friendship is still accepted.

A former friend retaining the conversation ID can continue sending directly to the existing message endpoint after removal. Accepted sends are stored and fan out through `MESSAGE_CREATE`; push dispatch is also attempted subject to notification configuration/preferences. This bypasses the application's stated contact policy; it does not require access to an unrelated conversation.

Evidence is source tracing; no messages were sent to a live account. Fix: enforce current accepted friendship in the shared DM send authorization path and any attachment-upload or interaction paths that should stop on removal. Define historical-read retention separately from permission to send new messages.

**Dependency results and reachability**

Commands used: `npm audit --package-lock-only --ignore-scripts --json` in each Node application; `govulncheck ./vmd/...` in the API Go module and `govulncheck ./...` in `voidctl`.

| Lockfile | High | Moderate | Low | Total affected package entries |
| --- | ---: | ---: | ---: | ---: |
| VOID0000-api | 4 | 6 | 1 | 11 |
| VOID0000-www | 6 | 2 | 0 | 8 |
| VOIDADMIN | 0 | 1 | 1 | 2 |

These counts include parent packages affected by their dependencies and development/build tools. They are not counts of independently exploitable application vulnerabilities. No critical npm advisory was reported.

- API `fast-xml-parser` is locked to 5.10.0, within the range of an entity-expansion denial-of-service advisory fixed in 5.10.1. Exposure through the MinIO client requires control of XML responses; direct user-controlled XML parsing was not established. Update the dependency through a compatible lockfile refresh. [Maintainer advisory](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-8r6m-32jq-jx6q).
- API `adm-zip` 0.5.16 is pulled in through cassandra-driver. Its ZIP-processing path is used for a cloud secure-connect bundle; this app configures direct Scylla contact points. No user-upload-to-ZIP-parser path was found. The scanner's suggested cassandra-driver downgrade is not an appropriate automatic fix without compatibility review.
- Frontend React Router 7.18.1 is flagged for an RSC CSRF issue. This app uses client-side `BrowserRouter`, and no unstable RSC APIs were found. The maintainer explicitly limits the advisory to those APIs. Upgrade the package, but do not present that advisory as a confirmed CSRF vulnerability in this app. [Maintainer advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2).
- Other entries include body-parser, qs, MinIO transitive parsers, and frontend/lint/build dependencies. For example, the body-parser advisory concerns invalid size-limit configuration; the inspected application uses valid limits. Review each advisory against its actual input path before assigning application impact.

`govulncheck` reported six standard-library symbol-level advisories for VMD and four for voidctl using local Go 1.26.5. Reported fixes are in Go 1.26.6. VMD's Dockerfile instead pins the older Go 1.26.0 builder; the local scan does not describe the complete vulnerability set of a deployed image. Update the build toolchain and pinned image/digest, rebuild binaries, and repeat the scans. The XML recursion issue is recorded in the [Go vulnerability database](https://pkg.go.dev/vuln/GO-2026-6088). Symbol reachability does not establish all exploit prerequisites: for example, the flagged HTTP/2 timeout issue requires unencrypted HTTP/2, which the inspected VMD server does not enable. [Go advisory](https://pkg.go.dev/vuln/GO-2026-6089).

In the Phoenix project, `env ASDF_ELIXIR_VERSION=1.17.3-otp-27 mix hex.audit` completed successfully with “No retired packages found.” The installed Hex 2.4.1 command checks retirement status; this result is not a complete vulnerability/advisory scan. No dependencies were installed or updated.

**Additional deployment and availability observations**

- The Compose edge template sets security headers at server level, but `/index.html` and SPA locations set their own `add_header Cache-Control`. Under the pinned Nginx version, those locations lose inherited security headers. The template also lacks a document CSP. The standalone frontend container template lacks these protections entirely. Put the intended headers, including frame protection and CSP, on the actual HTML responses using shared includes compatible with the pinned Nginx version. The newer `add_header_inherit merge` directive requires Nginx 1.29.3, newer than this repository's 1.28.0 image. This was a configuration review, not a live-header or clickjacking test. [Nginx inheritance documentation](https://nginx.org/en/docs/http/ngx_http_headers_module.html).
- Phoenix's connection registry replaces matching client-instance IDs but imposes no per-user maximum. An isolated registry accepted 12 simultaneous synthetic processes for one user/device. Each additional socket increases fanout and buffering work. Add atomic admission limits for pending and identified connections and appropriate frame budgets. Service exhaustion was not attempted.
- The backup script creates sensitive backup directories and archives without setting a restrictive umask. Their accessibility depends on the caller's umask and parent-directory permissions. Set `umask 077` before creating backup output and protect the destination. No real backup or restore was run.

**Validation, scope, and limits**

Selected existing tests passed: **27 passed, 0 failed**. They cover token claim validation, admin configuration, signed VMD capability generation, and attachment content/delivery policy:

```bash
cd VOID0000-api
node --import tsx --test --test-concurrency=1 \
  scripts/tests/auth/tokenService.test.js \
  scripts/tests/security/adminConfig.test.js \
  scripts/tests/vmd/capability.test.js \
  scripts/tests/attachments/attachmentContentPolicy.test.js
```

Custom checks used actual source functions with isolated mocks, except F01, which additionally used a temporary loopback server owned by the audit. No production account, database, object store, message stream, or external application endpoint was probed. No denial-of-service load was generated. Database-dependent integration tests were not run against the configured local services.

Reviewed areas include authentication/password/2FA/session routes, group and DM authorization, attachment delivery and VMD capabilities, client rendering and persistence, gateway admission and revocation, admin configuration, deployment templates, and Node/Go dependencies. This was a source-based audit with targeted validation, not a complete production penetration test. Container operating-system packages, deployed binaries, actual tunnel/firewall configuration, and full Git-history secret scanning were outside validation coverage.

Controls that held in the reviewed paths include Argon2id password hashing, short-lived access tokens and hashed refresh-token storage, explicit secret validation, owner-only permission updates, private attachment routing with content-disposition controls, and HMAC-bound media capabilities. No direct raw-HTML XSS sink or VMD signature bypass was confirmed. Current API/deployment secret files are ignored by Git and have mode 0600; secret values were not copied into the report. The project explicitly documents service-readable messages, so the absence of end-to-end encryption was not treated as an undisclosed defect.
