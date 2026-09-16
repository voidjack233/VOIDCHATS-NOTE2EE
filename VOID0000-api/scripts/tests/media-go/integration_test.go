package media_test

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/media"
)

// Real disposable services only. These tests never load .env or connect to the
// application's database/Valkey. PostgreSQL has TCP networking disabled.
func postgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	bin := os.Getenv("PROFILE_TEST_PG_BIN")
	if bin == "" {
		bin = "/usr/lib/postgresql/16/bin"
	}
	if _, err := os.Stat(filepath.Join(bin, "initdb")); err != nil {
		t.Skip("PostgreSQL test binaries unavailable")
	}
	root, err := os.MkdirTemp("", "void-media-pg-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	run := func(name string, args ...string) {
		t.Helper()
		out, err := exec.Command(filepath.Join(bin, name), args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %s: %v", name, out, err)
		}
	}
	run("initdb", "-D", filepath.Join(root, "data"), "-A", "trust", "--no-locale")
	run("pg_ctl", "-D", filepath.Join(root, "data"), "-l", filepath.Join(root, "log"), "-o", "-k "+root+" -c listen_addresses=''", "-w", "start")
	t.Cleanup(func() { run("pg_ctl", "-D", filepath.Join(root, "data"), "-m", "immediate", "-w", "stop") })
	cfg, err := pgxpool.ParseConfig("host=" + root + " dbname=postgres")
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	files, err := filepath.Glob("../../../db/migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatal("migration files missing", err)
	}
	sort.Strings(files)
	for _, path := range files {
		sql, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(context.Background(), string(sql)); err != nil {
			t.Fatalf("migration %s: %v", path, err)
		}
	}
	return pool
}

func valkey(t *testing.T) *redis.Client {
	t.Helper()
	binary, err := exec.LookPath("valkey-server")
	if err != nil {
		t.Skip("Valkey test binary unavailable")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	cmd := exec.Command(binary, "--bind", "127.0.0.1", "--port", strconv.Itoa(port), "--save", "", "--appendonly", "no", "--dir", t.TempDir())
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	client := redis.NewClient(&redis.Options{Addr: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), MaxRetries: 0})
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for client.Ping(ctx).Err() != nil {
		if ctx.Err() != nil {
			t.Fatal("Valkey startup timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return client
}

func TestDatabaseClaimsAndRecovery(t *testing.T) {
	pool := postgres(t)
	ctx := context.Background()
	store := media.Store{Pool: pool, LeaseDuration: time.Minute}
	user, conversation := uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,email,password_hash) VALUES($1,'media-test','media@test.invalid','not-a-password')`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO conversations(id,type) VALUES($1,'group')`, conversation); err != nil {
		t.Fatal(err)
	}
	newIngest := func(t *testing.T, status string) media.Job {
		t.Helper()
		job := media.Job{IngestID: uuid.NewString(), ConversationID: conversation}
		_, err := pool.Exec(ctx, `INSERT INTO media_ingests(id,uploader_id,conversation_id,status,quarantine_object_key,filename,source_bytes)
        VALUES($1::uuid,$2,$3,$4,'video/'||$1::uuid::text||'/source','video.mp4',128)`, job.IngestID, user, conversation, status)
		if err != nil {
			t.Fatal(err)
		}
		return job
	}
	t.Run("concurrent duplicate claims above pool capacity", func(t *testing.T) {
		job := newIngest(t, "queued")
		var claimed atomic.Int32
		var wg sync.WaitGroup
		for range 20 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				claim, err := store.Claim(ctx, job)
				if err != nil {
					t.Error(err)
				}
				if claim.Ingest != nil {
					claimed.Add(1)
				}
			}()
		}
		wg.Wait()
		if claimed.Load() != 1 {
			t.Fatalf("claimed %d times", claimed.Load())
		}
	})
	t.Run("expired lease fences previous worker", func(t *testing.T) {
		job := newIngest(t, "queued")
		old, err := store.Claim(ctx, job)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `UPDATE media_ingests SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1`, job.IngestID); err != nil {
			t.Fatal(err)
		}
		fresh, err := store.Claim(ctx, job)
		if err != nil {
			t.Fatal(err)
		}
		if fresh.Ingest == nil || old.Ingest.LeaseToken == fresh.Ingest.LeaseToken {
			t.Fatal("lease was not replaced")
		}
		if err = store.Stage(ctx, old.Ingest, "probing", "processing"); err == nil {
			t.Fatal("stale worker changed state")
		}
		if _, err = store.Fail(ctx, old.Ingest, "STALE", false); err == nil {
			t.Fatal("stale worker completed ingest")
		}
		if err = store.Stage(ctx, fresh.Ingest, "probing", "processing"); err != nil {
			t.Fatal(err)
		}
		if err = store.Stage(ctx, fresh.Ingest, "processing", "finalizing"); err != nil {
			t.Fatal(err)
		}
		if done, err := store.Fail(ctx, fresh.Ingest, "MEDIA_INVALID", false); err != nil || !done {
			t.Fatal(done, err)
		}
		claim, err := store.Claim(ctx, job)
		if err != nil || !claim.Terminal || claim.Ingest != nil {
			t.Fatal("failed job replayed", err)
		}
	})
	t.Run("uploading and ready ingests are not claimed", func(t *testing.T) {
		job := newIngest(t, "uploading")
		result, err := store.Claim(ctx, job)
		if err != nil || result.Terminal || result.Ingest != nil {
			t.Fatal(result, err)
		}
		if _, err = pool.Exec(ctx, `UPDATE media_ingests SET status='ready',completed_at=NOW() WHERE id=$1`, job.IngestID); err != nil {
			t.Fatal(err)
		}
		result, err = store.Claim(ctx, job)
		if err != nil || !result.Terminal || result.Ingest != nil {
			t.Fatal(result, err)
		}
	})
	t.Run("retry is bounded and terminal persistence precedes acknowledgement", func(t *testing.T) {
		job := newIngest(t, "queued")
		for attempt := 1; attempt <= media.MaxAttempts; attempt++ {
			claim, err := store.Claim(ctx, job)
			if err != nil || claim.Ingest == nil {
				t.Fatal(err)
			}
			terminal, err := store.Fail(ctx, claim.Ingest, "MEDIA_STORAGE_UNAVAILABLE", true)
			if err != nil {
				t.Fatal(err)
			}
			if terminal != (attempt == media.MaxAttempts) {
				t.Fatal("wrong retry outcome", attempt)
			}
		}
	})
	t.Run("source bound and exact quarantine key enforced by database", func(t *testing.T) {
		job := newIngest(t, "uploading")
		for _, size := range []int64{0, -1, media.MaxSourceBytes + 1} {
			if _, err := pool.Exec(ctx, `UPDATE media_ingests SET source_bytes=$2 WHERE id=$1`, job.IngestID, size); err == nil {
				t.Fatal("bad source bound accepted")
			}
		}
		if _, err := pool.Exec(ctx, `UPDATE media_ingests SET source_bytes=$2 WHERE id=$1`, job.IngestID, media.MaxSourceBytes); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE media_ingests SET quarantine_object_key='other/source' WHERE id=$1`, job.IngestID); err == nil {
			t.Fatal("wrong key accepted")
		}
	})
	t.Run("missing publication is recoverable and bounded across replicas", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE media_ingests SET status='failed',completed_at=NOW(),lease_token=NULL,lease_until=NULL WHERE status NOT IN ('failed','ready','cancelled')`); err != nil {
			t.Fatal(err)
		}
		job := newIngest(t, "queued")
		if err := store.Republish(ctx, func(context.Context, media.Job) error { return errors.New("Valkey unavailable") }); err == nil {
			t.Fatal("expected publish failure")
		}
		var count atomic.Int32
		publish := func(_ context.Context, got media.Job) error {
			if got != job {
				t.Error("wrong job")
			}
			count.Add(1)
			return nil
		}
		var wg sync.WaitGroup
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := store.Republish(ctx, publish); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if count.Load() != 1 {
			t.Fatal("replicas flooded stream", count.Load())
		}
	})
}

