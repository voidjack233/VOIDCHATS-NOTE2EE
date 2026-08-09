package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/internal/vmd"
)

func postgresURL(config vmd.Config) string {
	databaseURL := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(config.PostgresUser, config.PostgresPassword),
		Host:   net.JoinHostPort(config.PostgresHost, strconv.Itoa(config.PostgresPort)),
		Path:   config.PostgresDatabase,
	}
	query := databaseURL.Query()
	query.Set("sslmode", config.PostgresSSLMode)
	databaseURL.RawQuery = query.Encode()
	return databaseURL.String()
}

func main() {
	_ = godotenv.Load(".env")
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	config, err := vmd.LoadConfig()
	if err != nil {
		logger.Error("VMD configuration is invalid", "error", err)
		os.Exit(1)
	}

	poolConfig, err := pgxpool.ParseConfig(postgresURL(config))
	if err != nil {
		logger.Error("VMD PostgreSQL configuration failed", "error", err)
		os.Exit(1)
	}
	poolConfig.MaxConns = config.PostgresMaxConnections
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		logger.Error("VMD PostgreSQL pool creation failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	minioClient, err := minio.New(
		net.JoinHostPort(config.MinioEndpoint, strconv.Itoa(config.MinioPort)),
		&minio.Options{
			Creds:  credentials.NewStaticV4(config.MinioAccessKey, config.MinioSecretKey, ""),
			Secure: config.MinioUseSSL,
			Region: config.MinioRegion,
		},
	)
	if err != nil {
		logger.Error("VMD MinIO client creation failed", "error", err)
		os.Exit(1)
	}

	storage := vmd.NewStorage(config, pool, minioClient, logger)
	defer storage.Close()
	handler, err := vmd.NewHandler(config, vmd.HTTPDependencies{
		Render:  storage.Render,
		Metrics: storage.Metrics,
		CheckPostgres: func(ctx context.Context) error {
			return pool.Ping(ctx)
		},
		CheckMinio: func(ctx context.Context) error {
			exists, checkErr := minioClient.BucketExists(ctx, config.AttachmentBucket)
			if checkErr != nil {
				return checkErr
			}
			if !exists {
				return fmt.Errorf("attachment bucket does not exist")
			}
			return nil
		},
		CheckTransform: storage.PingTransform,
	}, logger)
	if err != nil {
		logger.Error("VMD HTTP handler creation failed", "error", err)
		os.Exit(1)
	}

	rootContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		cacheContext, cancel := context.WithTimeout(rootContext, 30*time.Second)
		defer cancel()
		if initializeErr := storage.InitializeCache(cacheContext); initializeErr != nil {
			logger.Warn("VMD persistent cache initialization failed; continuing without initialization", "error", initializeErr)
			return
		}
		logger.Info("VMD persistent cache storage ready", "bucket", config.CacheBucket, "retention_days", config.CacheRetentionDays)
	}()

	httpServer := &http.Server{
		Addr:              net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      config.RenderTimeout + 15*time.Second,
		IdleTimeout:       75 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("VMD service running", "host", config.Host, "port", config.Port, "pid", os.Getpid())
		serverErrors <- httpServer.ListenAndServe()
	}()

	select {
	case <-rootContext.Done():
		logger.Info("VMD service shutting down")
	case serveErr := <-serverErrors:
		if serveErr != nil && serveErr != http.ErrServerClosed {
			logger.Error("VMD HTTP server failed", "error", serveErr)
			os.Exit(1)
		}
		return
	}
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancelShutdown()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		logger.Error("VMD graceful shutdown failed", "error", err)
		_ = httpServer.Close()
	}
}
