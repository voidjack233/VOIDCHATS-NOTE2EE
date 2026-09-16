package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
)

type Worker struct {
	Config        Config
	Store         *Store
	Queue         *Queue
	Objects       *minio.Client
	Logger        *slog.Logger
	cleanupCursor string
}

func (w *Worker) Initialize(ctx context.Context) error {
	if err := CheckTools(ctx, w.Config); err != nil {
		return err
	}
	if err := os.MkdirAll(w.Config.TempRoot, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(w.Config.TempRoot)
	if err != nil || !info.IsDir() || info.Mode()&0077 != 0 {
		return errors.New("media temp directory must be private")
	}
	exists, err := w.Objects.BucketExists(ctx, w.Config.QuarantineBucket)
	if err != nil {
		return err
	}
	if !exists {
		if err = w.Objects.MakeBucket(ctx, w.Config.QuarantineBucket, minio.MakeBucketOptions{}); err != nil {
			return err
		}
	}
	if err = w.Objects.SetBucketPolicy(ctx, w.Config.QuarantineBucket, ""); err != nil {
		return err
	}
	if _, err = w.Store.Pool.Exec(ctx, `SELECT video_metadata,poster_blob_id FROM attachment_objects LIMIT 0`); err != nil {
		return err
	}
	return w.Queue.Initialize(ctx)
}

func (w *Worker) Run(ctx context.Context) {
	// One synchronous consumer loop is the concurrency gate: no CPU-based scaling.
	for ctx.Err() == nil {
		messages, err := w.Queue.Next(ctx)
		if err != nil {
			w.Logger.Warn("media queue unavailable")
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			continue
		}
		for _, message := range messages {
			job, err := ParseJob(message.Values)
			if err != nil {
				w.Logger.Warn("invalid media job rejected")
				_ = w.Queue.Ack(ctx, message.ID)
				continue
			}
			claimCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			claim, err := w.Store.Claim(claimCtx, job)
			cancel()
			if err != nil {
				w.Logger.Warn("media claim unavailable", "ingest_id", job.IngestID)
				continue
			}
			terminal := claim.Terminal
			if claim.Ingest != nil {
				row := claim.Ingest
				jobCtx, stop := context.WithTimeout(ctx, w.Config.JobTimeout)
				monitorDone := make(chan struct{})
				go func() {
					defer close(monitorDone)
					ticker := time.NewTicker(5 * time.Second)
					defer ticker.Stop()
					for {
						select {
						case <-jobCtx.Done():
							return
						case <-ticker.C:
							check, cancel := context.WithTimeout(jobCtx, 3*time.Second)
							var valid bool
							err := w.Store.Pool.QueryRow(check, `SELECT EXISTS(SELECT 1 FROM media_ingests WHERE id=$1 AND lease_token=$2 AND lease_until>NOW() AND status IN ('probing','processing','finalizing'))`, row.ID, row.LeaseToken).Scan(&valid)
							cancel()
							if err != nil || !valid {
								stop()
								return
							}
						}
					}
				}()
				started := time.Now()
				w.Logger.Info("media processing started", "ingest_id", row.ID, "attempt", row.Attempt, "queue_wait_ms", time.Since(row.CreatedAt).Milliseconds(), "source_bytes", row.SourceBytes)
				err = w.Process(jobCtx, row)
				stop()
				<-monitorDone
				if err == nil {
					terminal = true
					w.Logger.Info("media ready", "ingest_id", row.ID, "elapsed_ms", time.Since(started).Milliseconds())
				} else {
					code := "MEDIA_INFRASTRUCTURE_UNAVAILABLE"
					retry := true
					var mediaError *MediaError
					if errors.As(err, &mediaError) {
						code = mediaError.Code
						retry = false
					}
					finish, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					terminal, _ = w.Store.Fail(finish, row, code, retry)
					cancel()
					w.Logger.Warn("media processing failed", "ingest_id", row.ID, "code", code, "attempt", row.Attempt)
				}
			}
			if terminal {
				ack, cancel := context.WithTimeout(ctx, 3*time.Second)
				_ = w.Queue.Ack(ack, message.ID)
				cancel()
			}
		}
	}
}

func (w *Worker) Process(ctx context.Context, row *Ingest) (err error) {
	defer func() {
		if recover() != nil {
			err = invalid("MEDIA_PROCESS_FAILED")
		}
	}()
	workspace, err := os.MkdirTemp(w.Config.TempRoot, row.ID+"-"+row.LeaseToken+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workspace)
	input := filepath.Join(workspace, "source.mp4")
	object, err := w.Objects.GetObject(ctx, w.Config.QuarantineBucket, row.QuarantineKey, minio.GetObjectOptions{})
	if err != nil {
		return err
	}
	f, err := os.OpenFile(input, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		object.Close()
		return err
	}
	n, err := CopyBounded(f, object, MaxSourceBytes)
	f.Close()
	object.Close()
	if err != nil {
		return err
	}
	if n != row.SourceBytes {
		return invalid("MEDIA_SOURCE_SIZE_INVALID")
	}
	start := time.Now()
	probe, err := ProbeFile(ctx, w.Config, input)
	if err != nil {
		return err
	}
	info, err := ValidateProbe(probe, false)
	if err != nil {
		return err
	}
	w.Logger.Info("media probed", "ingest_id", row.ID, "probe_ms", time.Since(start).Milliseconds(), "width", info.Width, "height", info.Height, "duration_ms", info.DurationMS)
	if err = w.Store.Stage(ctx, row, "probing", "processing"); err != nil {
		return err
	}
	start = time.Now()
	result, err := Normalize(ctx, w.Config, input, workspace, info)
	if err != nil {
		return err
	}
	w.Logger.Info("media normalized", "ingest_id", row.ID, "transcode_ms", time.Since(start).Milliseconds())
	if err = w.Store.Stage(ctx, row, "processing", "finalizing"); err != nil {
		return err
	}
	if err = w.finalize(ctx, row, result); err != nil {
		return err
	}
	if err = w.Objects.RemoveObject(ctx, w.Config.QuarantineBucket, row.QuarantineKey, minio.RemoveObjectOptions{}); err == nil {
		_, _ = w.Store.Pool.Exec(ctx, `UPDATE media_ingests SET quarantine_cleaned_at=NOW() WHERE id=$1 AND status='ready'`, row.ID)
	}
	return nil
}

type finalBlob struct {
	id, hash, key, path, mime, marker string
	size                              int64
}

func fileBlob(path, mime, marker string) (finalBlob, error) {
	f, err := os.Open(path)
	if err != nil {
		return finalBlob{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return finalBlob{}, err
	}
	hash := hex.EncodeToString(h.Sum(nil))
	return finalBlob{id: uuid.NewString(), hash: hash, key: "blobs/v1/sha256/" + hash[:2] + "/" + hash, path: path, mime: mime, marker: marker, size: n}, nil
}

func marker(info minio.ObjectInfo, name string) string {
	for k, v := range info.UserMetadata {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return info.Metadata.Get("X-Amz-Meta-" + name)
}

// Only Process calls finalize, after Normalize has re-probed the canonical files.
func (w *Worker) finalize(ctx context.Context, row *Ingest, p Processed) error {
	if err := checkSize(p.VideoPath, MaxOutputBytes); err != nil {
		return err
	}
	if err := checkSize(p.PosterPath, MaxPosterBytes); err != nil {
		return err
	}
	video, err := fileBlob(p.VideoPath, "video/mp4", "void-sanitized-video")
	if err != nil {
		return err
	}
	poster, err := fileBlob(p.PosterPath, "image/webp", "void-sanitized-image")
	if err != nil {
		return err
	}
	blobs := []*finalBlob{&video, &poster}
	sort.Slice(blobs, func(i, j int) bool { return blobs[i].hash < blobs[j].hash })
	tx, err := w.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "attachment-staged-quota:"+row.UploaderID); err != nil {
		return err
	}
	var status string
	var token *string
	if err = tx.QueryRow(ctx, `SELECT status,lease_token::text FROM media_ingests WHERE id=$1 AND uploader_id=$2 AND conversation_id=$3 FOR UPDATE`, row.ID, row.UploaderID, row.ConversationID).Scan(&status, &token); err != nil {
		return err
	}
	if status == "ready" {
		return nil
	}
	if status != "finalizing" || token == nil || *token != row.LeaseToken {
		return errors.New("media lease lost")
	}
	for _, blob := range blobs {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "attachment-blob:"+blob.hash); err != nil {
			return err
		}
		var id, bucket, key, mime, state string
		var size int64
		var inline bool
		err = tx.QueryRow(ctx, `SELECT id::text,bucket,object_key,size_bytes,content_type,inline,status FROM attachment_blobs WHERE content_hash=$1 FOR UPDATE`, blob.hash).Scan(&id, &bucket, &key, &size, &mime, &inline, &state)
		if err == nil {
			if bucket != w.Config.AttachmentBucket || key != blob.key || mime != blob.mime || !inline || size != blob.size || state != "ready" {
				return invalid("MEDIA_BLOB_CONFLICT")
			}
			blob.id = id
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		} else {
			file, err := os.Open(blob.path)
			if err != nil {
				return err
			}
			_, err = w.Objects.PutObject(ctx, w.Config.AttachmentBucket, blob.key, file, blob.size, minio.PutObjectOptions{ContentType: blob.mime, ContentDisposition: `inline; filename="attachment.bin"`, UserMetadata: map[string]string{blob.marker: "1"}, DisableMultipart: true})
			file.Close()
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO attachment_blobs(id,content_hash,bucket,object_key,size_bytes,content_type,inline,status,ref_count,orphaned_at)
              VALUES($1,$2,$3,$4,$5,$6,true,'ready',0,NOW())`, blob.id, blob.hash, w.Config.AttachmentBucket, blob.key, blob.size, blob.mime)
			if err != nil {
				return err
			}
		}
		stat, err := w.Objects.StatObject(ctx, w.Config.AttachmentBucket, blob.key, minio.StatObjectOptions{})
		if err != nil {
			return err
		}
		if stat.Size != blob.size || stat.ContentType != blob.mime || marker(stat, blob.marker) != "1" {
			return invalid("MEDIA_STORED_OUTPUT_INVALID")
		}
	}
	metadata, err := json.Marshal(map[string]interface{}{"mime": "video/mp4", "width": p.Info.Width, "height": p.Info.Height, "duration_ms": p.Info.DurationMS,
		"poster": map[string]int{"width": p.PosterWidth, "height": p.PosterHeight}})
	if err != nil {
		return err
	}
	ttl := w.Config.StagedTTL
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	_, err = tx.Exec(ctx, `INSERT INTO attachment_objects(id,conversation_id,uploader_id,bucket,object_key,blob_id,poster_blob_id,filename,status,size_bytes,staged_at,expires_at,video_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'staged',$9,NOW(),NOW()+($11*INTERVAL '1 second'),$10)`, row.ID, row.ConversationID, row.UploaderID, w.Config.AttachmentBucket, video.key, video.id, poster.id, row.Filename, video.size, metadata, ttl.Seconds())
	if err != nil {
		return err
	}
	updated, err := tx.Exec(ctx, `UPDATE media_ingests SET status='ready',final_attachment_id=$1,completed_at=NOW(),updated_at=NOW(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$2 AND lease_until>NOW() AND status='finalizing'`, row.ID, row.LeaseToken)
	if err != nil {
		return err
	}
	if updated.RowsAffected() != 1 {
		return errors.New("media lease expired before finalization")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	w.Logger.Info("media finalized", "ingest_id", row.ID, "output_bytes", video.size, "width", p.Info.Width, "height", p.Info.Height, "duration_ms", p.Info.DurationMS)
	return nil
}

func (w *Worker) Reconcile(ctx context.Context) error {
	if err := w.Store.Republish(ctx, w.Queue.Publish); err != nil {
		return err
	}
	_, err := w.Store.Pool.Exec(ctx, `UPDATE media_ingests SET status='failed',error_code='MEDIA_ABANDONED',completed_at=NOW(),updated_at=NOW()
      WHERE id IN (SELECT id FROM media_ingests WHERE status IN ('uploading','queued') AND expires_at<NOW() ORDER BY expires_at LIMIT 20 FOR UPDATE SKIP LOCKED)`)
	if err != nil {
		return err
	}
	rows, err := w.Store.Pool.Query(ctx, `SELECT id::text,quarantine_object_key FROM media_ingests WHERE status IN ('ready','failed','cancelled')
      AND completed_at<NOW()-INTERVAL '3 minutes' AND quarantine_cleaned_at IS NULL ORDER BY completed_at LIMIT 20`)
	if err != nil {
		return err
	}
	type entry struct{ id, key string }
	entries := []entry{}
	for rows.Next() {
		var e entry
		if err = rows.Scan(&e.id, &e.key); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, e)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, e := range entries {
		if err = w.Objects.RemoveObject(ctx, w.Config.QuarantineBucket, e.key, minio.RemoveObjectOptions{}); err != nil {
			return err
		}
		if _, err = w.Store.Pool.Exec(ctx, `UPDATE media_ingests SET quarantine_cleaned_at=NOW() WHERE id=$1 AND status IN ('ready','failed','cancelled')`, e.id); err != nil {
			return err
		}
	}
	count := 0
	scanCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	for object := range w.Objects.ListObjects(scanCtx, w.Config.QuarantineBucket, minio.ListObjectsOptions{Prefix: "video/", Recursive: true, StartAfter: w.cleanupCursor}) {
		if object.Err != nil {
			return object.Err
		}
		w.cleanupCursor = object.Key
		count++
		if object.LastModified.Before(time.Now().Add(-24 * time.Hour)) {
			var active bool
			if err = w.Store.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_ingests WHERE quarantine_object_key=$1 AND status IN ('uploading','queued','probing','processing','finalizing'))`, object.Key).Scan(&active); err != nil {
				return err
			}
			if !active {
				if err = w.Objects.RemoveObject(ctx, w.Config.QuarantineBucket, object.Key, minio.RemoveObjectOptions{}); err != nil {
					return err
				}
			}
		}
		if count >= 100 {
			break
		}
	}
	if count < 100 {
		w.cleanupCursor = ""
	}
	// The existing attachment GC owns orphaned normalized blobs and posters.
	// Killed-process workspaces are older than any live job lease before removal.
	dirs, _ := os.ReadDir(w.Config.TempRoot)
	for _, dir := range dirs {
		if !dir.IsDir() || len(dir.Name()) < 73 {
			continue
		}
		info, e := dir.Info()
		if e != nil || time.Since(info.ModTime()) < 2*w.Config.LeaseDuration {
			continue
		}
		id, token := dir.Name()[:36], dir.Name()[37:73]
		if _, e = uuid.Parse(id); e != nil {
			continue
		}
		if _, e = uuid.Parse(token); e != nil {
			continue
		}
		var active bool
		if e = w.Store.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_ingests WHERE id=$1 AND lease_token=$2 AND lease_until>NOW())`, id, token).Scan(&active); e != nil {
			return e
		}
		if !active {
			_ = os.RemoveAll(filepath.Join(w.Config.TempRoot, dir.Name()))
		}
	}
	return nil
}
