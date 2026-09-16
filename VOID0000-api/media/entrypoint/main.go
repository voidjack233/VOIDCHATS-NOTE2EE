package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"
	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/media"
)

func main() {
	_ = godotenv.Load(".env")
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		port := os.Getenv("MEDIA_WORKER_PORT")
		if port == "" {
			port = "3007"
		}
		client := http.Client{Timeout: 3 * time.Second}
		res, err := client.Get("http://127.0.0.1:" + port + "/ready")
		if err != nil {
			os.Exit(1)
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
		if res.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("media worker stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	c, err := media.LoadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	poolConfig, err := pgxpool.ParseConfig(c.PostgresURL)
	if err != nil {
		return errors.New("invalid media PostgreSQL configuration")
	}
	poolConfig.MaxConns = 4
	poolConfig.ConnConfig.ConnectTimeout = 3 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return errors.New("media PostgreSQL initialization failed")
	}
	defer func() {
		done := make(chan struct{})
		go func() { pool.Close(); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
			logger.Warn("media database shutdown deadline")
		}
	}()
	valkey := redis.NewClient(&redis.Options{Addr: c.ValkeyAddress, DB: c.ValkeyDB, ReadTimeout: 5 * time.Second, WriteTimeout: 3 * time.Second, ContextTimeoutEnabled: true, MaxRetries: 1, PoolSize: 3})
	defer valkey.Close()
	objects, err := minio.New(c.MinioEndpoint, &minio.Options{Creds: credentials.NewStaticV4(c.MinioAccessKey, c.MinioSecretKey, ""), Secure: c.MinioSecure, Region: c.MinioRegion})
	if err != nil {
		return errors.New("media object storage initialization failed")
	}
	worker := &media.Worker{Config: c, Store: &media.Store{Pool: pool, LeaseDuration: c.LeaseDuration},
		Queue: &media.Queue{Client: valkey, Consumer: uuid.NewString(), StaleAfter: c.LeaseDuration}, Objects: objects, Logger: logger}
	initialize, cancelInitialize := context.WithTimeout(ctx, 15*time.Second)
	err = worker.Initialize(initialize)
	cancelInitialize()
	if err != nil {
		return errors.New("media dependencies, tools, private storage or migrations unavailable")
	}
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); worker.Run(ctx) }()
	recoveryDone := make(chan struct{})
	go func() {
		defer close(recoveryDone)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			recovery, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := worker.Reconcile(recovery)
			cancel()
			if err != nil && ctx.Err() == nil {
				logger.Warn("media recovery deferred")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	handler := media.HealthHandler(media.HealthChecks{
		Postgres: func(ctx context.Context) error {
			_, err := pool.Exec(ctx, `SELECT id,status,lease_token FROM media_ingests LIMIT 0`)
			return err
		},
		Valkey: func(ctx context.Context) error { return valkey.Ping(ctx).Err() },
		Storage: func(ctx context.Context) error {
			for _, bucket := range []string{c.AttachmentBucket, c.QuarantineBucket} {
				exists, err := objects.BucketExists(ctx, bucket)
				if err != nil {
					return err
				}
				if !exists {
					return errors.New("media bucket missing")
				}
			}
			return nil
		},
		Processor: func(ctx context.Context) error { return media.CheckTools(ctx, c) },
	})
	server := &http.Server{Addr: net.JoinHostPort(c.Host, strconv.Itoa(c.Port)), Handler: handler, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	serveErrors := make(chan error, 1)
	go func() {
		logger.Info("media worker listening", "port", c.Port, "processing_concurrency", 1)
		serveErrors <- server.ListenAndServe()
	}()
	var listenerErr error
	select {
	case <-ctx.Done():
	case err := <-serveErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenerErr = fmt.Errorf("media health listener: %w", err)
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	stop()
	if err := server.Shutdown(shutdown); err != nil {
		_ = server.Close()
		return err
	}
	select {
	case <-workerDone:
	case <-shutdown.Done():
		return errors.New("media worker shutdown deadline")
	}
	select {
	case <-recoveryDone:
	case <-shutdown.Done():
		return errors.New("media recovery shutdown deadline")
	}
	return listenerErr
}
