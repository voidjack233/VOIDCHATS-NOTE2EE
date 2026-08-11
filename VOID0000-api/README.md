# VOID0000 API

Backend services for VOID0000. This package owns the parts of the app that should not live in the browser: authentication, user profiles, friendships, conversations, messages, media uploads, security middleware, database migrations, and background workers.

Realtime websocket traffic is handled by the Phoenix gateway in `void_gateway`. The Node services publish realtime events through Valkey.

## Runtime Shape

- `server/entrypoints/account-server.js` - account/control API on port `3001`.
- `server/entrypoints/message-server.js` - messages, reactions, and attachment uploads on port `3002`.
- `server/entrypoints/social-server.js` - profiles, friends, and user search on port `3004`.
- `server/entrypoints/conversation-server.js` - conversations, groups, members, invites, and permissions on port `3005`.
- `server/entrypoints/worker-server.js` - background workers, cleanup, and presence fanout.
- `void_gateway` - Phoenix websocket gateway.
- `ecosystem.config.cjs` - PM2 definitions for the current NOTE2EE backend.
- `db/migrations` - canonical Postgres schema migrations.
- `db/scylla-migrations` - canonical ScyllaDB message storage migrations.
- `docs/backend-startup.md` - detailed startup notes.
- `docs/database-migrations.md` - migration behavior and limitations.
- `docs/sentinel.md` - read coalescing behavior, integrations, and operational limits.

The app processes are separate from infrastructure services. PM2 starts the split Node services, worker, and Phoenix gateway. Postgres, Valkey, ScyllaDB, and MinIO must already be running.

## Requirements

- Node.js and npm
- Postgres
- Valkey or Redis-compatible server
- ScyllaDB
- MinIO
- Erlang/Elixir, if running the Phoenix gateway locally or through PM2

The Dockerfile uses `node:24-bookworm-slim`.

## Quick Start

```bash
cd VOID0000-api
cp .env.example .env
npm install
# Create the fresh PostgreSQL database named by PGDATABASE first.
npm run migrate
npm run dev
```

The default development account/control API runs on:

```text
http://localhost:3001
```

For the full local backend without PM2, also start these in separate shells:

```bash
npm run dev:messages
```

```bash
npm run dev:social
```

```bash
npm run dev:conversations
```

```bash
npm run dev:workers
```

For a PM2-style production start:

```bash
cd VOID0000-api
npm run migrate
pm2 start ecosystem.config.cjs --update-env
```

For an existing deployment that has not applied attachment migration `0011`,
do not run that generic sequence while an old message service is online. Follow
the stop-before-migrate rollout in `docs/database-migrations.md` instead.

Expected PM2 apps:

- `voidapp-api`
- `voidapp-message-service`
- `voidapp-social-profile-service`
- `voidapp-conversation-service`
- `voidapp-gateway-phoenix`
- `voidapp-worker-service`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the account/control service with `nodemon`. |
| `npm run dev:messages` | Start the message/reaction/attachment service with `nodemon`. |
| `npm run dev:conversations` | Start the conversation/group service with `nodemon`. |
| `npm run dev:social` | Start the friends/profile/search service with `nodemon`. |
| `npm run dev:workers` | Start the background worker service with `nodemon`. |
| `npm start` | Start the account/control service with Node. |
| `npm run start:messages` | Start the message service with Node. |
| `npm run start:conversations` | Start the conversation service with Node. |
| `npm run start:social` | Start the social/profile service with Node. |
| `npm run start:workers` | Start the worker service with Node. |
| `npm run lint` | Run ESLint. |
| `npm run migrate` | Apply pending Postgres and ScyllaDB migrations. |
| `npm run migrate:status` | Show migration status without applying changes. |
| `npm run backfill:conversation-public-ids` | Run the conversation public ID backfill. |
| `npm run migrate:legacy-group-to-general` | Run the legacy group-to-general migration script. |

## Environment

Start from `.env.example` and fill in real values for the target machine.

Do not leave placeholder auth secrets in `.env`. The account service validates the important auth/2FA/CSRF secrets during startup and fails loudly if they are missing, too short, or still look like examples. Annoying at boot time, much better than finding out during a login attempt.

Important groups:

