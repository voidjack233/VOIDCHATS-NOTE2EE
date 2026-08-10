package vmd

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

type Storage struct {
	config      Config
	pool        *pgxpool.Pool
	minio       *minio.Client
	transformer *TransformClient
	queue       *WorkQueue[Image]
	flights     *FlightGroup[Image]
	metrics     Metrics
	logger      *slog.Logger
	warningMu   sync.Mutex
	warnings    map[string]time.Time
}

func NewStorage(config Config, pool *pgxpool.Pool, minioClient *minio.Client, logger *slog.Logger) *Storage {
	return &Storage{
		config:      config,
		pool:        pool,
		minio:       minioClient,
		transformer: NewTransformClient(config.TransformSocketPath, config.TransformTimeout, config.MaxSourceBytes, config.MaxVariantBytes),
		queue:       NewWorkQueue[Image](config.MaxConcurrentTransforms, config.MaxQueuedTransforms, config.QueueWaitTimeout, logger),
		flights:     NewFlightGroup[Image](config.MaxActiveFlights),
		logger:      logger,
		warnings:    make(map[string]time.Time),
	}
}

func (s *Storage) Metrics() map[string]any {
	return s.metrics.Snapshot(s.queue.Snapshot())
}

func (s *Storage) Shutdown(ctx context.Context) error {
	return s.queue.Shutdown(ctx)
}

func (s *Storage) warnCacheFailure(kind string, err error) {
	s.warningMu.Lock()
	now := time.Now()
	last := s.warnings[kind]
	if now.Sub(last) < time.Minute {
		s.warningMu.Unlock()
		return
	}
	s.warnings[kind] = now
	s.warningMu.Unlock()
	s.logger.Warn("VMD persistent cache degraded", "kind", kind, "error", err)
}

func (s *Storage) findAttachmentObject(ctx context.Context, attachmentID string) (string, error) {
	var objectKey string
	err := s.pool.QueryRow(
		ctx,
		`SELECT blob.object_key
		 FROM attachment_objects AS attachment
		 JOIN attachment_blobs AS blob
		   ON blob.id = attachment.blob_id
		 WHERE attachment.id = $1
		   AND blob.bucket = $2
		 LIMIT 1`,
		attachmentID,
		s.config.AttachmentBucket,
	).Scan(&objectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", mediaError(404, "VMD_ATTACHMENT_NOT_FOUND", "Attachment not found", nil)
	}
	if err != nil {
		return "", wrapInternal("find attachment object", err)
	}
	return objectKey, nil
}

func (s *Storage) statSource(ctx context.Context, objectKey string) (minio.ObjectInfo, error) {
	objectInfo, err := s.minio.StatObject(
		ctx,
		s.config.AttachmentBucket,
		objectKey,
		minio.StatObjectOptions{},
	)
	if err == nil {
		return objectInfo, nil
	}
	if isMissingObjectError(err) {
		return minio.ObjectInfo{}, mediaError(404, "VMD_ATTACHMENT_NOT_FOUND", "Attachment not found", err)
	}
	return minio.ObjectInfo{}, mediaError(502, "VMD_STORAGE_UNAVAILABLE", "Attachment storage is unavailable", err)
}

func (s *Storage) readSource(ctx context.Context, objectKey string, expectedSize int64) ([]byte, error) {
	if expectedSize > s.config.MaxSourceBytes {
		return nil, mediaError(413, "VMD_SOURCE_TOO_LARGE", "Attachment exceeds the VMD source limit", nil)
	}
	body, err := readBoundedObject(
		ctx,
		s.minio,
		s.config.AttachmentBucket,
		objectKey,
		expectedSize,
		s.config.MaxSourceBytes,
	)
	if err != nil {
		if isMissingObjectError(err) {
			return nil, mediaError(404, "VMD_ATTACHMENT_NOT_FOUND", "Attachment not found", err)
		}
		if strings.Contains(err.Error(), "size limit") || strings.Contains(err.Error(), "invalid size") {
			return nil, mediaError(413, "VMD_SOURCE_TOO_LARGE", "Attachment exceeds the VMD source limit", err)
		}
		return nil, mediaError(502, "VMD_STORAGE_UNAVAILABLE", "Attachment storage read failed", err)
	}
	return body, nil
}

