# Frontend readiness cleanup: 2026-09-12

Base: `fb705cbbbf4fc66056fa3a7ae85aad402156f6b5`, current main working tree.
**Partial lint cleanup, not a production-readiness or security certification.**

## Outcome and scope

Full frontend lint: **152 errors / 18 warnings -> 71 errors / 18 warnings**.
81 errors removed: 72 explicit-any uses, seven unused bindings and two error-handling
issues. No ESLint configuration, dependencies, global ignores or rule suppressions
changed. Historical source remains in the full lint scan.

Mechanical changes reuse existing User, Friend, Conversation, Message, reaction
and theme contracts rather than broad unchecked values. The 2FA response types
reflect the existing backend routes, including nullable backup codes and failed
responses; service method bodies, requests and authorization decisions are unchanged.
Existing legacy reaction arrays and optional friend `user_id` fallbacks remain.

Message-only catches now narrow unknown errors through `getErrorMessage`, retaining
both Error messages and plain JSON rejection messages with the same valid-message
text/fallbacks. Four new tests cover that distinction, missing/malformed messages,
API error property precedence and retry metadata. Avatar errors preserve their
original cause; profile-load cancellation no longer returns from finally and
therefore cannot suppress an exception. Upload MIME matching retains the same
allowlist/equality semantics.

No immutable-session, cookie, refresh, account-operation scope, queued-send
authorization, migration 0014, backend, admin or Phoenix implementation changed.
Frontend gateway change is only `send(data: unknown)` instead of `any`; the emitted
JSON, connection behavior and event routing are unchanged. Message-list/realtime
changes are type annotations only, not timeline/synchronization/pagination changes.

## Root package.json

The root file was already valid JSON on the first inspection of this working
tree: the reported stray trailing `s` was no longer present. It remains unchanged
and was already untracked. No dependencies or scripts were added/removed.

Its use is a root convenience wrapper:
`build -> build:api -> npm --prefix VOID0000-api run build`.
It does not replace the frontend's package scripts.

JSON.parse succeeds. The normal frontend `npm run build`
(`tsc -b && vite build`) succeeds with Vite's default config loader and
**without `--configLoader runner`**. No workaround was added.

## Lint classification by rule

The last column is warnings, not additional errors. Before/after warnings are
both 18 and all are `exhaustive-deps`.

| Alias and rule | Errors before | Errors after | Warnings after |
| --- | ---: | ---: | ---: |
| `any`: `@typescript-eslint/no-explicit-any` | 84 | 12 | 0 |
| `unused`: `@typescript-eslint/no-unused-vars` | 7 | 0 | 0 |
| `effect`: `react-hooks/set-state-in-effect` | 34 | 34 | 0 |
| `refs`: `react-hooks/refs` | 13 | 13 | 0 |
| `purity`: `react-hooks/purity` | 1 | 1 | 0 |
| `memo`: `react-hooks/preserve-manual-memoization` | 1 | 1 | 0 |
| `static`: `react-hooks/static-components` | 1 | 1 | 0 |
| `exports`: `react-refresh/only-export-components` | 9 | 9 | 0 |
| `deps`: `react-hooks/exhaustive-deps` | 0 | 0 | 18 |
| `cause`: `preserve-caught-error` | 1 | 0 | 0 |
| `finally`: `no-unsafe-finally` | 1 | 0 | 0 |

## Lint classification by file

Paths relative to `VOID0000-www`. Cause counts use the aliases above and count
errors only; the warning column identifies unchanged dependency warnings.
This includes every file reported before or after, including files with only warnings.

