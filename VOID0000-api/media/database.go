package media

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Ingest struct {
	ID             string
	ConversationID string
	UploaderID     string
	Status         string
	QuarantineKey  string
	Filename       string
	SourceBytes    int64
	LeaseToken     string
	Attempt        int
	CreatedAt      time.Time
}

type Store struct {
	Pool          *pgxpool.Pool
	LeaseDuration time.Duration
}

type ClaimResult struct {
	Ingest   *Ingest
	Terminal bool
}

func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

// A lease is also a fencing token. Every later mutation must compare that exact
// token: an old process cannot finalize an ingest claimed by its replacement.
func (s *Store) Claim(ctx context.Context, job Job) (ClaimResult, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return ClaimResult{}, err
	}
	defer rollback(tx)
	var row Ingest
	var available bool
	err = tx.QueryRow(ctx, `SELECT id::text, conversation_id::text, uploader_id::text, status,
       quarantine_object_key, filename, COALESCE(source_bytes,0), attempt_count, created_at,
       (lease_until IS NULL OR lease_until <= NOW())
       FROM media_ingests WHERE id=$1 AND conversation_id=$2 FOR UPDATE`, job.IngestID, job.ConversationID).
		Scan(&row.ID, &row.ConversationID, &row.UploaderID, &row.Status, &row.QuarantineKey, &row.Filename, &row.SourceBytes, &row.Attempt, &row.CreatedAt, &available)
	if errors.Is(err, pgx.ErrNoRows) {
		return ClaimResult{Terminal: true}, nil
	}
	if err != nil {
		return ClaimResult{}, err
	}
	if IsTerminal(row.Status) {
		return ClaimResult{Terminal: true}, nil
	}
	if row.Status == "uploading" || !available {
		return ClaimResult{}, nil
	}
	if row.Attempt >= MaxAttempts {
		_, err = tx.Exec(ctx, `UPDATE media_ingests SET status='failed',error_code='MEDIA_RETRY_EXHAUSTED',
          completed_at=NOW(),updated_at=NOW(),lease_token=NULL,lease_until=NULL WHERE id=$1`, row.ID)
		if err != nil {
			return ClaimResult{}, err
		}
		err = tx.Commit(ctx)
		return ClaimResult{Terminal: err == nil}, err
	}
	row.LeaseToken = uuid.NewString()
	row.Attempt++
	row.Status = "probing"
	_, err = tx.Exec(ctx, `UPDATE media_ingests SET status='probing',attempt_count=attempt_count+1,
       lease_token=$2,lease_until=NOW()+($3*INTERVAL '1 second'),processing_started_at=NOW(),
       updated_at=NOW(),error_code=NULL WHERE id=$1`, row.ID, row.LeaseToken, s.LeaseDuration.Seconds())
	if err != nil {
		return ClaimResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ClaimResult{}, err
	}
	return ClaimResult{Ingest: &row}, nil
}

func IsTerminal(status string) bool {
	return status == "ready" || status == "failed" || status == "cancelled"
}

func (s *Store) Stage(ctx context.Context, row *Ingest, from, to string) error {
	if !((from == "probing" && to == "processing") || (from == "processing" && to == "finalizing")) {
		return errors.New("invalid media stage transition")
	}
	result, err := s.Pool.Exec(ctx, `UPDATE media_ingests SET status=$3,updated_at=NOW()
      WHERE id=$1 AND lease_token=$2 AND status=$4 AND lease_until>NOW()`, row.ID, row.LeaseToken, to, from)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("media lease lost")
	}
	row.Status = to
	return nil
}

// Infrastructure failure is retried, but never acknowledged as successful work.
// Permanent errors retain the row until cleanup has removed its private source.
func (s *Store) Fail(ctx context.Context, row *Ingest, code string, retry bool) (bool, error) {
	if len(code) == 0 || len(code) > 80 {
		return false, errors.New("invalid media error code")
	}
	if retry && row.Attempt < MaxAttempts {
		result, err := s.Pool.Exec(ctx, `UPDATE media_ingests SET status='queued',error_code=$3,
         lease_token=NULL,lease_until=NULL,updated_at=NOW(),last_enqueued_at=NOW()
         WHERE id=$1 AND lease_token=$2 AND status IN ('probing','processing','finalizing') AND lease_until>NOW()`, row.ID, row.LeaseToken, code)
		if err != nil {
			return false, err
		}
		if result.RowsAffected() != 1 {
			return false, errors.New("media lease lost")
		}
		return false, nil
	}
	result, err := s.Pool.Exec(ctx, `UPDATE media_ingests SET status='failed',error_code=$3,
       lease_token=NULL,lease_until=NULL,updated_at=NOW(),completed_at=NOW()
       WHERE id=$1 AND lease_token=$2 AND status IN ('probing','processing','finalizing') AND lease_until>NOW()`, row.ID, row.LeaseToken, code)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() != 1 {
		return false, errors.New("media lease lost")
	}
	return true, nil
}

// Rate-limited DB outbox recovery covers failed XADD, lost/trimmed stream entries,
// and dead workers. Holding row locks through publication prevents replica floods.
func (s *Store) Republish(ctx context.Context, publish func(context.Context, Job) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	rows, err := tx.Query(ctx, `SELECT id::text,conversation_id::text FROM media_ingests
      WHERE status IN ('queued','probing','processing','finalizing')
        AND (lease_until IS NULL OR lease_until<=NOW())
        AND (last_enqueued_at IS NULL OR last_enqueued_at<NOW()-INTERVAL '60 seconds')
      ORDER BY updated_at,id LIMIT 10 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	jobs := []Job{}
	for rows.Next() {
		var job Job
		if err = rows.Scan(&job.IngestID, &job.ConversationID); err != nil {
			rows.Close()
			return err
		}
		jobs = append(jobs, job)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, job := range jobs {
		if err = publish(ctx, job); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE media_ingests SET last_enqueued_at=NOW() WHERE id=$1`, job.IngestID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
