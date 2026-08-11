package vmd_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
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

func TestPhysicalSourceCacheIdentity(t *testing.T) {
	identity, err := vmd.CreateCacheIdentity(
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
	physicalHash := sha256.Sum256([]byte("folder/original.bin"))
	expectedPhysicalSourceID := fmt.Sprintf("%x", physicalHash)
	if identity.PhysicalSourceID != expectedPhysicalSourceID {
		t.Fatalf("physical source mismatch: %s", identity.PhysicalSourceID)
	}
	expectedObjectKey := "variants/v2/" + expectedPhysicalSourceID + "/" + expectedFingerprint + "/small.webp"
	if identity.ObjectKey != expectedObjectKey {
		t.Fatalf("object key mismatch: %s", identity.ObjectKey)
	}
}

func TestPhysicalSourceCacheIdentitySeparatesSourcesVariantsAndVersions(t *testing.T) {
	baseInfo := minio.ObjectInfo{
		ETag:         `"source-etag"`,
		VersionID:    "version-1",
		Size:         1234,
		LastModified: time.Date(2026, time.August, 8, 1, 2, 3, 0, time.UTC),
	}
	first, err := vmd.CreateCacheIdentity("blobs/source-a", "small", baseInfo)
	if err != nil {
		t.Fatal(err)
	}
	samePhysicalSource, err := vmd.CreateCacheIdentity("blobs/source-a", "small", baseInfo)
	if err != nil {
		t.Fatal(err)
	}
	if first.ObjectKey != samePhysicalSource.ObjectKey {
		t.Fatal("the same physical source did not reuse one persistent cache key")
	}

	differentSource, err := vmd.CreateCacheIdentity("blobs/source-b", "small", baseInfo)
	if err != nil {
		t.Fatal(err)
	}
	if first.ObjectKey == differentSource.ObjectKey {
		t.Fatal("different physical sources collided")
	}

	differentVariant, err := vmd.CreateCacheIdentity("blobs/source-a", "medium", baseInfo)
	if err != nil {
		t.Fatal(err)
	}
	if first.ObjectKey == differentVariant.ObjectKey {
		t.Fatal("different variants collided")
	}

	changedInfo := baseInfo
	changedInfo.ETag = `"changed-etag"`
	changedSource, err := vmd.CreateCacheIdentity("blobs/source-a", "small", changedInfo)
	if err != nil {
		t.Fatal(err)
	}
	if first.ObjectKey == changedSource.ObjectKey {
		t.Fatal("a changed source fingerprint reused a stale cache key")
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

	directPhysicalSource := httptest.NewRecorder()
	hash := strings.Repeat("a", 64)
	handler.ServeHTTP(
		directPhysicalSource,
		httptest.NewRequest(
			http.MethodGet,
			"/v1/images/"+hash+"/small?exp="+strconv.FormatInt(expiresAt, 10)+"&sig=invalid",
			nil,
		),
	)
	if directPhysicalSource.Code != http.StatusBadRequest {
		t.Fatalf("unexpected direct physical source status: %d", directPhysicalSource.Code)
	}
	if renderCalls.Load() != 0 {
		t.Fatal("a physical source identifier reached the renderer")
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

type queueTestResult struct {
	value int
	err   error
}

func runQueueAsync(
	queue *vmd.WorkQueue[int],
	ctx context.Context,
	task func() (int, error),
) <-chan queueTestResult {
	result := make(chan queueTestResult, 1)
	go func() {
		value, err := queue.Run(ctx, task)
		result <- queueTestResult{value: value, err: err}
	}()
	return result
}

func waitForQueueSnapshot(
	t *testing.T,
	queue *vmd.WorkQueue[int],
	predicate func(vmd.QueueSnapshot) bool,
) vmd.QueueSnapshot {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		snapshot := queue.Snapshot()
		if predicate(snapshot) {
			return snapshot
		}
		if time.Now().After(deadline) {
			t.Fatalf("queue state did not settle before deadline: %+v", snapshot)
		}
		time.Sleep(100 * time.Microsecond)
	}
}

func shutdownWorkQueue(t *testing.T, queue *vmd.WorkQueue[int]) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := queue.Shutdown(ctx); err != nil {
		t.Errorf("work queue shutdown failed: %v", err)
	}
}

func requireMediaErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var mediaErr *vmd.MediaError
	if !errors.As(err, &mediaErr) || mediaErr.Code != code {
		t.Fatalf("expected media error %s, got %#v", code, err)
	}
}

func TestWorkQueueBoundsConcurrencyAndReturnsAllResults(t *testing.T) {
	queue := vmd.NewWorkQueue[int](2, 8, time.Second)
	defer shutdownWorkQueue(t, queue)
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
	defer shutdownWorkQueue(t, queue)
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

func TestWorkQueuePendingCancellationImmediatelyReleasesCapacity(t *testing.T) {
	queue := vmd.NewWorkQueue[int](1, 1, time.Second)
	defer shutdownWorkQueue(t, queue)
	activeStarted := make(chan struct{})
	releaseActive := make(chan struct{})
	activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		close(activeStarted)
		<-releaseActive
		return 1, nil
	})
	<-activeStarted

	pendingContext, cancelPending := context.WithCancel(context.Background())
	var pendingRan atomic.Bool
	pendingResult := runQueueAsync(queue, pendingContext, func() (int, error) {
		pendingRan.Store(true)
		return 2, nil
	})
	waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
		return snapshot.Active == 1 && snapshot.Queued == 1
	})
	cancelPending()
	if result := <-pendingResult; !errors.Is(result.err, context.Canceled) {
		t.Fatalf("unexpected pending cancellation result: %+v", result)
	}
	waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
		return snapshot.Active == 1 && snapshot.Queued == 0
	})
	if pendingRan.Load() {
		t.Fatal("canceled pending task executed")
	}

	replacementResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		return 3, nil
	})
	waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
		return snapshot.Active == 1 && snapshot.Queued == 1
	})
	close(releaseActive)
	if result := <-activeResult; result.err != nil || result.value != 1 {
		t.Fatalf("unexpected active result: %+v", result)
	}
	if result := <-replacementResult; result.err != nil || result.value != 3 {
		t.Fatalf("unexpected replacement result: %+v", result)
	}
}