| File | Errors before -> after | Warnings before -> after | Causes before -> after |
| --- | ---: | ---: | --- |
| `history/frontend-mimicry/Auth.tsx` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/Services/Auth/UserContext.tsx` | 1 -> 1 | 0 -> 0 | exports:1 -> exports:1 |
| `src/Services/Auth/context/UserContext.tsx` | 2 -> 2 | 1 -> 1 | refs:1, exports:1 -> refs:1, exports:1 |
| `src/Services/Auth/hooks/use2FA.ts` | 6 -> 0 | 0 -> 0 | any:6 -> - |
| `src/Services/Auth/hooks/useEmailVerification.ts` | 1 -> 0 | 0 -> 0 | unused:1 -> - |
| `src/Services/Auth/hooks/useForgotPassword.ts` | 2 -> 2 | 0 -> 0 | any:1, effect:1 -> any:1, effect:1 |
| `src/Services/Auth/hooks/useLogin.ts` | 7 -> 5 | 0 -> 0 | any:4, purity:1, effect:2 -> any:2, purity:1, effect:2 |
| `src/Services/Auth/hooks/useResetPassword.ts` | 2 -> 1 | 0 -> 0 | effect:1, unused:1 -> effect:1 |
| `src/Services/Auth/services/authService.ts` | 8 -> 0 | 0 -> 0 | any:8 -> - |
| `src/Services/Auth/types.ts` | 1 -> 0 | 0 -> 0 | any:1 -> - |
| `src/Services/Chat/avatarFallback.ts` | 1 -> 0 | 0 -> 0 | unused:1 -> - |
| `src/Services/Chat/chatUtils.ts` | 3 -> 0 | 0 -> 0 | any:3 -> - |
| `src/Services/Gateway/gateway.ts` | 4 -> 3 | 0 -> 0 | any:4 -> any:3 |
| `src/Services/bootstrap.ts` | 7 -> 0 | 0 -> 0 | any:7 -> - |
| `src/Services/hooks/Chats/MessageList/useMessageListPagination.ts` | 1 -> 1 | 2 -> 2 | refs:1 -> refs:1 |
| `src/Services/hooks/Chats/MessageList/useMessageListReplies.ts` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/Services/hooks/Chats/useChatManager.ts` | 4 -> 0 | 0 -> 0 | any:3, unused:1 -> - |
| `src/Services/hooks/Chats/useConversationSync.ts` | 2 -> 0 | 0 -> 0 | any:2 -> - |
| `src/Services/hooks/Chats/useMessageDisplay.ts` | 3 -> 3 | 0 -> 0 | refs:3 -> refs:3 |
| `src/Services/hooks/Chats/useMessageInput.ts` | 3 -> 3 | 0 -> 0 | any:3 -> any:3 |
| `src/Services/hooks/Chats/useMessageStream.ts` | 4 -> 0 | 0 -> 0 | any:4 -> - |
| `src/Services/hooks/Chats/useReactions.ts` | 4 -> 0 | 1 -> 1 | any:4 -> - |
| `src/Services/hooks/Chats/useTypingIndicator.ts` | 2 -> 1 | 0 -> 0 | effect:1, any:1 -> effect:1 |
| `src/Services/hooks/Friends/useFriendRequests.tsx` | 1 -> 1 | 0 -> 0 | exports:1 -> exports:1 |
| `src/Services/hooks/Friends/useFriends.tsx` | 5 -> 3 | 0 -> 0 | memo:1, any:2, effect:1, exports:1 -> memo:1, effect:1, exports:1 |
| `src/Services/hooks/Friends/usePresence.tsx` | 2 -> 2 | 0 -> 0 | effect:1, exports:1 -> effect:1, exports:1 |
| `src/Services/hooks/Settings/useAccount.ts` | 1 -> 0 | 0 -> 0 | any:1 -> - |
| `src/Services/hooks/Settings/useActiveSessions.ts` | 4 -> 1 | 0 -> 0 | any:3, effect:1 -> effect:1 |
| `src/Services/hooks/Settings/useTheme.ts` | 3 -> 1 | 0 -> 0 | unused:2, effect:1 -> effect:1 |
| `src/Services/hooks/common/useConnectionStatus.ts` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/Services/hooks/profile/useProfileAvatarUpload.ts` | 3 -> 0 | 0 -> 0 | any:2, cause:1 -> - |
| `src/Services/hooks/profile/useProfileRecord.ts` | 4 -> 1 | 0 -> 0 | effect:1, any:2, finally:1 -> effect:1 |
| `src/components/Auth/CaptchaModal.tsx` | 2 -> 1 | 0 -> 0 | unused:1, effect:1 -> effect:1 |
| `src/components/Chat/Attachments/AttachmentAudioPlayer.tsx` | 1 -> 1 | 0 -> 0 | exports:1 -> exports:1 |
| `src/components/Chat/Attachments/AttachmentFileCard.tsx` | 1 -> 1 | 0 -> 0 | static:1 -> static:1 |
| `src/components/Chat/Composer/MessageInput.tsx` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/components/Chat/Conversation/ConversationList.tsx` | 8 -> 0 | 4 -> 4 | any:8 -> - |
| `src/components/Chat/Conversation/ForwardMessageModal.tsx` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/components/Chat/Groups/ConversationSettings/InvitesTab.tsx` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/components/Chat/Groups/ConversationSettings/PermissionsTab.tsx` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/components/Chat/Groups/GroupConversationSettings.tsx` | 2 -> 2 | 0 -> 0 | effect:2 -> effect:2 |
| `src/components/Chat/Groups/GroupCreateModal.tsx` | 1 -> 0 | 0 -> 0 | any:1 -> - |
| `src/components/Chat/Groups/useGroupSettings.ts` | 3 -> 3 | 1 -> 1 | effect:3 -> effect:3 |
| `src/components/Chat/Groups/useMobileView.ts` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/components/Chat/MessageView/MessageViewHeader.tsx` | 1 -> 1 | 0 -> 0 | exports:1 -> exports:1 |
| `src/components/Chat/MessageView/MessageViewV2.tsx` | 3 -> 0 | 1 -> 1 | any:3 -> - |
| `src/components/Chat/Messages/InviteEmbed.tsx` | 3 -> 3 | 0 -> 0 | effect:2, any:1 -> effect:2, any:1 |
| `src/components/Chat/Messages/LinkPreviewCard.tsx` | 2 -> 2 | 0 -> 0 | effect:2 -> effect:2 |
| `src/components/Chat/Messages/MessageItem.tsx` | 2 -> 0 | 2 -> 2 | any:2 -> - |
| `src/components/Chat/Messages/MessageOverlays.tsx` | 2 -> 1 | 0 -> 0 | any:1, effect:1 -> effect:1 |
| `src/components/Chat/Messages/useMessageActions.ts` | 4 -> 4 | 0 -> 0 | refs:4 -> refs:4 |
| `src/components/common/Friends/FriendsView.tsx` | 1 -> 1 | 0 -> 0 | effect:1 -> effect:1 |
| `src/components/common/Friends/IncomingRequests.tsx` | 0 -> 0 | 1 -> 1 | - -> - |
| `src/components/common/Profile/UserProfileHeader.tsx` | 2 -> 0 | 0 -> 0 | any:2 -> - |
| `src/components/common/Settings/2FA/TwoFactorModal.tsx` | 0 -> 0 | 1 -> 1 | - -> - |
| `src/components/common/Settings/ChangePassword/ChangePasswordModal.tsx` | 2 -> 1 | 0 -> 0 | any:1, effect:1 -> effect:1 |
| `src/components/common/Skeleton.tsx` | 2 -> 2 | 0 -> 0 | exports:2 -> exports:2 |
| `src/pages/Auth/Register.tsx` | 2 -> 1 | 0 -> 0 | any:2 -> any:1 |
| `src/pages/Chat/Chats.tsx` | 7 -> 7 | 3 -> 3 | effect:3, refs:4 -> effect:3, refs:4 |
| `src/pages/Invite.tsx` | 2 -> 1 | 1 -> 1 | any:2 -> any:1 |

