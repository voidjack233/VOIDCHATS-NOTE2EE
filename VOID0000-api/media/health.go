package media

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type HealthChecks struct {
	Postgres  func(context.Context) error
	Valkey    func(context.Context) error
	Storage   func(context.Context) error
	Processor func(context.Context) error
}

func HealthHandler(checks HealthChecks) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"service": "voidapp-media-worker", "success": true})
	})
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		failed := []string{}
		for _, check := range []struct {
			name string
			fn   func(context.Context) error
		}{
			{"postgres", checks.Postgres}, {"valkey", checks.Valkey}, {"storage", checks.Storage}, {"processor", checks.Processor},
		} {
			if check.fn == nil || check.fn(ctx) != nil {
				failed = append(failed, check.name)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if len(failed) > 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"service": "voidapp-media-worker", "success": len(failed) == 0, "unavailable": failed, "processing_concurrency": 1})
	})
	return mux
}
