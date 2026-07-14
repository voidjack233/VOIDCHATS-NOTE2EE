# Database Migrations

This repository has a canonical migration path for its PostgreSQL and ScyllaDB
schema. New deployments should start with fresh database targets.

## Commands

Run all pending migrations:

```bash
npm run migrate
```

Check status without applying migrations:

```bash
npm run migrate:status
```

## Canonical Schema

PostgreSQL migrations run in this order:

- `0000_core_schema.sql` creates accounts, profiles, authentication security,
  friendships and blocks, and theme preferences.
- `0001_conversation_schema.sql` creates conversations, memberships,
  categories, DM pairs, invite links, and join requests without key versions or
  membership-rotation state.
- `0002_dm_hidden_muted.sql` adds per-user DM visibility and mute settings.
- `0003_message_notifications_pref.sql` adds message notification preferences.
- `0004_private_attachment_objects.sql` stores private object ownership.
- `0005_push_subscriptions.sql` stores browser push subscriptions.

ScyllaDB uses one fresh baseline:

- `0000_message_storage.cql` stores message `content`, edit history, message
  metadata, link previews, and reactions.

The migration runner also creates its migration bookkeeping tables. It does
not clone any existing data.

## Account Import

The one-time account importer is:

```bash
npm run import:accounts
```

It copies only:

- users, password hashes, verification status, and profiles
- theme preset, colors, density, spacing, font scale, and notification preference
- accepted friendships
- blocked relationships stored as friendship rows with `status='blocked'`
- 2FA methods and backup codes when explicitly preserved

It does not copy messages, reactions, conversations, memberships, invites,
attachments, pending friend requests, sessions, password-reset tokens, email
challenges, push subscriptions, security logs, or data outside the listed
account scope.

The importer requires separate `SOURCE_*` and `TARGET_*` PostgreSQL settings,
an empty target, and this exact confirmation value:

```bash
ACCOUNT_IMPORT_CONFIRM=IMPORT_ACCOUNTS_INTO_VOID
```

If any source account has enabled 2FA, choose one mode explicitly:

```bash
ACCOUNT_IMPORT_2FA_MODE=preserve
```

Preserving 2FA requires the new deployment to use the same TOTP encryption key.
Use `reset` only if affected users should enroll in 2FA again.

Profile rows retain `avatar_filename`; matching objects must be copied
separately from the `avatars` MinIO bucket before cutover.

## Intended Cutover

1. Create separate PostgreSQL and ScyllaDB targets with new names.
2. Point a non-production `.env` at those targets and apply migrations.
3. Finish and test the backend and frontend plaintext conversion.
4. Stop account writes briefly on the old app and take a final cold backup.
5. Run the account importer once and copy profile avatars.
6. Validate logins, friendships, blocks, themes, and 2FA.
7. Point the new deployment at the new databases.

## Multi-Instance Safety

`npm run migrate` takes a global PostgreSQL advisory lock before applying
PostgreSQL and ScyllaDB migrations. Concurrent migration attempts are therefore
serialized. `npm run migrate:status` remains read-only and does not take the
lock.

Valkey data, MinIO objects, and PM2 process state are outside the migration
runner.