## Intentionally unresolved

- **34 effect errors:** initial resets, fetched-state synchronization, composer,
  group/profile panels, connection state and invite/media UI. Moving updates out
  of effects or changing dependency sets can alter initialization, cached content,
  cancellation and conversation switching. Do not replace these with timers or
  blanket suppressions; verify each lifecycle before a dedicated change.
- **13 ref errors:** auth context, pagination, message display/actions and Chats.
  These involve render-time ref/snapshot access and callback ownership. Moving
  them blindly between render/effects risks stale handlers, authorization state
  or scroll restoration; the current scheduling is retained.
- **Nine Fast Refresh export errors:** mixed hooks/helpers/component exports,
  including shared context modules. These are module-boundary/HMR concerns, not
  evidence of a failing production build. Splitting context/provider exports
  needs an import/identity audit; it was not mixed into this mechanical pass.
- **One purity error:** login reads the clock while rendering its cooldown.
  Changing clock state/timers belongs with cooldown behavior tests, not this
  auth-behavior-preserving cleanup.
- **One memoization error:** friends provider's manual dependency list differs
  from the compiler's inferred dependencies. Removing memoization or changing
  user identity dependencies requires provider/cache lifecycle validation.
- **One static-component error:** AttachmentFileCard chooses a Lucide component
  using `getAttachmentIcon` during render. Inspection shows this selector returns
  imported component references, not newly defined component functions. The
  compiler warning is not proof of per-render component identity churn. No
  attachment renderer refactor or suppression was added just to remove it.
