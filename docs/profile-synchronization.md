# Realtime profile synchronization verification

Working tree based on `17eab5f7068180366f6127dea8ae1d0d70d56973` in
`/home/void0000/Desktop/VOIDAPP-NOTE2EE`. No native, authentication, gateway,
message synchronization, pagination, attachment delivery or VMD implementation changes.

## Diagnosis and correction

- Chat headers, sender identities, settings and conversation-list rows preferred old
  conversation/member profile snapshots over the updated FriendsProvider record.
- `PROFILE_UPDATE` used nullish fallback when patching friends, so explicit null
  could not clear an avatar, name or bio. Conversation member caches were not patched.
- Message display callbacks read refs but retained their identity across profile
  changes. Memoized MessageItems therefore had no changed prop that required their
  displayed sender identity to update.
- A friends HTTP response already in flight could overwrite a newer profile event.
  Events are now retained only for the lifetime of that request and overlaid on its
  response. This is not a second persistent profile store.
- The conversation list declared its item component inside the parent. Each parent
  rerender created a new component type, remounting avatars and retrying broken URLs.
  A render helper now preserves the existing child identity and image state.

Shared identity resolution uses conversation nickname first, followed by the live
profile's fields, member fields, conversation snapshot and username fallback.
An explicitly cleared field stops fallback to an older copy of that field.
The conversation list previously combined nickname and global display name into
`dm_display_name`; list/detail responses now also expose the existing nickname as
`dm_nickname`. No migration is needed. Deploy these API responses with the frontend
to preserve summary-only nickname display.

FriendsProvider patches its friend records, existing local profile cache entries
and cached conversation members. Active members incorporate live friend data and
patch any nickname-refreshed member state. Sender callbacks now update normally
when profile inputs change. The same resolver is used for DM headers, beginning
headers, message names/avatars, typing identities, list display/search and settings.

UserAvatar removes a failed image element and retains initials. Rerendering the
same URL does not restart the failed request. A different URL can load normally.
The existing loading/decode behavior is retained.

## Delivery and persistence evidence

The existing path is profile route -> accepted-friend ID query ->
`publishToGateway('PROFILE_UPDATE', friendId, payload)` -> Valkey `void:gateway`
envelope `{event, targetUserId, data, timestamp}` -> GatewaySubscriber ->
EventDispatcher -> user sockets -> frontend `OP.EVENT` -> registered listener.
The authenticated FriendsProvider registers and cleans up its PROFILE_UPDATE listener.

The backend test executes the actual fanout function and checks its recipient query
and published recipient IDs. The Chromium test injects the event into the existing
frontend dispatcher and checks real providers/components, including memoized
MessageItem. It proves the frontend handles a delivered event, not that a deployed
two-account WebSocket session has been exercised. No gateway delivery defect was
reproduced, and no gateway changes were made.

The avatar worker uploads bytes, persists `user_profiles.avatar_filename`,
invalidates the profile cache, deletes the old object, then returns completion.
The upload route publishes the resulting URL afterward. A regression test checks
this ordering. Tests execute bootstrap, friends, conversation list and detail
handlers with changing persisted filename fixtures, including avatar removal.

Read-only inspection of the configured PostgreSQL/MinIO deployment found all 17
non-null avatar filenames checked present in MinIO as `image/webp`. HEAD requests
for all 17 current CDN URLs returned HTTP 200 with `image/webp`. The first inspection
command omitted the application's default CDN origin when CDN_URL was unset; it
was rerun using the actual application default, producing those 17 successful results.
No production records or objects were modified. There is no confirmed current
persistence/CDN failure. The particular historical hard-refresh failure was not
reproduced, so it cannot be conclusively attributed to realtime state.

## Changed files

Paths are relative to the repository root.

