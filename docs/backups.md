# Backups

This is the practical backup story for VOID right now.

It is not fancy. It is meant to save the project when a migration, refactor,
disk failure, or tired-human moment goes sideways.

## What Actually Matters

Critical:

- PostgreSQL
  - users, auth/session metadata, conversations, memberships, friendship data,
    preferences, notifications, and attachment object mapping
- ScyllaDB
  - message history, atomic reaction state/readiness, and Scylla migration bookkeeping
- MinIO
  - profile pictures, group pictures, and private chat attachment objects

Useful but less critical:

- Valkey
  - sessions, presence, cache, rate-limit state, queue state
  - if lost, users may need to log in again and some in-flight jobs/presence
    state disappears, but chat history should not disappear

Not enough by itself:

- GitHub
  - saves code, not your database or media
- PM2 dump
  - saves process list, not app data
- MinIO attachment objects alone
  - incomplete without the database rows and message records that point at them

## Run A Backup

From the repo root:

```bash
./scripts/backup-voidapp.sh
```

A normal backup is a full recovery artifact. It temporarily quiesces the
running VOID writers (the API, message, conversation, social, worker, VMD, and
gateway PM2 services), then captures PostgreSQL, Scylla, and MinIO from that
single stopped-writer interval. The recovery point begins only after those
writers stop; they are resumed after every required store finishes, including on
failure. PostgreSQL, Scylla, and MinIO remain running while they are read.

For a Compose or other non-PM2 deployment, set both trusted operator commands:

```bash
VOIDAPP_BACKUP_QUIESCE_COMMAND='docker compose stop account message social conversation worker media-worker vmd gateway' \
VOIDAPP_BACKUP_RESUME_COMMAND='docker compose start account message social conversation worker media-worker vmd gateway' \
./scripts/backup-voidapp.sh
```

The command fails rather than guessing if it cannot establish a quiesced writer
set. A required PostgreSQL, Scylla, or MinIO failure also fails the backup.

Default output:

```text
~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ/
~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ.tar.gz
~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ.tar.gz.sha256
```

The script reads:

```text
VOID0000-api/.env
```

Override paths if needed:

```bash
VOIDAPP_ENV_FILE=/path/to/.env \
VOIDAPP_BACKUP_DIR=/mnt/backups/voidapp \
./scripts/backup-voidapp.sh
```

An intentionally partial diagnostic artifact can be made only with
`--allow-incomplete`; it is marked `backup_complete=0` and cannot be used with
a full `--all` restore:

```bash
VOIDAPP_BACKUP_SKIP_SCYLLA=1 ./scripts/backup-voidapp.sh --allow-incomplete
```

Available skip flags:

- `VOIDAPP_BACKUP_SKIP_POSTGRES=1`
- `VOIDAPP_BACKUP_SKIP_SCYLLA=1`
- `VOIDAPP_BACKUP_SKIP_MINIO=1`
- `VOIDAPP_BACKUP_SKIP_VALKEY=1`

## What The Script Uses

PostgreSQL:

- `pg_dump`
- output is custom-format `.dump`
- restore uses `pg_restore`

ScyllaDB:

- `cqlsh`
- exports schema plus the authoritative `messages`, `reaction_state`,
  `reaction_schema`, and `schema_migrations` CSV files
- good enough for this project size right now
- not the final production-scale backup story

MinIO:

- uses `mc mirror` for object bytes and a MinIO SDK metadata manifest for every
  object; restore writes and verifies the original metadata again
- does not fall back to raw MinIO disk copying, because that cannot provide a
  portable, validated object-level restore

This preserves attachment content type and the trusted
`x-amz-meta-void-sanitized-image: 1` marker required by VMD. Restore verifies
the metadata and object SHA-256 values before accepting each object.

Valkey:

- uses `valkey-cli` or `redis-cli`
- captures `INFO`, `CONFIG`, and an RDB stream when supported

## Install Helpful Tools

Ubuntu-ish:

```bash
sudo apt install postgresql-client redis-tools
```

For MinIO Client:

```bash
curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /tmp/mc
chmod +x /tmp/mc
sudo mv /tmp/mc /usr/local/bin/mc
```

For Scylla `cqlsh`, use the package method that matches how Scylla was
installed on your machine. If `cqlsh` works in your terminal, the backup script
can use it.

## Suggested Schedule

For a hobby public-ish server:

- before every migration or risky refactor
- daily while actively developing
- keep at least 7 daily backups
- keep a few weekly backups if disk space allows
- copy important backups off the same machine

A backup sitting on the same disk is better than nothing, but it is still not a
real disaster backup. If the disk dies, it dies with the app.

Simple cron example:

```cron
15 3 * * * cd /home/void0000/Desktop/VOIDAPP && ./scripts/backup-voidapp.sh >> /home/void0000/voidapp-backups/backup.log 2>&1
```

## Future Hot And Cold Storage

Right now this project can keep MinIO on the same machine because the data is
small. If it grows, the simple future plan is:

- Hot storage: live MinIO data on a mounted data drive, for example
  `/srv/voidapp/minio-data`.
- Cold storage: backup archives copied somewhere else, for example an external
  drive, NAS, cheap storage box, or another server.