- **18 dependency warnings:** unchanged. Adding every inferred dependency could
  restart subscriptions, fetching or timers. They require per-hook lifecycle tests.
- **12 explicit-any errors:** the remaining dynamic gateway dispatch/envelope,
  login challenge/error payloads, invite error routing and send-error policy need
  their heterogeneous contracts validated rather than replacing `any` with
  unchecked casts or changing which malformed/error payloads take each branch.

Remaining explicit-any locations (current source lines):
- `src/Services/Auth/hooks/useForgotPassword.ts`: lines 48.
- `src/Services/Auth/hooks/useLogin.ts`: lines 69, 156.
- `src/Services/Gateway/gateway.ts`: lines 16, 181, 552.
- `src/Services/hooks/Chats/useMessageInput.ts`: lines 81, 95, 542.
- `src/components/Chat/Messages/InviteEmbed.tsx`: lines 180.
- `src/pages/Auth/Register.tsx`: lines 79.
- `src/pages/Invite.tsx`: lines 103.

Full lint therefore still exits 1. It must not be reported as green, nor should
these lint findings alone be presented as demonstrated security vulnerabilities.

## Verification

Final non-overlapping suites: **289 tests passed, zero failures/skips**:
165 frontend unit/regression tests, 13 browser/harness tests, 90 backend
auth/security tests, 19 gateway tests and two Nginx tests. The four new tests are
included in the 165, not counted a second time.

Node 22.22.0 was selected for lint/tests/API commands; Node 20.20.0 for the normal
frontend production build. Commands used a command-local PATH prefix, not edits
to environment files:

```bash
env PATH=/home/void0000/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin <command>
env PATH=/home/void0000/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin npm run build
```

Frontend commands, from `VOID0000-www`:

```bash
node --single-threaded --no-incremental-marking --max-old-space-size=4096 node_modules/eslint/bin/eslint.js . -f json -o /home/void0000/.local/share/void-readiness-20260912/lint-after.json
node node_modules/typescript/bin/tsc -b
npm run build
node --import tsx --test --test-concurrency=1 scripts/tests/auth/*.test.ts scripts/tests/chats/*.test.ts scripts/tests/messages/*.test.ts scripts/tests/messages/*.test.tsx scripts/tests/attachments/*.test.ts scripts/tests/presence/*.test.ts scripts/tests/performance/*.test.ts
node --test --test-concurrency=1 scripts/tests/auth/*.test.mjs scripts/tests/performance/*.test.mjs
```

Results: lint **71 errors / 18 warnings**; typecheck **pass**; default-loader
production build **pass** (Vite reports 12.69s); tests **165/165** and **13/13**.
The baseline was also rerun against a `git archive HEAD VOID0000-www` snapshot,
using the same installed dependencies/ESLint config and CLI flags, confirming
**152 errors / 18 warnings**.