func TestRealValkeyConsumerRecovery(t *testing.T) {
	client := valkey(t)
	ctx := context.Background()
	a := media.Queue{Client: client, Consumer: uuid.NewString(), StaleAfter: time.Millisecond}
	b := media.Queue{Client: client, Consumer: uuid.NewString(), StaleAfter: time.Millisecond}
	if err := a.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	job := media.Job{IngestID: uuid.NewString(), ConversationID: uuid.NewString()}
	if err := a.Publish(ctx, job); err != nil {
		t.Fatal(err)
	}
	messages, err := a.Next(ctx)
	if err != nil || len(messages) != 1 {
		t.Fatal(messages, err)
	}
	parsed, err := media.ParseJob(messages[0].Values)
	if err != nil || parsed != job {
		t.Fatal(parsed, err)
	}
	time.Sleep(5 * time.Millisecond)
	replayed, err := b.Next(ctx)
	if err != nil || len(replayed) != 1 || replayed[0].ID != messages[0].ID {
		t.Fatal("lost ACK not reclaimed", replayed, err)
	}
	if err = b.Ack(ctx, replayed[0].ID); err != nil {
		t.Fatal(err)
	}
	if err = b.Ack(ctx, replayed[0].ID); err != nil {
		t.Fatal("repeated ACK must be safe", err)
	}
	if count := client.XLen(ctx, media.Stream).Val(); count != 0 {
		t.Fatal("ACK did not prune completed entry")
	}
	if pending := client.XPending(ctx, media.Stream, media.Group).Val(); pending.Count != 0 {
		t.Fatal("pending entry remains")
	}
	if err = a.Publish(ctx, media.Job{IngestID: "bytes", ConversationID: job.ConversationID}); err == nil {
		t.Fatal("invalid job published")
	}
}
