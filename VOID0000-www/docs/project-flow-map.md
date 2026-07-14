# Project Flow Map

This is the high-level map of the NOTE2EE project so we do not need to keep the system in our heads.

## 0. Master Connected Flow

```mermaid
flowchart LR
  subgraph Client
    UI[React UI]
    Auth[Auth + UserContext]
    Settings[Settings / Profile / Sessions]
    Friends[Friends + Presence hooks]
    ChatMgr[Chat manager]
    Stream[Message stream]
    Composer[Message input]
    Attachments[Attachment UI]
    GatewayClient[Gateway client]
    LocalState[(Browser local state)]
  end

  subgraph API
    AccountSvc[Account/control service :3001]
    MessageSvc[Message service :3002]
    SocialSvc[Social/profile service :3004]
    ConvSvc[Conversation service :3005]
    WorkerSvc[Worker service]
    GatewayAPI[Phoenix gateway :4001]
    RateLimit[Rate limiting]
  end

  subgraph Storage
    PG[(Postgres)]
    SCY[(Scylla)]
    MINIO[(MinIO)]
    VALKEY[(Valkey)]
  end

  UI --> Auth
  UI --> Settings
  UI --> Friends
  UI --> ChatMgr

  Auth --> AccountSvc
  Settings --> AccountSvc
  Settings --> SocialSvc
  Friends --> SocialSvc
  ChatMgr --> Stream
  ChatMgr --> Composer
  ChatMgr --> Attachments

  Auth --> GatewayClient
  Friends --> GatewayClient
  ChatMgr --> GatewayClient
  GatewayClient --> GatewayAPI

  AccountSvc --> RateLimit
  SocialSvc --> RateLimit
  ConvSvc --> RateLimit
  MessageSvc --> RateLimit

  AccountSvc --> PG
  SocialSvc --> PG
  ConvSvc --> PG
  MessageSvc --> PG
  MessageSvc --> SCY
  MessageSvc --> MINIO
  SocialSvc --> MINIO
  WorkerSvc --> MINIO
  AccountSvc --> VALKEY
  SocialSvc --> VALKEY
  ConvSvc --> VALKEY
  MessageSvc --> VALKEY
  WorkerSvc --> VALKEY
  GatewayAPI --> VALKEY

  Composer --> MessageSvc
  Attachments --> MessageSvc
  Stream --> MessageSvc
  ChatMgr --> ConvSvc
  UI --> LocalState
```

Use this section as the "how everything connects" map. The sections below zoom into one lane at a time so the details stay readable.

## 1. System Shape

```mermaid
flowchart LR
  UI[React UI] --> Hooks[Frontend hooks]
  Hooks --> Services[Frontend services]
  Services --> AccountAPI[Account/control API]
  Services --> MessageAPI[Message API]
  Services --> SocialAPI[Social/profile API]
  Services --> ConversationAPI[Conversation API]
  Services --> Gateway[Phoenix WebSocket gateway]
  Services --> LocalState[local browser state]
  AccountAPI --> Postgres[(Postgres)]
  SocialAPI --> Postgres
  ConversationAPI --> Postgres
  MessageAPI --> Postgres
  MessageAPI --> Scylla[(Scylla messages)]
  MessageAPI --> MinIO[(MinIO attachments)]
  SocialAPI --> MinIO
  AccountAPI --> Valkey[(Valkey sessions / rate limits)]
  SocialAPI --> Valkey
  ConversationAPI --> Valkey
  MessageAPI --> Valkey
  Gateway --> Presence[Presence + live events]
```

Main frontend layers:

- auth: `src/Services/Auth/UserContext.tsx`, `src/Services/Auth/authServiceApi.ts`
- chat: `src/Services/Chat/chatService.ts`, `src/Services/Chat/messageService.ts`
- gateway: `src/Services/Gateway/gateway.ts`
- message timeline: `src/components/Chat/MessageView`
- message composer: `src/components/Chat/Composer`
- group settings: `src/components/Chat/Groups`

Main backend surfaces:

- account/control service: `server/entrypoints/account-server.js`
- message service: `server/entrypoints/message-server.js`
- social/profile service: `server/entrypoints/social-server.js`
- conversation service: `server/entrypoints/conversation-server.js`
- worker service: `server/entrypoints/worker-server.js`
- Phoenix gateway: `void_gateway`

## 2. Auth Flow