func TestWorkQueueCancellationRacingWithStartHasOneOwner(t *testing.T) {
	for iteration := range 20 {
		queue := vmd.NewWorkQueue[int](1, 1, time.Second)
		activeStarted := make(chan struct{})
		releaseActive := make(chan struct{})
		activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
			close(activeStarted)
			<-releaseActive
			return 1, nil
		})
		<-activeStarted

		pendingContext, cancelPending := context.WithCancel(context.Background())
		var pendingRuns atomic.Int32
		pendingResult := runQueueAsync(queue, pendingContext, func() (int, error) {
			pendingRuns.Add(1)
			<-pendingContext.Done()
			return 0, pendingContext.Err()
		})
		waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
			return snapshot.Active == 1 && snapshot.Queued == 1
		})

		raceStart := make(chan struct{})
		var race sync.WaitGroup
		race.Add(2)
		go func() {
			defer race.Done()
			<-raceStart
			cancelPending()
		}()
		go func() {
			defer race.Done()
			<-raceStart
			close(releaseActive)
		}()
		close(raceStart)
		race.Wait()

		if result := <-pendingResult; !errors.Is(result.err, context.Canceled) {
			t.Fatalf("iteration %d returned unexpected cancellation result: %+v", iteration, result)
		}
		if result := <-activeResult; result.err != nil || result.value != 1 {
			t.Fatalf("iteration %d returned unexpected active result: %+v", iteration, result)
		}
		waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
			return snapshot.Active == 0 && snapshot.Queued == 0
		})
		if pendingRuns.Load() > 1 {
			t.Fatalf("iteration %d ran pending work more than once: %d", iteration, pendingRuns.Load())
		}
		shutdownWorkQueue(t, queue)
	}
}

func TestWorkQueueWaitTimeoutRemovesPendingJob(t *testing.T) {
	queue := vmd.NewWorkQueue[int](1, 1, 10*time.Millisecond)
	defer shutdownWorkQueue(t, queue)
	activeStarted := make(chan struct{})
	releaseActive := make(chan struct{})
	activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		close(activeStarted)
		<-releaseActive
		return 1, nil
	})
	<-activeStarted

	var timedOutTaskRan atomic.Bool
	_, err := queue.Run(context.Background(), func() (int, error) {
		timedOutTaskRan.Store(true)
		return 2, nil
	})
	requireMediaErrorCode(t, err, "VMD_QUEUE_TIMEOUT")
	waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
		return snapshot.Active == 1 && snapshot.Queued == 0
	})
	if timedOutTaskRan.Load() {
		t.Fatal("timed-out pending task executed")
	}
	close(releaseActive)
	if result := <-activeResult; result.err != nil {
		t.Fatal(result.err)
	}
}

