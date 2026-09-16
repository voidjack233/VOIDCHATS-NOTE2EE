package media_test

import (
	"context"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/media"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func objectStorage(t *testing.T) *minio.Client {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	endpoint := "127.0.0.1:" + strconv.Itoa(port)
	cmd := exec.Command("/usr/local/bin/minio", "server", t.TempDir(), "--address", endpoint)
	cmd.Env = append(os.Environ(), "MINIO_ROOT_USER=mediatest", "MINIO_ROOT_PASSWORD=media-test-only-secret", "MINIO_BROWSER=off")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	client, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4("mediatest", "media-test-only-secret", ""), Region: "us-east-1"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		_, err = client.ListBuckets(ctx)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	return client
}

func TestRealPipelineAndFinalization(t *testing.T) {
	pool := postgres(t)
	redis := valkey(t)
	objects := objectStorage(t)
	ctx := context.Background()
	config := processorConfig()
	config.TempRoot = filepath.Join(t.TempDir(), "work")
	config.AttachmentBucket = "attachments"
	config.QuarantineBucket = "quarantine"
	config.JobTimeout = time.Minute
	config.LeaseDuration = 2 * time.Minute
	if err := objects.MakeBucket(ctx, config.AttachmentBucket, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	store := &media.Store{Pool: pool, LeaseDuration: config.LeaseDuration}
	queue := &media.Queue{Client: redis, Consumer: uuid.NewString(), StaleAfter: config.LeaseDuration}
	worker := &media.Worker{Config: config, Store: store, Queue: queue, Objects: objects, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := worker.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	user, conversation := uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,email,password_hash) VALUES($1,'media-pipeline','pipeline@test.invalid','unused')`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO conversations(id,type) VALUES($1,'group')`, conversation); err != nil {
		t.Fatal(err)
	}
	source := fixture(t, t.TempDir(), true)
	enqueue := func(path string) media.Job {
		t.Helper()
		job := media.Job{IngestID: uuid.NewString(), ConversationID: conversation}
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		stat, _ := f.Stat()
		key := "video/" + job.IngestID + "/source"
		if _, err = objects.PutObject(ctx, config.QuarantineBucket, key, f, stat.Size(), minio.PutObjectOptions{ContentType: "application/octet-stream", DisableMultipart: true}); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO media_ingests(id,uploader_id,conversation_id,status,quarantine_object_key,filename,source_bytes) VALUES($1,$2,$3,'queued',$4,'source.mp4',$5)`, job.IngestID, user, conversation, key, stat.Size()); err != nil {
			t.Fatal(err)
		}
		if err = queue.Publish(ctx, job); err != nil {
			t.Fatal(err)
		}
		return job
	}
	jobs := []media.Job{enqueue(source), enqueue(source)}
	// Consume from the actual stream, not a direct sanitizer/FFmpeg shortcut.
	run, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); worker.Run(run) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("worker failed to stop")
		}
	})
	deadline := time.Now().Add(25 * time.Second)
	for {
		var ready int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM media_ingests WHERE status='ready'`).Scan(&ready)
		if err != nil {
			t.Fatal(err)
		}
		if ready == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("two videos did not finalize")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, job := range jobs {
		var status, mime, poster, marker string
		var mainKey string
		var width, height int
		err := pool.QueryRow(ctx, `SELECT a.status,b.content_type,b.object_key,p.object_key,(a.video_metadata->>'width')::int,(a.video_metadata->>'height')::int FROM attachment_objects a JOIN attachment_blobs b ON b.id=a.blob_id JOIN attachment_blobs p ON p.id=a.poster_blob_id WHERE a.id=$1`, job.IngestID).Scan(&status, &mime, &mainKey, &poster, &width, &height)
		if err != nil || status != "staged" || mime != "video/mp4" || width != 320 || height != 180 {
			t.Fatalf("final descriptor %s %s %dx%d %v", status, mime, width, height, err)
		}
		stat, err := objects.StatObject(ctx, config.AttachmentBucket, mainKey, minio.StatObjectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		marker = stat.UserMetadata["Void-Sanitized-Video"]
		if marker == "" {
			marker = stat.Metadata.Get("X-Amz-Meta-Void-Sanitized-Video")
		}
		if marker != "1" || stat.Size > media.MaxOutputBytes {
			t.Fatalf("video trust/size: %+v", stat)
		}
		posterStat, err := objects.StatObject(ctx, config.AttachmentBucket, poster, minio.StatObjectOptions{})
		if err != nil || posterStat.ContentType != "image/webp" {
			t.Fatal("poster", err)
		}
		if err = queue.Publish(ctx, job); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(150 * time.Millisecond)
	var attachments, blobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachment_objects`).Scan(&attachments); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachment_blobs WHERE ref_count=2`).Scan(&blobs); err != nil {
		t.Fatal(err)
	}
	if attachments != 2 || blobs != 2 {
		t.Fatalf("idempotency/dedup: attachments=%d shared blobs=%d", attachments, blobs)
	}
	cancel()
	<-done
	if _, err := pool.Exec(ctx, `DELETE FROM attachment_objects WHERE id=$1`, jobs[0].IngestID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachment_blobs WHERE ref_count=1`).Scan(&blobs); err != nil || blobs != 2 {
		t.Fatal("main/poster references not decremented", err)
	}
	entries, err := os.ReadDir(config.TempRoot)
	if err != nil || len(entries) != 0 {
		t.Fatal("workspace leak", entries, err)
	}
	// Fail PostgreSQL only AFTER new normalized objects have been written.
	// The next attempt must safely reuse/replace those orphans, not publish a
	// descriptor from the failed transaction or delete its still-needed source.
	retrySource := filepath.Join(t.TempDir(), "retry.mp4")
	if out, err := exec.Command("/usr/bin/ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:size=160x90:rate=10", "-t", "1", "-c:v", "libx264", "-threads", "1", retrySource).CombinedOutput(); err != nil {
		t.Fatalf("retry fixture: %s %v", out, err)
	}
	retryJob := enqueue(retrySource)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_media_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='ready' THEN RAISE EXCEPTION 'injected finalization failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_media_finalization BEFORE UPDATE ON media_ingests FOR EACH ROW EXECUTE FUNCTION fail_media_finalization()`); err != nil {
		t.Fatal(err)
	}
	first, err := store.Claim(ctx, retryJob)
	if err != nil {
		t.Fatal(err)
	}
	if err = worker.Process(ctx, first.Ingest); err == nil {
		t.Fatal("finalization failure ignored")
	}
	var visible int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM attachment_objects WHERE id=$1`, retryJob.IngestID).Scan(&visible); err != nil || visible != 0 {
		t.Fatal("failed finalization exposed an attachment", err)
	}
	orphanCount := 0
	for object := range objects.ListObjects(ctx, config.AttachmentBucket, minio.ListObjectsOptions{Recursive: true}) {
		if object.Err != nil {
			t.Fatal(object.Err)
		}
		orphanCount++
	}
	if orphanCount != 4 {
		t.Fatalf("expected two registered + two uploaded orphan objects, got %d", orphanCount)
	}
	if _, err = objects.StatObject(ctx, config.QuarantineBucket, "video/"+retryJob.IngestID+"/source", minio.StatObjectOptions{}); err != nil {
		t.Fatal("retryable source removed", err)
	}
	if _, err = pool.Exec(ctx, `DROP TRIGGER fail_media_finalization ON media_ingests; DROP FUNCTION fail_media_finalization()`); err != nil {
		t.Fatal(err)
	}
	if terminal, err := store.Fail(ctx, first.Ingest, "MEDIA_STORAGE_UNAVAILABLE", true); err != nil || terminal {
		t.Fatal("retry rejected", err)
	}
	second, err := store.Claim(ctx, retryJob)
	if err != nil {
		t.Fatal(err)
	}
	if err = worker.Process(ctx, second.Ingest); err != nil {
		t.Fatal("orphan recovery failed", err)
	}
	if claim, err := store.Claim(ctx, retryJob); err != nil || !claim.Terminal {
		t.Fatal("ready replay was not terminal", err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM attachment_objects WHERE id=$1 AND status='staged'`, retryJob.IngestID).Scan(&visible); err != nil || visible != 1 {
		t.Fatal("retry did not create exactly one attachment", err)
	}
	// A corrupt source can never create a trusted object or logical attachment.
	bad := filepath.Join(t.TempDir(), "fake.mp4")
	os.WriteFile(bad, []byte("hostile bytes"), 0600)
	job := enqueue(bad)
	claim, err := store.Claim(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	if err = worker.Process(ctx, claim.Ingest); err == nil {
		t.Fatal("untrusted media finalized")
	}
	if _, err = store.Fail(ctx, claim.Ingest, "MEDIA_PROCESS_FAILED", false); err != nil {
		t.Fatal(err)
	}
	pool.Exec(ctx, `UPDATE media_ingests SET completed_at=NOW()-INTERVAL '4 minutes' WHERE id=$1`, job.IngestID)
	if err = worker.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = objects.StatObject(ctx, config.QuarantineBucket, "video/"+job.IngestID+"/source", minio.StatObjectOptions{}); minio.ToErrorResponse(err).Code != "NoSuchKey" {
		t.Fatal("failed quarantine not cleaned", err)
	}
}
