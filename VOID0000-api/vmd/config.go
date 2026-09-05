package vmd

import (
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultMaxSourceBytes          = 12 * 1024 * 1024
	defaultMaxVariantBytes         = 16 * 1024 * 1024
	defaultMaxConcurrentTransforms = 2
	defaultMaxQueuedTransforms     = 8
	defaultQueueWaitTimeout        = 10 * time.Second
	defaultRenderTimeout           = 2 * time.Minute
	defaultTransformTimeout        = 90 * time.Second
	defaultReadinessTimeout        = 1200 * time.Millisecond
	defaultCacheRetentionDays      = 30
	defaultMaxActiveFlights        = 5000
	defaultPostgresConnections     = 10
	maxPostgresConnections         = 50
	signingKeyContext              = "void:vmd:capability-signing-key:v1"
)

type Config struct {
	Host                    string
	Port                    int
	SigningKey              []byte
	PostgresHost            string
	PostgresPort            int
	PostgresDatabase        string
	PostgresUser            string
	PostgresPassword        string
	PostgresSSLMode         string
	PostgresMaxConnections  int32
	MinioEndpoint           string
	MinioPort               int
	MinioAccessKey          string
	MinioSecretKey          string
	MinioUseSSL             bool
	MinioRegion             string
	AttachmentBucket        string
	CacheBucket             string
	CacheRetentionDays      int
	MaxSourceBytes          int64
	MaxVariantBytes         int64
	MaxConcurrentTransforms int
	MaxQueuedTransforms     int
	QueueWaitTimeout        time.Duration
	RenderTimeout           time.Duration
	TransformTimeout        time.Duration
	TransformSocketPath     string
	ReadinessTimeout        time.Duration
	MaxActiveFlights        int
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("missing required setting %s", name)
	}
	return value, nil
}

func positiveInt(value string, fallback, maximum int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return fallback
	}
	if parsed > maximum {
		return maximum
	}
	return parsed
}

func nonNegativeInt(value string, fallback, maximum int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 {
		return fallback
	}
	if parsed > maximum {
		return maximum
	}
	return parsed
}

func defaultTransformSocketPath() string {
	return filepath.Join(
		os.TempDir(),
		fmt.Sprintf("voidapp-vmd-transform-%d", os.Getuid()),
		"worker.sock",
	)
}

func deriveSigningKey(secret string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signingKeyContext))
	return mac.Sum(nil)
}