API commands, from `VOID0000-api`:

```bash
npm run typecheck
npm run lint -- --quiet
npm run build
env PGHOST=127.0.0.1 PGPORT=15439 PGDATABASE=postgres PGUSER=void0000 PGPASSWORD=test VALKEY_HOST=127.0.0.1 VALKEY_PORT=16389 VALKEY_DB=0 MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=19099 MINIO_ACCESS_KEY=test MINIO_SECRET_KEY=test-storage-secret ACCESS_SECRET=isolated-lifecycle-access-secret-123456789 REFRESH_SECRET=isolated-lifecycle-refresh-secret-123456789 node --import tsx --test --test-concurrency=1 scripts/tests/auth/*.test.js scripts/tests/security/*.test.js
```

Results: typecheck, lint and build **pass**; tests **90/90**. The fixture uses
disposable PostgreSQL/Valkey on ports 15439/16389. Migration 0014 is applied only
to randomly named isolated test schemas, never to the production database.
MinIO is pointed at unused port 19099. The real admin subprocess is tested
against those isolated services and the fresh API build.

Gateway command, from `VOID0000-api/void_gateway`, run after backend tests finish:

```bash
env ASDF_ELIXIR_VERSION=1.17.3-otp-27 VALKEY_HOST=127.0.0.1 VALKEY_PORT=16389 VALKEY_DB=0 GATEWAY_HOST=127.0.0.1 GATEWAY_PORT=14019 ACCESS_SECRET=isolated-lifecycle-access-secret-123456789 SECRET_KEY_BASE=isolated-lifecycle-key-base-1234567890123456789012345678901234567890 mix test
```

Result: **19/19**, including session revocation and pub/sub failure checks.
Disposable PostgreSQL/Valkey services were stopped afterward.

Root commands:

```bash
node --test scripts/tests/security/*.test.mjs
node --check VOIDADMIN/server.js
node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync("package.json","utf8")));'
git diff --check
```

Results: Nginx **2/2**, admin syntax **pass**, root JSON **valid**, diff **clean**.
Go code/build configuration was unaffected, so Go suites were not repeated.

Initial lint attempts in the interrupted run crashed inside V8. The final full
before/after scans completed with the command-local V8 flags shown above;
no ESLint rules were weakened. A first Nginx test invocation omitted
`/usr/sbin` from PATH; rerunning with the correct binary search path passed.
The interruption removed temporary logs, so final suites/builds were rerun and
their output retained outside the repo at:

```text
/home/void0000/.local/share/void-readiness-20260912/
  lint-before.json
  lint-after.json
  frontend-typecheck.log
  frontend-build.log
  frontend-tests.log
  browser-tests.log
  api-typecheck.log
  api-lint.log
  api-build.log
  backend-tests.log
  gateway-tests.log
  nginx-tests.log
```

## Files changed

Modified production frontend files (mostly a few type/binding lines each):