- Postgres: `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGPORT`
- ScyllaDB: `SCYLLA_HOST`, `SCYLLA_KEYSPACE`, `SCYLLA_LOCAL_DATACENTER`, `SCYLLA_REPLICATION_FACTOR`
- Valkey: `VALKEY_HOST`, `VALKEY_PORT`, `VALKEY_DB`
- MinIO: `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, bucket names
- Sentinel: `SENTINEL_MAX_ACTIVE_FLIGHTS`, `SENTINEL_MAX_BUFFERED_ATTACHMENT_BYTES`, `SENTINEL_MAX_TOTAL_BUFFERED_ATTACHMENT_BYTES`
- Auth: `ACCESS_SECRET`, `REFRESH_SECRET`
- CSRF and 2FA: `CSRF_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`, `TWO_FACTOR_CODE_SECRET`
- Email: `EMAIL_USER`, `EMAIL_PASS`
- Frontend/API: `FRONT_URL`, `VITE_API_URL`, `PORT`, `MESSAGE_SERVICE_PORT`, `SOCIAL_SERVICE_PORT`, `CONVERSATION_SERVICE_PORT`
- Phoenix gateway: `GATEWAY_PORT`, `PHX_SECRET_KEY_BASE`

## Data Stores

| Store | Used For |
| --- | --- |
| Postgres | Users, auth, sessions, profiles, friends, and conversation metadata. |
| ScyllaDB | High-volume message storage, edits, reactions, and reaction counts. |
| Valkey | Realtime pub/sub, captcha challenges, trust/rate-limit state, presence fanout, gateway coordination, session resume buffers. |
| MinIO | Avatars, group avatars, and private chat attachments. |

Run `npm run migrate` only against fresh, separately named PostgreSQL and ScyllaDB targets. Migrations create schema only and never copy data from another deployment.

## API Areas

- `/api/auth` - register, login, logout, refresh, email verification, password reset, password change.
- `/api/auth/2fa` - TOTP, email 2FA, verification, disabling, and backup codes.
- `/api/csrf` - encrypted CSRF token flow.
- `/api/captcha` - captcha generation and verification.
- `/api/me` - authenticated user lookup.
- `/api/users` - profile reads, profile updates, avatar upload, preferences, sessions, account data, and search.
- `/api/friends` - friend requests, lists, presence, actions, and removal.
- `/api/conversations` - DMs, conversation metadata, group members, ownership transfer, leave-group flows, permissions, invites, messages, reactions, and attachments.

Self-service account deletion is not exposed as a public flow. This setup is tiny, roughly 1 to 3 users with limited usage, so account removal is handled manually by the operator when needed.

## Security Notes

- Passwords are hashed with Argon2id.
- Login verifies the stored Argon2 hash and can rehash it when the configured Argon2 parameters change.
- Refresh tokens are stored as SHA-256 hashes because the raw tokens are already high-entropy JWTs.
- JWTs are delivered through cookies.
- Access cookies are intentionally short-lived, so refresh-token health matters for normal UX.
- Sensitive state-changing routes use encrypted CSRF protection.
- Captcha challenges, trust scoring, device tracking, and rate limits are backed by Valkey for auth/profile protection across service processes.
- TOTP secrets and email-2FA verification codes use separate server-side secrets. The TOTP encryption key protects stored authenticator secrets; `TWO_FACTOR_CODE_SECRET` protects temporary email-code verification state.
- Image uploads are processed through Sharp to remove metadata.
- CSP and security headers provide browser-side XSS hardening.

## Dependency Map

| Dependency | Role |
| --- | --- |
| `argon2` | Password hashing and verification, plus 2FA backup code hashing. |
| `bcryptjs` | Reserved for possible legacy bcrypt hash migration. Remove it if that compatibility path is not needed. |
| `blurhash` | Compact placeholders for image attachments. |
| `bullmq` | Background queue for image/profile processing work. |
| `canvas` | Captcha image generation. |
| `cassandra-driver` | CQL client for ScyllaDB. |
| `cookie-parser` | Cookie parsing for auth and CSRF flows. |
| `cors` | Cross-origin API access for the frontend. |
| `dotenv` | Loads `.env` during startup. |
| `express` | HTTP API framework. |
| `ioredis` | Valkey/Redis client for pub/sub, coordination, sessions/cache, and custom rate-limit storage. |
| `jsonwebtoken` | Access and refresh token signing. |
| `minio` | Object storage client. |
| `nodemailer` | Gmail SMTP email delivery. |
| `pg` | Postgres client. |
| `qrcode` | QR code generation for authenticator-app 2FA setup. |
| `sharp` | Image processing and metadata stripping. |
| `uuid` | Token IDs and unique identifiers. |

## Health Checks

Account/control API:

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
```

Readiness checks:

```bash
curl http://127.0.0.1:3001/ready
curl http://127.0.0.1:3002/ready
curl http://127.0.0.1:3004/ready
curl http://127.0.0.1:3005/ready
```

Phoenix gateway:

```bash
curl http://127.0.0.1:4001/health
curl http://127.0.0.1:4001/ready
```

If the API starts but realtime, uploads, or message history behave strangely, check the external services first: Postgres, Valkey, ScyllaDB, and MinIO.