- `VOID0000-api/server/routes/conversations/root/list.ts`
- `VOID0000-api/server/routes/conversations/root/details.ts`
- `VOID0000-api/scripts/tests/profile/profileSynchronization.test.js`
- `VOID0000-www/src/Services/Chat/profileIdentity.ts`
- `VOID0000-www/src/Services/Chat/chatTypes.ts`
- `VOID0000-www/src/Services/Chat/conversationCache.ts`
- `VOID0000-www/src/Services/hooks/Friends/useFriends.tsx`
- `VOID0000-www/src/Services/hooks/profile/useProfileRecord.ts`
- `VOID0000-www/src/Services/hooks/Chats/useConversationMembers.ts`
- `VOID0000-www/src/Services/hooks/Chats/useMessageDisplay.ts`
- `VOID0000-www/src/pages/Chat/Chats.tsx`
- `VOID0000-www/src/components/Chat/MessageView/MessageViewHeader.tsx`
- `VOID0000-www/src/components/Chat/MessageView/MessageViewV2.tsx`
- `VOID0000-www/src/components/Chat/Conversation/ConversationList.tsx`
- `VOID0000-www/src/components/Chat/Conversation/DirectConversationSettings.tsx`
- `VOID0000-www/src/components/common/UserAvatar.tsx`
- `VOID0000-www/scripts/tests/chats/profileFixtures.ts`
- `VOID0000-www/scripts/tests/chats/profileIdentity.test.ts`
- `VOID0000-www/scripts/tests/chats/profileSyncFixture.tsx`
- `VOID0000-www/scripts/tests/chats/profileSync.test.mjs`
- `docs/profile-synchronization.md`

## Validation

Node 22.22.0 was used for tests/API checks; Node 20.20.0 for the frontend build.

From `VOID0000-www`:

```sh
node --import tsx --test --test-concurrency=1 scripts/tests/auth/*.test.ts scripts/tests/chats/*.test.ts scripts/tests/messages/*.test.ts scripts/tests/messages/*.test.tsx scripts/tests/attachments/*.test.ts scripts/tests/presence/*.test.ts scripts/tests/performance/*.test.ts
node --test --test-concurrency=1 scripts/tests/chats/profileSync.test.mjs scripts/tests/auth/*.test.mjs scripts/tests/performance/*.test.mjs
npm run build
```

Results: 171 unit tests passed; 14 browser/harness tests passed; TypeScript and Vite
production build passed. The new browser test covers live name/avatar updates in
real components, unchanged message-row DOM identity, nickname preservation and
clearing, a racing friends response, existing profile-cache updates, broken-avatar
initials, no same-URL retry on rerender, changed-URL recovery, no profile-event API
refetch and listener cleanup on unmount. Test data/transports are confined to tests.

From `VOID0000-api`:

```sh
node --import tsx --test scripts/tests/profile/profileSynchronization.test.js
npm run typecheck
npm run build
node node_modules/eslint/bin/eslint.js server/routes/conversations/root/list.ts server/routes/conversations/root/details.ts scripts/tests/profile/profileSynchronization.test.js
```

Results: 3 profile/fanout tests passed; typecheck, build and changed-file lint passed.
The full Phoenix suite was not rerun; Phoenix was inspected but not modified.

Frontend changed-file lint command:

```sh
node --single-threaded --no-incremental-marking --max-old-space-size=4096 node_modules/eslint/bin/eslint.js src/Services/Chat/profileIdentity.ts src/Services/Chat/chatTypes.ts src/Services/Chat/conversationCache.ts src/Services/hooks/Friends/useFriends.tsx src/Services/hooks/profile/useProfileRecord.ts src/Services/hooks/Chats/useConversationMembers.ts src/Services/hooks/Chats/useMessageDisplay.ts src/pages/Chat/Chats.tsx src/components/Chat/MessageView/MessageViewHeader.tsx src/components/Chat/MessageView/MessageViewV2.tsx src/components/Chat/Conversation/ConversationList.tsx src/components/Chat/Conversation/DirectConversationSettings.tsx src/components/common/UserAvatar.tsx scripts/tests/chats/profileFixtures.ts scripts/tests/chats/profileIdentity.test.ts scripts/tests/chats/profileSyncFixture.tsx scripts/tests/chats/profileSync.test.mjs --format json
```

Comparison with HEAD using the same ESLint configuration: touched production files
went from 15 errors / 8 warnings to 12 errors / 8 warnings. Remaining baseline errors
are in FriendsProvider (3), useProfileRecord (1), MessageViewHeader (1), and Chats (7).
They concern existing effect/ref/manual-memoization and fast-refresh rules. Remaining
warnings are existing dependency warnings. New helper/test files and the revised
member hook passed separate lint checks. No lint rules were disabled or weakened.

The initial build caught a TypeScript indexed-access narrowing error in the new
member patch callback; binding the checked member to a local variable fixed it.
Early browser harness runs needed dependency prebundling and correct waiting for
image errors. The same-URL retry assertion exposed the genuine list-row remount
issue described above. Final test/build results are passing.

Changes are built locally, not committed, pushed or deployed. Live two-user profile
editing and the original intermittent hard-refresh case still need deployment
verification; no production test account was created or modified.