func TestWorkQueueRejectsWhenPendingCapacityIsFull(t *testing.T) {
	queue := vmd.NewWorkQueue[int](1, 1, time.Second)
	defer shutdownWorkQueue(t, queue)
	activeStarted := make(chan struct{})
	releaseActive := make(chan struct{})
	activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		close(activeStarted)
		<-releaseActive
		return 1, nil
	})
	<-activeStarted
	pendingResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		return 2, nil
	})
	waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
		return snapshot.Active == 1 && snapshot.Queued == 1
	})

	_, err := queue.Run(context.Background(), func() (int, error) {
		return 3, nil
	})
	requireMediaErrorCode(t, err, "VMD_AT_CAPACITY")
	close(releaseActive)
	if result := <-activeResult; result.err != nil {
		t.Fatal(result.err)
	}
	if result := <-pendingResult; result.err != nil || result.value != 2 {
		t.Fatalf("unexpected pending result: %+v", result)
	}
}

func TestWorkQueueTaskPanicReturnsSafeErrorAndRestoresCapacity(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	queue := vmd.NewWorkQueue[int](1, 1, time.Second, logger)
	defer shutdownWorkQueue(t, queue)

	_, err := queue.Run(context.Background(), func() (int, error) {
		panic("expected queue panic")
	})
	requireMediaErrorCode(t, err, "VMD_DELIVERY_FAILED")
	snapshot := queue.Snapshot()
	if snapshot.Active != 0 || snapshot.Queued != 0 {
		t.Fatalf("panic left queue capacity occupied: %+v", snapshot)
	}
	if !strings.Contains(logs.String(), "VMD work queue task panicked") ||
		!strings.Contains(logs.String(), "expected queue panic") ||
		!strings.Contains(logs.String(), "goroutine") {
		t.Fatalf("panic log is missing message or stack: %s", logs.String())
	}

	value, err := queue.Run(context.Background(), func() (int, error) {
		return 9, nil
	})
	if err != nil || value != 9 {
		t.Fatalf("queue was unusable after panic: value=%d err=%v", value, err)
	}
}

func TestWorkQueueShutdownRejectsPendingAndWaitsForActiveWork(t *testing.T) {
	queue := vmd.NewWorkQueue[int](1, 1, time.Second)
	activeStarted := make(chan struct{})
	releaseActive := make(chan struct{})
	activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		close(activeStarted)
		<-releaseActive
		return 1, nil
	})
	<-activeStarted
	var pendingRan atomic.Bool
	pendingResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		pendingRan.Store(true)
		return 2, nil
	})
	waitForQueueSnapshot(t, queue, func(snapshot vmd.QueueSnapshot) bool {
		return snapshot.Active == 1 && snapshot.Queued == 1
	})

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), time.Second)
	defer cancelShutdown()
	shutdownResult := make(chan error, 1)
	go func() {
		shutdownResult <- queue.Shutdown(shutdownContext)
	}()
	if result := <-pendingResult; result.err == nil {
		t.Fatal("pending work was accepted during shutdown")
	} else {
		requireMediaErrorCode(t, result.err, "VMD_AT_CAPACITY")
	}
	if pendingRan.Load() {
		t.Fatal("shutdown executed pending work")
	}
	select {
	case err := <-shutdownResult:
		t.Fatalf("shutdown returned before active work completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	if _, err := queue.Run(context.Background(), func() (int, error) { return 3, nil }); err == nil {
		t.Fatal("shutdown queue accepted new work")
	} else {
		requireMediaErrorCode(t, err, "VMD_AT_CAPACITY")
	}

	close(releaseActive)
	if result := <-activeResult; result.err != nil || result.value != 1 {
		t.Fatalf("unexpected active result during shutdown: %+v", result)
	}
	if err := <-shutdownResult; err != nil {
		t.Fatalf("shutdown failed after active work completed: %v", err)
	}
}