```text
VOID0000-www/src/Services/Auth/hooks/use2FA.ts
VOID0000-www/src/Services/Auth/hooks/useEmailVerification.ts
VOID0000-www/src/Services/Auth/hooks/useLogin.ts
VOID0000-www/src/Services/Auth/hooks/useResetPassword.ts
VOID0000-www/src/Services/Auth/services/authService.ts
VOID0000-www/src/Services/Auth/types.ts
VOID0000-www/src/Services/Chat/avatarFallback.ts
VOID0000-www/src/Services/Chat/chatUtils.ts
VOID0000-www/src/Services/Gateway/gateway.ts
VOID0000-www/src/Services/bootstrap.ts
VOID0000-www/src/Services/hooks/Chats/useChatManager.ts
VOID0000-www/src/Services/hooks/Chats/useConversationSync.ts
VOID0000-www/src/Services/hooks/Chats/useMessageStream.ts
VOID0000-www/src/Services/hooks/Chats/useReactions.ts
VOID0000-www/src/Services/hooks/Chats/useTypingIndicator.ts
VOID0000-www/src/Services/hooks/Friends/useFriends.tsx
VOID0000-www/src/Services/hooks/Settings/useAccount.ts
VOID0000-www/src/Services/hooks/Settings/useActiveSessions.ts
VOID0000-www/src/Services/hooks/Settings/useTheme.ts
VOID0000-www/src/Services/hooks/profile/useProfileAvatarUpload.ts
VOID0000-www/src/Services/hooks/profile/useProfileRecord.ts
VOID0000-www/src/components/Auth/CaptchaModal.tsx
VOID0000-www/src/components/Chat/Conversation/ConversationList.tsx
VOID0000-www/src/components/Chat/Groups/GroupCreateModal.tsx
VOID0000-www/src/components/Chat/MessageView/MessageViewV2.tsx
VOID0000-www/src/components/Chat/Messages/MessageItem.tsx
VOID0000-www/src/components/Chat/Messages/MessageOverlays.tsx
VOID0000-www/src/components/Chat/Messages/ReactionBar.tsx
VOID0000-www/src/components/common/Profile/UserProfileHeader.tsx
VOID0000-www/src/components/common/Settings/ChangePassword/ChangePasswordModal.tsx
VOID0000-www/src/pages/Auth/Register.tsx
VOID0000-www/src/pages/Invite.tsx
```

Added files:

```text
VOID0000-www/src/Services/utils/errorMessage.ts
VOID0000-www/scripts/tests/chats/errorMessage.test.ts
docs/frontend-readiness-2026-09-12.md
docs/deployment-validation-checklist.md
```

No packages, ESLint configuration, backend source, migration, PM2 or environment
files changed. Generated build/test output is not part of the patch.
No commit, push, restart or deployment was performed during the cleanup pass.
The subsequently authorized migration/build follow-up is recorded below.

## Deployment work still required

All items in [the deployment validation checklist](deployment-validation-checklist.md)
remain operator/deployed-environment checks: actual migration state, coordinated
API/admin/gateway/frontend rollout, legacy re-login, proxy/IP and TLS/header
behavior, external service exposure, storage-network isolation, HTTP/WebSocket
revocation, password/admin reset invalidation, backup restoration and smoke tests.
Local tests are not evidence that these deployed checks passed, and no production
penetration test was performed.

## Authorized migration/build follow-up

The subsequent user request authorized applying migrations, rebuilding and
committing/pushing the cleanup. The existing valid root `package.json` build
shortcut is included without changing its contents.

- Target: bare-metal PostgreSQL `localhost:5432/voidapp_note2ee` and Scylla
  `127.0.0.1`, keyspace `voidapp_note2ee`, resolved from the existing API environment.
- Before: PostgreSQL had 14 applied / one pending migration (0014); Scylla had
  one applied / zero pending migrations.
- Ran `npm run migrate` in the API with command-local
  `PGOPTIONS='-c lock_timeout=5s -c statement_timeout=60s'`. Migration 0014 was
  recorded at `2026-09-12T15:19:28.157Z`. No legacy session IDs were backfilled.
- Re-ran `npm run migrate:status`: PostgreSQL now has 15 applied / zero pending;
  Scylla remains one applied / zero pending. Verified the nullable UUID column,
  valid unique partial session-ID index and matching recorded migration checksum.
- Root `npm run build` rebuilt the API through the existing shortcut, using
  Node 22.22.0. API `npm run build:vmd` rebuilt the Go binary successfully.
- `ASDF_ELIXIR_VERSION=1.17.3-otp-27 MIX_ENV=prod mix compile` passed in the gateway.
- Frontend `npm run build` passed using Node 20.20.0 and the default Vite loader
  (13.93s Vite build). `node --check VOIDADMIN/server.js` passed; admin has no
  separate transpilation step.
- No PM2 process was restarted, no container was deployed, and no frontend files
  were published to the Nginx document root. These builds are ready for the
  coordinated runtime rollout, not evidence that running services changed.

Legacy tokens still require a fresh login when the updated services run. All
other deployed-environment checklist items remain unverified; applying the
migration is not a live security test.
