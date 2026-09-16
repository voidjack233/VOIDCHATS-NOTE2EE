package media_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/media"
)

func settings() map[string]string {
	return map[string]string{"PGHOST": "127.0.0.1", "PGDATABASE": "test", "PGUSER": "tester", "PGPASSWORD": "test-only",
		"MINIO_ACCESS_KEY": "test-only", "MINIO_SECRET_KEY": "test-only"}
}

func TestConfigDefaults(t *testing.T) {
	values := settings()
	c, err := media.ParseConfig(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 3007 || c.ProbeTimeout != 15*time.Second || c.TranscodeTimeout != 180*time.Second {
		t.Fatalf("wrong defaults: %+v", c)
	}
	if c.LeaseDuration <= c.JobTimeout {
		t.Fatal("lease must outlive bounded processing")
	}
	if media.MaxSourceBytes != 10485760 || media.MaxOutputBytes != 10485760 {
		t.Fatal("10 MiB source/final limits changed")
	}
	if c.AttachmentBucket == c.QuarantineBucket {
		t.Fatal("quarantine is not isolated")
	}
}

func TestConfigRejectsUnsafeOverrides(t *testing.T) {
	for _, pair := range [][2]string{
		{"MEDIA_WORKER_PORT", "0"}, {"MEDIA_WORKER_PORT", "65536"}, {"MEDIA_FFMPEG_TIMEOUT_SECONDS", "-1"},
		{"MEDIA_FFMPEG_TIMEOUT_SECONDS", "1.5"}, {"MEDIA_FFMPEG_TIMEOUT_SECONDS", "601"}, {"MEDIA_FFPROBE_TIMEOUT_SECONDS", "NaN"},
		{"VALKEY_DB", "-1"}, {"PGPORT", "999999999999999999999999"}, {"PGHOST", ""}, {"MINIO_ACCESS_KEY", ""},
		{"MEDIA_TEMP_ROOT", "relative"}, {"MEDIA_FFMPEG_PATH", "ffmpeg"}, {"MEDIA_WORKER_HOST", "example.org"},
		{"MINIO_MEDIA_QUARANTINE_BUCKET", "chat-attachments"}, {"MINIO_MEDIA_QUARANTINE_BUCKET", "avatars"},
	} {
		t.Run(pair[0]+"="+pair[1], func(t *testing.T) {
			values := settings()
			values[pair[0]] = pair[1]
			if _, err := media.ParseConfig(func(k string) string { return values[k] }); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
	values := settings()
	values["NODE_ENV"] = "production"
	values["MINIO_SECRET_KEY"] = "minioadmin"
	if _, err := media.ParseConfig(func(k string) string { return values[k] }); err == nil {
		t.Fatal("default production credentials accepted")
	}
}

func TestTinyQueueContract(t *testing.T) {
	id, conversation := uuid.NewString(), uuid.NewString()
	job, err := media.ParseJob(map[string]interface{}{"ingest_id": id, "conversation_id": conversation})
	if err != nil || job.IngestID != id || job.ConversationID != conversation {
		t.Fatal("valid job rejected", err)
	}
	for _, values := range []map[string]interface{}{
		{"ingest_id": id}, {"ingest_id": id, "conversation_id": conversation, "bytes": "forbidden"},
		{"ingest_id": "not-a-uuid", "conversation_id": conversation}, {"ingest_id": uuid.Nil.String(), "conversation_id": conversation},
		{"ingest_id": 12, "conversation_id": conversation},
	} {
		if _, err := media.ParseJob(values); err == nil {
			t.Fatal("invalid job accepted")
		}
	}
}

func TestReadinessFailsClosedWithoutProcessor(t *testing.T) {
	ok := func(context.Context) error { return nil }
	handler := media.HealthHandler(media.HealthChecks{Postgres: ok, Valkey: ok, Storage: ok})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest("GET", "/ready", nil))
	if res.Code != 503 {
		t.Fatal("unfinished processor advertised ready")
	}
	var payload struct{ Unavailable []string }
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Unavailable) != 1 || payload.Unavailable[0] != "processor" {
		t.Fatal(payload)
	}
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest("GET", "/health", nil))
	if res.Code != 200 {
		t.Fatal(res.Code)
	}
	for _, failed := range []string{"postgres", "valkey", "storage", "processor", "none"} {
		t.Run(failed, func(t *testing.T) {
			check := func(name string) func(context.Context) error {
				return func(context.Context) error {
					if name == failed {
						return errors.New("secret detail must not be exposed")
					}
					return nil
				}
			}
			handler := media.HealthHandler(media.HealthChecks{Postgres: check("postgres"), Valkey: check("valkey"), Storage: check("storage"), Processor: check("processor")})
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest("GET", "/ready", nil))
			want := 503
			if failed == "none" {
				want = 200
			}
			if res.Code != want {
				t.Fatal(res.Code)
			}
		})
	}
}