- Keep the app reading from hot storage. Treat cold storage as disaster recovery,
  not as a place to silently move active attachment files.

Later, if the app needs true archiving, add it as an app feature: mark old files
as archived in the database, move them intentionally, and show a restore/loading
state when someone opens an old attachment. Until then, live MinIO objects should
stay where the app expects them.

## Restore Order

Do restores on a test machine first if you can. Restore drills are where the
backup stops being a theory.

There is now a helper script:

```bash
./scripts/restore-voidapp.sh --backup /path/to/backup --dry-run --all
```

That command only prints the restore steps. It does not change data.

To restore for real, choose the parts you want and pass `--yes`:

```bash
./scripts/restore-voidapp.sh \
  --backup /path/to/backup \
  --postgres \
  --scylla \
  --minio \
  --yes
```

The restore script accepts either:

- backup folder: `~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ`
- backup archive: `~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ.tar.gz`

The script intentionally does **not** restore Valkey automatically. For VOID,
Valkey is mostly sessions/cache/presence/queue state, so the safer default is
to let it rebuild unless you have a very specific reason to restore it.

Safe rough order:

1. Stop the app:

```bash
pm2 stop all
```

2. Restore PostgreSQL.

Create or empty the target database first. Be careful. This destroys/overwrites
data if pointed at the wrong DB.

```bash
pg_restore \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -d void-app \
  --clean \
  --if-exists \
  /path/to/backup/postgres/void-app.dump
```

3. Restore Scylla schema and tables.

```bash
cqlsh 127.0.0.1 9042 -f /path/to/backup/scylla/schema.cql
```

Then import each authoritative CSV (the helper does this and also restores into
an isolated target keyspace by rewriting the backup keyspace name):

```bash
cqlsh 127.0.0.1 9042 -e "COPY voidapp.messages FROM '/path/to/backup/scylla/messages.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.reaction_state FROM '/path/to/backup/scylla/reaction_state.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.reaction_schema FROM '/path/to/backup/scylla/reaction_schema.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.schema_migrations FROM '/path/to/backup/scylla/schema_migrations.csv' WITH HEADER = TRUE;"
```

4. Restore MinIO.

The restore helper restores object bytes and then uses the accompanying metadata
manifest through the MinIO SDK. It verifies each metadata value and object hash.
Do not use a plain filesystem mirror as a restore substitute.

```bash
mc alias set local http://127.0.0.1:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
mc mirror --overwrite /path/to/backup/minio/avatars local/avatars
mc mirror --overwrite /path/to/backup/minio/group-avatars local/group-avatars
mc mirror --overwrite /path/to/backup/minio/chat-attachments local/chat-attachments
```

If the backup used raw `minio-data`, restore it only while MinIO is stopped.

5. Restore Valkey only if you really need session/queue/cache state.

Most of the time, it is fine to let Valkey start fresh. Users log in again and
presence/rate-limit/cache state rebuilds.

6. Run migrations after restore if the code is newer than the backup:

```bash
cd /home/void0000/Desktop/VOIDAPP/VOID0000-api
npm run migrate
```

7. Start the app:

```bash
pm2 start /home/void0000/Desktop/VOIDAPP/VOID0000-api/ecosystem.config.cjs --update-env
pm2 save
```

8. Check health:

```bash
./scripts/check-health.sh
```

## Important Limitations

- Scylla CSV export is okay for this project while it is small. If message
  volume gets serious, move to Scylla snapshots or a real backup manager.
- Backups contain sensitive data. Even if chat bodies and attachments are
  encrypted, account data, emails, metadata, sessions, and encrypted key backups
  still need protection.
- Do not commit backups to Git.
- Do not store the only backup on the same disk forever.
- Test restore before trusting the backup.

## Isolated Restore Drill

Run this against separately named PostgreSQL database, Scylla keyspace, and
MinIO endpoint/buckets. Never point it at production. The restore helper rejects
an incomplete or non-quiesced artifact when PostgreSQL, Scylla, and MinIO are
selected together.

1. In the source environment, create one account/conversation, a text message,
   an atomic reaction, and a sanitized image attachment.
2. Create a normal full backup and retain its `MANIFEST.txt`.
3. Start isolated stores, initialize the target MinIO buckets/policies, and set
   an isolated environment file with a different `PGDATABASE`,
   `SCYLLA_KEYSPACE`, and MinIO endpoint.
4. First inspect it without mutation:

```bash
VOIDAPP_ENV_FILE=/path/to/isolated.env \
./scripts/restore-voidapp.sh --backup /path/to/backup --dry-run --all
```

5. With all application writers stopped in the target, restore it:

```bash
VOIDAPP_ENV_FILE=/path/to/isolated.env \
./scripts/restore-voidapp.sh --backup /path/to/backup --all --truncate-scylla --yes
```

6. Run `npm run migrate:status`, start the isolated message/VMD services, and
   verify the account, conversation, message, atomic reaction viewer/count,
   attachment object, and VMD delivery. Confirm the attachment object's trusted
   sanitizer marker remains present and run normal attachment cleanup once; the
   referenced object must remain.

The scripts validate the artifact contract before restore, but a full
service-backed drill still requires deployed isolated stores
and is **NEEDS DEPLOYED VALIDATION** until run there.
