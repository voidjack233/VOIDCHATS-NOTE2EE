# Database Migrations

This repository has a canonical migration path for its PostgreSQL and ScyllaDB
schema. NOTE2EE deployments must start with fresh, separately named database
targets. The migration runner refuses to treat an existing application database
as a fresh baseline.

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
  categories, DM pairs, invite links, and join requests.
- `0002_dm_hidden_muted.sql` adds per-user DM visibility and mute settings.
- `0003_message_notifications_pref.sql` adds message notification preferences.
- `0004_private_attachment_objects.sql` stores private object ownership.
- `0005_push_subscriptions.sql` stores browser push subscriptions.
- `0006_refresh_token_predecessor.sql` adds bounded refresh-race recovery state.
- `0007_attachment_lifecycle.sql` adds staged attachment lifecycle state.
- `0008_attachment_reserved_reconciliation.sql` adds reservation recovery data.
- `0009_attachment_message_write_policy.sql` records the intended Scylla policy.
- `0010_attachment_message_write_acknowledgement.sql` records acknowledged writes.
- `0011_attachment_blob_deduplication.sql` separates logical attachments from
  shared content-addressed physical blobs.

ScyllaDB uses one fresh baseline:

- `0000_message_storage.cql` creates message content, metadata, link previews,
  and reaction storage.

The migration runner also creates its migration bookkeeping tables. It does
not clone any existing data.

## Fresh Database Model

The NOTE2EE schema must be installed into fresh, separately named database
targets. Do not drop tables, remove columns, or run these migrations against an
older deployment.

1. Create an empty PostgreSQL database and a new ScyllaDB keyspace.
2. Set every `PG*` and `SCYLLA_*` value explicitly in the deployment `.env`.
3. Confirm `PGDATABASE` and `SCYLLA_KEYSPACE` name the new targets.
4. Run `npm run migrate` to create the NOTE2EE schema.
5. Run `npm run migrate:status` and confirm every migration is applied.

The migration runner creates schema and bookkeeping records only. It never
copies data from another deployment or deletes data from an existing one.

## Multi-Instance Safety

`npm run migrate` takes a global PostgreSQL advisory lock before applying
PostgreSQL and ScyllaDB migrations. Concurrent migration attempts are therefore
serialized. `npm run migrate:status` remains read-only and does not take the
lock.

PostgreSQL and ScyllaDB runtime clients use the same explicit target settings as
the migration runner. There is no hardcoded fallback keyspace.

Valkey data, MinIO objects, and PM2 process state are outside the migration
runner.