func (s *Storage) renderStoredImage(ctx context.Context, attachmentID, variant string) (Image, error) {
	objectKey, err := s.findAttachmentObject(ctx, attachmentID)
	if err != nil {
		return Image{}, err
	}
	objectInfo, err := s.statSource(ctx, objectKey)
	if err != nil {
		return Image{}, err
	}
	if !trustedInlineImage(objectInfo) {
		return Image{}, mediaError(415, "VMD_ATTACHMENT_NOT_SANITIZED", "Attachment is not an approved sanitized image", nil)
	}

	identity, err := CreateCacheIdentity(attachmentID, objectKey, variant, objectInfo)
	if err != nil {
		return Image{}, wrapInternal("create VMD cache identity", err)
	}
	cached := readCachedImage(ctx, s.minio, s.config.CacheBucket, identity, s.config.MaxVariantBytes)
	switch cached.status {
	case "hit":
		s.metrics.persistentCacheHits.Add(1)
		return cached.image, nil
	case "corrupt":
		s.metrics.persistentCacheMisses.Add(1)
		s.metrics.persistentCacheCorrupt.Add(1)
	case "unavailable":
		s.metrics.persistentCacheMisses.Add(1)
		s.metrics.persistentCacheReadFailures.Add(1)
		s.warnCacheFailure("read unavailable; regenerating from source", cached.err)
	default:
		s.metrics.persistentCacheMisses.Add(1)
	}

	generated, err := s.queue.Run(ctx, func() (Image, error) {
		source, readErr := s.readSource(ctx, objectKey, objectInfo.Size)
		if readErr != nil {
			return Image{}, readErr
		}
		image, transformErr := s.transformer.Transform(ctx, source, variant)
		if transformErr != nil {
			return Image{}, transformErr
		}
		s.metrics.transformsGenerated.Add(1)
		return image, nil
	})
	if err != nil {
		var media *MediaError
		if errors.As(err, &media) {
			switch media.Code {
			case "VMD_AT_CAPACITY":
				s.metrics.queueFull.Add(1)
			case "VMD_QUEUE_TIMEOUT":
				s.metrics.queueTimeouts.Add(1)
			}
		}
		return Image{}, err
	}

	etag, err := writeCachedImage(
		ctx,
		s.minio,
		s.config.CacheBucket,
		identity,
		generated,
		s.config.MaxVariantBytes,
	)
	if err != nil {
		s.metrics.persistentCacheWriteFailure.Add(1)
		s.warnCacheFailure("write failed; serving generated response", err)
	} else {
		generated.ETag = etag
	}
	return generated, nil
}

func (s *Storage) Render(requestContext context.Context, attachmentID, variant string) (Image, error) {
	flightKey := fmt.Sprintf("%s:%s", strings.ToLower(attachmentID), variant)
	operationContext, cancel := context.WithTimeout(context.Background(), s.config.RenderTimeout)
	defer cancel()
	return s.flights.Do(requestContext, flightKey, func() (Image, error) {
		return s.renderStoredImage(operationContext, attachmentID, variant)
	})
}

func (s *Storage) InitializeCache(ctx context.Context) error {
	exists, err := s.minio.BucketExists(ctx, s.config.CacheBucket)
	if err != nil {
		return err
	}
	if !exists {
		if err := s.minio.MakeBucket(ctx, s.config.CacheBucket, minio.MakeBucketOptions{}); err != nil {
			return err
		}
	}
	if err := s.minio.SetBucketPolicy(ctx, s.config.CacheBucket, ""); err != nil {
		response := minio.ToErrorResponse(err)
		if response.Code != "NoSuchBucketPolicy" {
			return err
		}
	}
	lifecycleConfig := lifecycle.NewConfiguration()
	lifecycleConfig.Rules = []lifecycle.Rule{{
		ID:     "expire-vmd-derived-variants",
		Status: "Enabled",
		RuleFilter: lifecycle.Filter{
			Prefix: "variants/",
		},
		Expiration: lifecycle.Expiration{
			Days: lifecycle.ExpirationDays(s.config.CacheRetentionDays),
		},
	}}
	return s.minio.SetBucketLifecycle(ctx, s.config.CacheBucket, lifecycleConfig)
}

func (s *Storage) PingTransform(ctx context.Context) error {
	return s.transformer.Ping(ctx)
}