```mermaid
flowchart TD
  A[Register / login] --> B[Account service]
  B --> C[Postgres user/session tables]
  B --> D[Set auth cookies]
  D --> E[Frontend UserContext]
  E --> F[Gateway auth + app bootstrap]
```

Auth notes:

- passwords are hashed with Argon2id
- access cookies are short-lived
- refresh tokens rotate and are stored server-side as hashes
- CSRF and 2FA use separate server-side secrets
- trust, captcha, and rate-limit state are backed by Valkey

## 3. Friends And Presence Flow

```mermaid
flowchart TD
  A[Friend request or search] --> B[Social/profile service]
  B --> C[Postgres friendship/profile tables]
  C --> D[Gateway presence fanout]
  D --> E[Frontend friend hooks]
```

Friendship, profile reads, presence, friend actions, and user search live primarily in the social/profile service.

## 4. Conversation Metadata Flow

```mermaid
flowchart TD
  A[Create DM or group] --> B[Conversation service]
  B --> C[Postgres conversations + members]
  C --> D[Conversation update event]
  D --> E[Frontend chat list]
```

Conversation service owns:

- DM creation and group creation
- member list and role changes
- ownership transfer
- leaving or deleting a group
- invites and join requests
- group permissions and nicknames

## 5. Message Send Flow

```mermaid
flowchart TD
  A[User sends text/media] --> B[useMessageInput]
  B --> C[Message service]
  C --> D[Validate membership and permissions]
  D --> E[Store message in Scylla]
  E --> F[Update conversation preview in Postgres]
  F --> G[Gateway fanout]
  G --> H[Recipient UI updates]
```

Relevant files:

- `src/Services/hooks/Chats/useMessageInput.ts`
- `src/Services/Chat/messageService.ts`
- `server/routes/conversations/messages/sendMessage.js`
- `server/routes/conversations/messages/shared.js`

## 6. Message History And Live Stream

```mermaid
flowchart TD
  A[Conversation open] --> B[Fetch history]
  B --> C[Render existing messages]
  C --> D[Gateway MESSAGE_CREATE / UPDATE / DELETE]
  D --> E[useMessageStream]
  E --> F[Merge message into local UI state]
```

History and live stream notes:

- message bodies live in ScyllaDB
- reactions and read state are fetched through message/conversation routes
- the timeline uses scroll preservation and spacer geometry to keep long histories usable
- see `docs/message-scroll-mechanism.md` for the scroll-specific flow

## 7. Attachment Flow

```mermaid
flowchart TD
  A[User picks file] --> B[Frontend validates and previews]
  B --> C[Upload to message service]
  C --> D[Store object in MinIO]
  D --> E[Store object metadata in Postgres]
  E --> F[Message references attachment metadata]
  F --> G[Authenticated download route streams object]
```

Attachment notes:

- public avatars and group icons are served from public object routes
- chat attachments are private and downloaded through authenticated API routes
- image metadata and blurhash data are generated where needed for the UI

## 8. Typing / Read / Reactions Flow

```mermaid
flowchart TD
  A[User types / reads / reacts] --> B[Message sub-routes]
  B --> C[Persist state]
  C --> D[Gateway fanout]
  D --> E[Frontend updates UI]
```

Relevant files:

- `server/routes/conversations/messages/read.js`
- `server/routes/conversations/reactions.js`
- `server/routes/conversations/batchReactions.js`
- `src/Services/hooks/Chats/useMessageStream.ts`

## 9. Storage Map

- Postgres:
  users, profiles, friendships, refresh tokens, conversation metadata, memberships, permissions, attachment object mapping, notification preferences
- Scylla:
  message timeline storage, edits, reactions, and reaction counts
- MinIO:
  avatars, group icons, and private attachment objects
- Valkey:
  active sessions, rate limits, captcha/trust state, realtime pub/sub, gateway coordination, queue state
- Browser local state:
  UI settings, cached account data, cached conversation data, queued sends, and other client-only runtime state

## 10. Rate Limiting Map

Main limiter exports live in `server/middleware/rate_limit.js`.
Policy definitions live in `server/middleware/rateLimits/policies.js`.

Important buckets:

- auth login
- forgot/reset/register
- auth refresh/check
- friends list
- friends presence
- friend actions
- messages fetch/send
- DM anti-spam guard
- attachment and profile upload paths

## 11. Known Limits

- the app is still a hobby project and should be tested like one
- account deletion is manual in the current tiny deployment
- voice/video calls are intentionally out of scope
- some flows are durable, but edge-case testing still matters for auth, sessions, friends, conversations, messages, attachments, and realtime behavior