func TestWorkQueueShutdownReturnsAtDeadlineAndCanFinishLater(t *testing.T) {
	queue := vmd.NewWorkQueue[int](1, 1, time.Second)
	activeStarted := make(chan struct{})
	releaseActive := make(chan struct{})
	activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
		close(activeStarted)
		<-releaseActive
		return 1, nil
	})
	<-activeStarted

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := queue.Shutdown(shutdownContext)
	cancelShutdown()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown did not honor its deadline: %v", err)
	}
	snapshot := queue.Snapshot()
	if snapshot.Active != 1 || snapshot.Queued != 0 {
		t.Fatalf("shutdown deadline corrupted queue state: %+v", snapshot)
	}
	if _, err := queue.Run(context.Background(), func() (int, error) { return 2, nil }); err == nil {
		t.Fatal("timed-out shutdown reopened the queue")
	}

	close(releaseActive)
	if result := <-activeResult; result.err != nil {
		t.Fatal(result.err)
	}
	finalContext, cancelFinal := context.WithTimeout(context.Background(), time.Second)
	defer cancelFinal()
	if err := queue.Shutdown(finalContext); err != nil {
		t.Fatalf("queue did not finish draining after initial timeout: %v", err)
	}
}

func TestWorkQueueTimeoutCancelCloseAndStartRacesCompleteOnce(t *testing.T) {
	for iteration := range 20 {
		queue := vmd.NewWorkQueue[int](1, 1, 2*time.Millisecond)
		activeStarted := make(chan struct{})
		releaseActive := make(chan struct{})
		activeResult := runQueueAsync(queue, context.Background(), func() (int, error) {
			close(activeStarted)
			<-releaseActive
			return 1, nil
		})
		<-activeStarted

		pendingContext, cancelPending := context.WithCancel(context.Background())
		var pendingRuns atomic.Int32
		pendingResult := runQueueAsync(queue, pendingContext, func() (int, error) {
			pendingRuns.Add(1)
			return 2, nil
		})
		var pending queueTestResult
		pendingCompleted := false
		observationDeadline := time.Now().Add(2 * time.Second)
	observationLoop:
		for {
			snapshot := queue.Snapshot()
			if snapshot.Active == 1 && snapshot.Queued == 1 {
				break
			}
			select {
			case pending = <-pendingResult:
				pendingCompleted = true
				break observationLoop
			default:
			}
			if time.Now().After(observationDeadline) {
				t.Fatalf("iteration %d did not enqueue or time out pending work: %+v", iteration, snapshot)
			}
			time.Sleep(100 * time.Microsecond)
		}

		raceStart := make(chan struct{})
		shutdownResult := make(chan error, 1)
		var race sync.WaitGroup
		race.Add(3)
		go func() {
			defer race.Done()
			<-raceStart
			cancelPending()
		}()
		go func() {
			defer race.Done()
			<-raceStart
			close(releaseActive)
		}()
		go func() {
			defer race.Done()
			<-raceStart
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			shutdownResult <- queue.Shutdown(ctx)
		}()
		close(raceStart)
		race.Wait()

		if !pendingCompleted {
			pending = <-pendingResult
		}
		if pending.err != nil &&
			!errors.Is(pending.err, context.Canceled) {
			var mediaErr *vmd.MediaError
			if !errors.As(pending.err, &mediaErr) ||
				(mediaErr.Code != "VMD_QUEUE_TIMEOUT" && mediaErr.Code != "VMD_AT_CAPACITY") {
				t.Fatalf("iteration %d returned unexpected pending result: %+v", iteration, pending)
			}
		}
		if result := <-activeResult; result.err != nil || result.value != 1 {
			t.Fatalf("iteration %d returned unexpected active result: %+v", iteration, result)
		}
		if err := <-shutdownResult; err != nil {
			t.Fatalf("iteration %d shutdown failed: %v", iteration, err)
		}
		if pendingRuns.Load() > 1 {
			t.Fatalf("iteration %d ran pending task more than once: %d", iteration, pendingRuns.Load())
		}
		snapshot := queue.Snapshot()
		if snapshot.Active != 0 || snapshot.Queued != 0 {
			t.Fatalf("iteration %d left queue work behind: %+v", iteration, snapshot)
		}
	}
}