func LoadConfig() (Config, error) {
	pgHost, err := requiredEnv("PGHOST")
	if err != nil {
		return Config{}, err
	}
	pgDatabase, err := requiredEnv("PGDATABASE")
	if err != nil {
		return Config{}, err
	}
	pgUser, err := requiredEnv("PGUSER")
	if err != nil {
		return Config{}, err
	}
	pgPassword, err := requiredEnv("PGPASSWORD")
	if err != nil {
		return Config{}, err
	}
	isProduction := os.Getenv("NODE_ENV") == "production"
	minioAccessKey := strings.TrimSpace(os.Getenv("MINIO_ACCESS_KEY"))
	minioSecretKey := strings.TrimSpace(os.Getenv("MINIO_SECRET_KEY"))
	if !isProduction {
		if minioAccessKey == "" {
			minioAccessKey = "minioadmin"
		}
		if minioSecretKey == "" {
			minioSecretKey = "minioadmin"
		}
	}
	if minioAccessKey == "" || minioSecretKey == "" {
		return Config{}, fmt.Errorf("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required")
	}
	if isProduction && (minioAccessKey == "minioadmin" || minioSecretKey == "minioadmin") {
		return Config{}, fmt.Errorf("default MinIO credentials are not allowed in production")
	}

	signingSecret := os.Getenv("VMD_SIGNING_SECRET")
	if signingSecret == "" {
		signingSecret = os.Getenv("ACCESS_SECRET")
	}
	if len(signingSecret) < 32 {
		return Config{}, fmt.Errorf("VMD requires VMD_SIGNING_SECRET or ACCESS_SECRET with at least 32 characters")
	}

	socketPath := strings.TrimSpace(os.Getenv("VMD_TRANSFORM_SOCKET_PATH"))
	if socketPath == "" {
		socketPath = defaultTransformSocketPath()
	}
	if !filepath.IsAbs(socketPath) || strings.ContainsRune(socketPath, '\x00') {
		return Config{}, fmt.Errorf("VMD_TRANSFORM_SOCKET_PATH must be an absolute path")
	}
	if len([]byte(socketPath)) > 100 {
		return Config{}, fmt.Errorf("VMD_TRANSFORM_SOCKET_PATH is too long for a Unix socket")
	}

	host := strings.TrimSpace(os.Getenv("HOST"))
	if host == "" {
		host = strings.TrimSpace(os.Getenv("BIND_HOST"))
	}
	if host == "" {
		host = "0.0.0.0"
	}
	if net.ParseIP(host) == nil && host != "localhost" {
		return Config{}, fmt.Errorf("HOST must be an IP address or localhost")
	}

	config := Config{
		Host:                    host,
		Port:                    positiveInt(os.Getenv("VMD_SERVICE_PORT"), 3006, 65535),
		SigningKey:              deriveSigningKey(signingSecret),
		PostgresHost:            pgHost,
		PostgresPort:            positiveInt(os.Getenv("PGPORT"), 5432, 65535),
		PostgresDatabase:        pgDatabase,
		PostgresUser:            pgUser,
		PostgresPassword:        pgPassword,
		PostgresSSLMode:         strings.TrimSpace(os.Getenv("PGSSLMODE")),
		PostgresMaxConnections:  int32(positiveInt(os.Getenv("VMD_PG_MAX_CONNECTIONS"), defaultPostgresConnections, maxPostgresConnections)),
		MinioEndpoint:           strings.TrimSpace(os.Getenv("MINIO_ENDPOINT")),
		MinioPort:               positiveInt(os.Getenv("MINIO_PORT"), 9000, 65535),
		MinioAccessKey:          minioAccessKey,
		MinioSecretKey:          minioSecretKey,
		MinioUseSSL:             os.Getenv("MINIO_USE_SSL") == "true",
		MinioRegion:             strings.TrimSpace(os.Getenv("MINIO_REGION")),
		AttachmentBucket:        strings.TrimSpace(os.Getenv("MINIO_ATTACH_BUCKET")),
		CacheBucket:             strings.TrimSpace(os.Getenv("MINIO_VMD_CACHE_BUCKET")),
		CacheRetentionDays:      positiveInt(os.Getenv("VMD_CACHE_RETENTION_DAYS"), defaultCacheRetentionDays, 365),
		MaxSourceBytes:          int64(positiveInt(os.Getenv("VMD_MAX_SOURCE_BYTES"), defaultMaxSourceBytes, 64*1024*1024)),
		MaxVariantBytes:         int64(positiveInt(os.Getenv("VMD_MAX_VARIANT_BYTES"), defaultMaxVariantBytes, 64*1024*1024)),
		MaxConcurrentTransforms: positiveInt(os.Getenv("VMD_MAX_CONCURRENT_TRANSFORMS"), defaultMaxConcurrentTransforms, 8),
		MaxQueuedTransforms:     nonNegativeInt(os.Getenv("VMD_MAX_QUEUED_TRANSFORMS"), defaultMaxQueuedTransforms, 64),
		QueueWaitTimeout:        time.Duration(positiveInt(os.Getenv("VMD_QUEUE_WAIT_TIMEOUT_MS"), int(defaultQueueWaitTimeout/time.Millisecond), 120000)) * time.Millisecond,
		RenderTimeout:           time.Duration(positiveInt(os.Getenv("VMD_RENDER_TIMEOUT_MS"), int(defaultRenderTimeout/time.Millisecond), 300000)) * time.Millisecond,
		TransformTimeout:        time.Duration(positiveInt(os.Getenv("VMD_TRANSFORM_TIMEOUT_MS"), int(defaultTransformTimeout/time.Millisecond), 300000)) * time.Millisecond,
		TransformSocketPath:     socketPath,
		ReadinessTimeout:        time.Duration(positiveInt(os.Getenv("VMD_READINESS_TIMEOUT_MS"), int(defaultReadinessTimeout/time.Millisecond), 10000)) * time.Millisecond,
		MaxActiveFlights:        nonNegativeInt(os.Getenv("SENTINEL_MAX_ACTIVE_FLIGHTS"), defaultMaxActiveFlights, 100000),
	}
	if config.MinioEndpoint == "" {
		config.MinioEndpoint = "127.0.0.1"
	}
	if config.PostgresSSLMode == "" {
		config.PostgresSSLMode = "disable"
	}
	if config.MinioRegion == "" {
		config.MinioRegion = "us-east-1"
	}
	if config.AttachmentBucket == "" {
		config.AttachmentBucket = "chat-attachments"
	}
	if config.CacheBucket == "" {
		config.CacheBucket = "vmd-variants"
	}

	return config, nil
}
