package vmd_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"

	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/internal/vmd"
)

const (
	attachmentID = "11111111-1111-4111-8111-111111111111"
	testSecret   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func signingKey() []byte {
	mac := hmac.New(sha256.New, []byte(testSecret))
	_, _ = mac.Write([]byte("void:vmd:capability-signing-key:v1"))
	return mac.Sum(nil)
}

func capabilitySignature(variant string, expiresAt int64) string {
	payload := "void-vmd-v1\n" + attachmentID + "\n" + variant + "\n" + strconv.FormatInt(expiresAt, 10)
	mac := hmac.New(sha256.New, signingKey())
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func signedPath(variant string, expiresAt int64) string {
	values := url.Values{}
	values.Set("exp", strconv.FormatInt(expiresAt, 10))
	values.Set("sig", capabilitySignature(variant, expiresAt))
	return "/v1/images/" + attachmentID + "/" + variant + "?" + values.Encode()
}

func testHandler(t *testing.T, render func(context.Context, string, string) (vmd.Image, error)) http.Handler {
	t.Helper()
	config := vmd.Config{
		SigningKey:       signingKey(),
		ReadinessTimeout: time.Second,
	}
	handler, err := vmd.NewHandler(config, vmd.HTTPDependencies{
		Render:  render,
		Metrics: func() map[string]any { return map[string]any{} },
		CheckPostgres: func(context.Context) error {
			return nil
		},
		CheckMinio: func(context.Context) error {
			return nil
		},
		CheckTransform: func(context.Context) error {
			return nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func setRequiredConfigEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("PGHOST", "127.0.0.1")
	t.Setenv("PGPORT", "5432")
	t.Setenv("PGDATABASE", "void_test")
	t.Setenv("PGUSER", "void_test")
	t.Setenv("PGPASSWORD", "test-password")
	t.Setenv("ACCESS_SECRET", testSecret)
	t.Setenv("VMD_SIGNING_SECRET", "")
	t.Setenv("HOST", "127.0.0.1")
}

func TestDevelopmentMinioDefaultsAndProductionGuards(t *testing.T) {
	setRequiredConfigEnvironment(t)
	t.Setenv("NODE_ENV", "development")
	t.Setenv("MINIO_ACCESS_KEY", "")
	t.Setenv("MINIO_SECRET_KEY", "")
	config, err := vmd.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.MinioAccessKey != "minioadmin" || config.MinioSecretKey != "minioadmin" {
		t.Fatal("development MinIO defaults changed")
	}

	t.Setenv("NODE_ENV", "production")
	if _, err := vmd.LoadConfig(); err == nil {
		t.Fatal("production accepted missing MinIO credentials")
	}
	t.Setenv("MINIO_ACCESS_KEY", "minioadmin")
	t.Setenv("MINIO_SECRET_KEY", "production-secret")
	if _, err := vmd.LoadConfig(); err == nil {
		t.Fatal("production accepted a default MinIO credential")
	}
}

func TestNodeGeneratedCapabilityFixture(t *testing.T) {
	now := time.Date(2026, time.August, 8, 0, 0, 0, 0, time.UTC)
	verification, err := vmd.VerifyCapability(
		attachmentID,
		"medium",
		"1786150800",
		"2S4hjW6__Y-Cms08m9kd5g9vRfrsSigkDUn9Ss74g8I",
		now,
		signingKey(),
	)
	if err != nil {
		t.Fatalf("Node-generated capability was rejected: %v", err)
	}
	if verification.ExpiresAt != 1786150800 {
		t.Fatalf("unexpected expiration: %d", verification.ExpiresAt)
	}
}

func TestNodeCompatibleCacheIdentity(t *testing.T) {
	identity, err := vmd.CreateCacheIdentity(
		attachmentID,
		"folder/original.bin",
		"small",
		minio.ObjectInfo{
			ETag:         `"ABCDEF0123456789"`,
			VersionID:    "version-7",
			Size:         123456,
			LastModified: time.Date(2026, time.August, 8, 1, 2, 3, 456000000, time.UTC),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	const expectedFingerprint = "907f8125b60c73b7bbc2ffc2639b068e32e291b13726844ff5c0b83453428953"
	if identity.SourceFingerprint != expectedFingerprint {
		t.Fatalf("fingerprint mismatch: %s", identity.SourceFingerprint)
	}
	expectedObjectKey := "variants/v1/" + attachmentID + "/" + expectedFingerprint + "/small.webp"
	if identity.ObjectKey != expectedObjectKey {
		t.Fatalf("object key mismatch: %s", identity.ObjectKey)
	}
}

func TestHTTPImageSuccessAndConditionalCache(t *testing.T) {
	image := vmd.Image{
		Body:        []byte("webp-response"),
		ContentType: "image/webp",
		Width:       480,
		Height:      320,
		Pages:       1,
		ETag:        `"fixed-etag"`,
	}
	handler := testHandler(t, func(_ context.Context, receivedID, variant string) (vmd.Image, error) {
		if receivedID != attachmentID || variant != "small" {
			t.Fatalf("unexpected render input: %s %s", receivedID, variant)
		}
		return image, nil
	})
	expiresAt := time.Now().Add(time.Hour).Unix()

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, signedPath("small", expiresAt), nil))
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("unexpected content type: %s", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("ETag") != image.ETag {
		t.Fatalf("unexpected etag: %s", response.Header().Get("ETag"))
	}
	if response.Header().Get("Cloudflare-CDN-Cache-Control") == "" {
		t.Fatal("missing Cloudflare cache policy")
	}

	conditional := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, signedPath("small", expiresAt), nil)
	request.Header.Set("If-None-Match", image.ETag)
	handler.ServeHTTP(conditional, request)
	if conditional.Code != http.StatusNotModified {
		t.Fatalf("unexpected conditional status: %d", conditional.Code)
	}
}

func TestHTTPRejectsInvalidCapabilityAndUnknownQuery(t *testing.T) {
	var renderCalls atomic.Int32
	handler := testHandler(t, func(context.Context, string, string) (vmd.Image, error) {
		renderCalls.Add(1)
		return vmd.Image{}, nil
	})
	expiresAt := time.Now().Add(time.Hour).Unix()

	invalidSignature := httptest.NewRecorder()
	handler.ServeHTTP(
		invalidSignature,
		httptest.NewRequest(
			http.MethodGet,
			"/v1/images/"+attachmentID+"/small?exp="+strconv.FormatInt(expiresAt, 10)+"&sig=invalid",
			nil,
		),
	)
	if invalidSignature.Code != http.StatusForbidden {
		t.Fatalf("unexpected invalid signature status: %d", invalidSignature.Code)
	}

	unknownQuery := httptest.NewRecorder()
	handler.ServeHTTP(
		unknownQuery,
		httptest.NewRequest(http.MethodGet, signedPath("small", expiresAt)+"&extra=1", nil),
	)
	if unknownQuery.Code != http.StatusBadRequest {
		t.Fatalf("unexpected unknown query status: %d", unknownQuery.Code)
	}
	if renderCalls.Load() != 0 {
		t.Fatalf("renderer ran %d times for rejected requests", renderCalls.Load())
	}
}

func TestReadinessIncludesTransformWorker(t *testing.T) {
	handler := testHandler(t, func(context.Context, string, string) (vmd.Image, error) {
		return vmd.Image{}, nil
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected readiness status: %d", response.Code)
	}
	var payload struct {
		Dependencies map[string]json.RawMessage `json:"dependencies"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload.Dependencies["transform_worker"]; !ok {
		t.Fatal("transform worker readiness is missing")
	}
}

func TestFlightGroupCoalescesSameKey(t *testing.T) {
	group := vmd.NewFlightGroup[int](8)
	leaderStarted := make(chan struct{})
	releaseLeader := make(chan struct{})
	leaderResult := make(chan int, 1)
	leaderError := make(chan error, 1)
	var taskCalls atomic.Int32

	go func() {
		value, err := group.Do(context.Background(), "same-key", func() (int, error) {
			taskCalls.Add(1)
			close(leaderStarted)
			<-releaseLeader
			return 42, nil
		})
		leaderResult <- value
		leaderError <- err
	}()
	<-leaderStarted

	go func() {
		time.Sleep(10 * time.Millisecond)
		close(releaseLeader)
	}()
	followerTaskCalled := false
	followerValue, followerErr := group.Do(context.Background(), "same-key", func() (int, error) {
		followerTaskCalled = true
		return 99, nil
	})
	if followerErr != nil {
		t.Fatal(followerErr)
	}
	if followerValue != 42 || followerTaskCalled {
		t.Fatalf("follower did not share the leader result: value=%d task_called=%t", followerValue, followerTaskCalled)
	}
	if err := <-leaderError; err != nil {
		t.Fatal(err)
	}
	if value := <-leaderResult; value != 42 {
		t.Fatalf("unexpected leader result: %d", value)
	}
	if taskCalls.Load() != 1 {
		t.Fatalf("same-key task ran %d times", taskCalls.Load())
	}
}

func TestFlightGroupFollowerCancellationDoesNotCancelLeader(t *testing.T) {
	group := vmd.NewFlightGroup[int](8)
	leaderStarted := make(chan struct{})
	releaseLeader := make(chan struct{})
	leaderResult := make(chan int, 1)
	leaderError := make(chan error, 1)

	go func() {
		value, err := group.Do(context.Background(), "cancel-key", func() (int, error) {
			close(leaderStarted)
			<-releaseLeader
			return 7, nil
		})
		leaderResult <- value
		leaderError <- err
	}()
	<-leaderStarted

	cancelledContext, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := group.Do(cancelledContext, "cancel-key", func() (int, error) {
		t.Fatal("cancelled follower unexpectedly became the leader")
		return 0, nil
	}); err != context.Canceled {
		t.Fatalf("unexpected follower cancellation error: %v", err)
	}

	close(releaseLeader)
	if err := <-leaderError; err != nil {
		t.Fatal(err)
	}
	if value := <-leaderResult; value != 7 {
		t.Fatalf("leader did not complete after follower cancellation: %d", value)
	}
}

func TestFlightGroupRespectsActiveFlightRegistrationLimit(t *testing.T) {
	group := vmd.NewFlightGroup[int](1)
	leaderStarted := make(chan struct{})
	releaseLeader := make(chan struct{})
	leaderDone := make(chan struct{})

	go func() {
		defer close(leaderDone)
		_, _ = group.Do(context.Background(), "registered-key", func() (int, error) {
			close(leaderStarted)
			<-releaseLeader
			return 1, nil
		})
	}()
	<-leaderStarted

	var overflowCalls atomic.Int32
	for range 2 {
		value, err := group.Do(context.Background(), "overflow-key", func() (int, error) {
			return int(overflowCalls.Add(1)), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if value <= 0 {
			t.Fatalf("unexpected overflow task result: %d", value)
		}
	}
	if overflowCalls.Load() != 2 {
		t.Fatalf("overflow work was unexpectedly registered for coalescing: %d", overflowCalls.Load())
	}

	close(releaseLeader)
	<-leaderDone
}

func TestFlightGroupPanicWakesFollowersAndDoesNotPoisonKey(t *testing.T) {
	group := vmd.NewFlightGroup[int](8)
	leaderStarted := make(chan struct{})
	triggerPanic := make(chan struct{})
	leaderPanic := make(chan any, 1)

	go func() {
		defer func() {
			leaderPanic <- recover()
		}()
		_, _ = group.Do(context.Background(), "panic-key", func() (int, error) {
			close(leaderStarted)
			<-triggerPanic
			panic("expected panic")
		})
	}()
	<-leaderStarted

	go func() {
		time.Sleep(10 * time.Millisecond)
		close(triggerPanic)
	}()
	followerTaskCalled := false
	_, followerErr := group.Do(context.Background(), "panic-key", func() (int, error) {
		followerTaskCalled = true
		return 0, nil
	})
	if followerTaskCalled {
		t.Fatal("panic follower unexpectedly started duplicate work")
	}
	mediaErr, ok := followerErr.(*vmd.MediaError)
	if !ok || mediaErr.Code != "VMD_DELIVERY_FAILED" {
		t.Fatalf("follower received an unsafe panic result: %#v", followerErr)
	}
	if recovered := <-leaderPanic; recovered != "expected panic" {
		t.Fatalf("leader panic was not preserved: %#v", recovered)
	}

	value, err := group.Do(context.Background(), "panic-key", func() (int, error) {
		return 23, nil
	})
	if err != nil || value != 23 {
		t.Fatalf("panic key remained poisoned: value=%d err=%v", value, err)
	}
}

func TestWorkQueueBoundsConcurrencyAndReturnsAllResults(t *testing.T) {
	queue := vmd.NewWorkQueue[int](2, 8, time.Second)
	defer queue.Close()
	var active atomic.Int32
	var maximum atomic.Int32
	var startMu sync.Mutex
	starts := make([]int, 0, 10)
	results := make([]int, 10)
	var wait sync.WaitGroup
	for index := range results {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, err := queue.Run(context.Background(), func() (int, error) {
				current := active.Add(1)
				for {
					observed := maximum.Load()
					if current <= observed || maximum.CompareAndSwap(observed, current) {
						break
					}
				}
				startMu.Lock()
				starts = append(starts, index)
				startMu.Unlock()
				time.Sleep(10 * time.Millisecond)
				active.Add(-1)
				return index, nil
			})
			if err != nil {
				t.Errorf("queue task %d failed: %v", index, err)
				return
			}
			results[index] = value
		}()
	}
	wait.Wait()
	if maximum.Load() > 2 {
		t.Fatalf("maximum active work exceeded bound: %d", maximum.Load())
	}
	for index, value := range results {
		if index != value {
			t.Fatalf("result mismatch at %d: %d", index, value)
		}
	}
	if len(starts) != len(results) {
		t.Fatalf("not all work started: %v", starts)
	}
}

func TestWorkQueueStartsQueuedTasksInFIFOOrder(t *testing.T) {
	queue := vmd.NewWorkQueue[int](1, 3, time.Second)
	defer queue.Close()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	starts := make(chan int, 4)
	results := make(chan int, 4)
	errors := make(chan error, 4)

	go func() {
		value, err := queue.Run(context.Background(), func() (int, error) {
			starts <- 0
			close(firstStarted)
			<-releaseFirst
			return 0, nil
		})
		results <- value
		errors <- err
	}()
	<-firstStarted

	for index := 1; index <= 3; index++ {
		index := index
		go func() {
			value, err := queue.Run(context.Background(), func() (int, error) {
				starts <- index
				return index, nil
			})
			results <- value
			errors <- err
		}()
		deadline := time.Now().Add(time.Second)
		for queue.Snapshot().Queued < index {
			if time.Now().After(deadline) {
				t.Fatalf("task %d did not enter the queue", index)
			}
			time.Sleep(time.Millisecond)
		}
	}
	close(releaseFirst)

	for expected := 0; expected <= 3; expected++ {
		if started := <-starts; started != expected {
			t.Fatalf("FIFO start mismatch: expected %d, got %d", expected, started)
		}
	}
	for range 4 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
		<-results
	}
}
