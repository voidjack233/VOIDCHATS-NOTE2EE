// Package media owns asynchronous video ingest processing, independently of VMD.
package media

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	MaxSourceBytes int64 = 10 * 1024 * 1024
	MaxOutputBytes int64 = 10 * 1024 * 1024
	MaxPosterBytes int64 = 1024 * 1024
	Stream               = "media:video:jobs"
	Group                = "media-workers"
	MaxAttempts          = 3
)

type Config struct {
	Host             string
	Port             int
	PostgresURL      string
	ValkeyAddress    string
	ValkeyDB         int
	MinioEndpoint    string
	MinioAccessKey   string
	MinioSecretKey   string
	MinioRegion      string
	MinioSecure      bool
	AttachmentBucket string
	QuarantineBucket string
	TempRoot         string
	ProbeTimeout     time.Duration
	TranscodeTimeout time.Duration
	JobTimeout       time.Duration
	LeaseDuration    time.Duration
	FFmpeg           string
	FFprobe          string
	StagedTTL        time.Duration
}

func LoadConfig() (Config, error) { return ParseConfig(os.Getenv) }

func ParseConfig(env func(string) string) (Config, error) {
	value := func(key, fallback string) string {
		if s := strings.TrimSpace(env(key)); s != "" {
			return s
		}
		return fallback
	}
	var firstErr error
	integer := func(key string, fallback, min, max int) int {
		s := strings.TrimSpace(env(key))
		if s == "" {
			return fallback
		}
		n, err := strconv.Atoi(s)
		if err != nil || n < min || n > max {
			if firstErr == nil {
				firstErr = fmt.Errorf("invalid %s", key)
			}
			return fallback
		}
		return n
	}
	for _, key := range []string{"PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"} {
		if value(key, "") == "" {
			return Config{}, fmt.Errorf("missing %s", key)
		}
	}
	pgURL := &url.URL{Scheme: "postgres", User: url.UserPassword(env("PGUSER"), env("PGPASSWORD")),
		Host: net.JoinHostPort(env("PGHOST"), strconv.Itoa(integer("PGPORT", 5432, 1, 65535))), Path: env("PGDATABASE")}
	q := pgURL.Query()
	q.Set("sslmode", value("PGSSLMODE", "disable"))
	pgURL.RawQuery = q.Encode()
	probe := time.Duration(integer("MEDIA_FFPROBE_TIMEOUT_SECONDS", 15, 1, 60)) * time.Second
	transcode := time.Duration(integer("MEDIA_FFMPEG_TIMEOUT_SECONDS", 180, 1, 600)) * time.Second
	job := 3*probe + transcode + 120*time.Second
	c := Config{
		Host: value("MEDIA_WORKER_HOST", "127.0.0.1"), Port: integer("MEDIA_WORKER_PORT", 3007, 1, 65535),
		PostgresURL: pgURL.String(), ValkeyAddress: net.JoinHostPort(value("VALKEY_HOST", "127.0.0.1"), strconv.Itoa(integer("VALKEY_PORT", 6379, 1, 65535))),
		ValkeyDB: integer("VALKEY_DB", 0, 0, 15), MinioEndpoint: net.JoinHostPort(value("MINIO_ENDPOINT", "127.0.0.1"), strconv.Itoa(integer("MINIO_PORT", 9000, 1, 65535))),
		MinioAccessKey: env("MINIO_ACCESS_KEY"), MinioSecretKey: env("MINIO_SECRET_KEY"), MinioRegion: value("MINIO_REGION", "us-east-1"),
		MinioSecure: env("MINIO_USE_SSL") == "true", AttachmentBucket: value("MINIO_ATTACH_BUCKET", "chat-attachments"),
		QuarantineBucket: value("MINIO_MEDIA_QUARANTINE_BUCKET", "media-quarantine"),
		TempRoot:         value("MEDIA_TEMP_ROOT", filepath.Join(os.TempDir(), fmt.Sprintf("void-media-%d", os.Getuid()))),
		ProbeTimeout:     probe, TranscodeTimeout: transcode, JobTimeout: job, LeaseDuration: job + time.Minute,
		FFmpeg: value("MEDIA_FFMPEG_PATH", "/usr/bin/ffmpeg"), FFprobe: value("MEDIA_FFPROBE_PATH", "/usr/bin/ffprobe"),
		StagedTTL: time.Duration(integer("ATTACHMENT_STAGED_TTL_SECONDS", 86400, 1, 604800)) * time.Second,
	}
	if firstErr != nil {
		return Config{}, firstErr
	}
	if net.ParseIP(c.Host) == nil {
		return Config{}, fmt.Errorf("MEDIA_WORKER_HOST must be an IP address")
	}
	if !filepath.IsAbs(c.TempRoot) || !filepath.IsAbs(c.FFmpeg) || !filepath.IsAbs(c.FFprobe) {
		return Config{}, fmt.Errorf("media executable and workspace paths must be absolute")
	}
	for _, bucket := range []string{c.AttachmentBucket, value("MINIO_BUCKET", "avatars"), value("MINIO_GROUP_AVATAR_BUCKET", "group-avatars"), value("MINIO_VMD_CACHE_BUCKET", "vmd-variants")} {
		if c.QuarantineBucket == bucket {
			return Config{}, fmt.Errorf("quarantine must use a distinct private bucket")
		}
	}
	if env("NODE_ENV") == "production" && (c.MinioAccessKey == "minioadmin" || c.MinioSecretKey == "minioadmin") {
		return Config{}, fmt.Errorf("default MinIO credentials forbidden in production")
	}
	return c, nil
}
