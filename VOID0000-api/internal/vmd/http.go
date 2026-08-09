package vmd

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const serviceName = "voidapp-vmd-service"

type HTTPDependencies struct {
	Render         func(context.Context, string, string) (Image, error)
	Metrics        func() map[string]any
	CheckPostgres  func(context.Context) error
	CheckMinio     func(context.Context) error
	CheckTransform func(context.Context) error
}

type Handler struct {
	signingKey       []byte
	readinessTimeout time.Duration
	dependencies     HTTPDependencies
	logger           *slog.Logger
	startedAt        time.Time
	now              func() time.Time
}

type readinessResult struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latency_ms"`
	Error     string `json:"error,omitempty"`
}

func NewHandler(config Config, dependencies HTTPDependencies, logger *slog.Logger) (*Handler, error) {
	if len(config.SigningKey) != sha256.Size {
		return nil, fmt.Errorf("VMD signing key must be 32 bytes")
	}
	if dependencies.Render == nil || dependencies.Metrics == nil {
		return nil, fmt.Errorf("VMD HTTP dependencies are incomplete")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{
		signingKey:       append([]byte(nil), config.SigningKey...),
		readinessTimeout: config.ReadinessTimeout,
		dependencies:     dependencies,
		logger:           logger,
		startedAt:        time.Now(),
		now:              time.Now,
	}, nil
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func sendHTTPError(response http.ResponseWriter, status int, code string) {
	setNoStoreHeaders(response.Header())
	writeJSON(response, status, map[string]any{
		"success": false,
		"code":    code,
	})
}

func parseImagePath(path string) (string, string, bool) {
	parts := strings.Split(path, "/")
	if len(parts) != 5 || parts[0] != "" || parts[1] != "v1" || parts[2] != "images" {
		return "", "", false
	}
	attachmentID, err := url.PathUnescape(parts[3])
	if err != nil || attachmentID == "" || strings.Contains(attachmentID, "/") {
		return "", "", false
	}
	variant, err := url.PathUnescape(parts[4])
	if err != nil || variant == "" || strings.Contains(variant, "/") {
		return "", "", false
	}
	return attachmentID, variant, true
}

func singleQueryValue(values url.Values, key string) (string, bool) {
	items, exists := values[key]
	returnValue := ""
	if exists && len(items) == 1 {
		returnValue = items[0]
	}
	return returnValue, exists && len(items) == 1
}

func mediaETag(image Image) string {
	if image.ETag != "" {
		return image.ETag
	}
	hash := sha256.Sum256(image.Body)
	return `"` + base64.RawURLEncoding.EncodeToString(hash[:]) + `"`
}

func setMediaCacheHeaders(headers http.Header, expiresAt int64, now time.Time, image Image) string {
	remainingSeconds := expiresAt - now.Unix()
	if remainingSeconds < 0 {
		remainingSeconds = 0
	}
	etag := mediaETag(image)
	shared := []string{
		"public",
		"max-age=" + strconv.FormatInt(remainingSeconds, 10),
		"must-revalidate",
		"no-transform",
	}
	browser := append([]string{}, shared...)
	browser = append(
		browser,
		"s-maxage="+strconv.FormatInt(remainingSeconds, 10),
		"proxy-revalidate",
	)
	if remainingSeconds > 0 {
		browser = append(browser, "immutable")
		shared = append(shared, "immutable")
	}

	headers.Set("Cache-Control", strings.Join(browser, ", "))
	headers.Set("CDN-Cache-Control", strings.Join(shared, ", "))
	headers.Set("Cloudflare-CDN-Cache-Control", strings.Join(shared, ", "))
	headers.Set("ETag", etag)
	headers.Set("Cross-Origin-Resource-Policy", "cross-origin")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("Referrer-Policy", "no-referrer")
	return etag
}

func (h *Handler) serveImage(response http.ResponseWriter, request *http.Request) {
	attachmentID, variant, ok := parseImagePath(request.URL.Path)
	if !ok {
		sendHTTPError(response, 404, "VMD_ROUTE_NOT_FOUND")
		return
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		sendHTTPError(response, 400, "VMD_QUERY_INVALID")
		return
	}
	for key := range query {
		if key != "exp" && key != "sig" {
			sendHTTPError(response, 400, "VMD_QUERY_INVALID")
			return
		}
	}
	expiresAt, hasExpiration := singleQueryValue(query, "exp")
	signature, hasSignature := singleQueryValue(query, "sig")
	if !hasExpiration || !hasSignature {
		if !hasExpiration {
			expiresAt = ""
		}
		if !hasSignature {
			signature = ""
		}
	}

	requestNow := h.now()
	verification, capabilityError := VerifyCapability(
		attachmentID,
		variant,
		expiresAt,
		signature,
		requestNow,
		h.signingKey,
	)
	if capabilityError != nil {
		sendHTTPError(response, capabilityError.Status, capabilityError.Code)
		return
	}

	image, err := h.dependencies.Render(request.Context(), attachmentID, variant)
	if err != nil {
		var media *MediaError
		if errors.As(err, &media) {
			if media.Status == http.StatusServiceUnavailable {
				response.Header().Set("Retry-After", "1")
			}
			sendHTTPError(response, media.Status, media.Code)
			return
		}
		h.logger.Error(
			"VMD image delivery failed",
			"attachment_id", attachmentID,
			"variant", variant,
			"error", err,
		)
		sendHTTPError(response, 500, "VMD_DELIVERY_FAILED")
		return
	}

	etag := setMediaCacheHeaders(
		response.Header(),
		verification.ExpiresAt,
		h.now(),
		image,
	)
	if request.Header.Get("If-None-Match") == etag {
		response.WriteHeader(http.StatusNotModified)
		return
	}
	response.Header().Set("Content-Type", image.ContentType)
	response.Header().Set("Content-Length", strconv.Itoa(len(image.Body)))
	response.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = response.Write(image.Body)
	}
}

func (h *Handler) health(response http.ResponseWriter) {
	writeJSON(response, http.StatusOK, map[string]any{
		"success": true,
		"service": serviceName,
		"pid":     os.Getpid(),
		"metrics": h.dependencies.Metrics(),
	})
}

func (h *Handler) runReadinessCheck(parent context.Context, check func(context.Context) error) readinessResult {
	startedAt := h.now()
	if check == nil {
		return readinessResult{
			OK:        false,
			LatencyMS: 0,
			Error:     "Readiness check is unavailable",
		}
	}
	ctx, cancel := context.WithTimeout(parent, h.readinessTimeout)
	defer cancel()
	err := check(ctx)
	result := readinessResult{
		OK:        err == nil,
		LatencyMS: h.now().Sub(startedAt).Milliseconds(),
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			result.Error = fmt.Sprintf("Timed out after %dms", h.readinessTimeout.Milliseconds())
		} else {
			result.Error = err.Error()
		}
	}
	return result
}

func (h *Handler) ready(response http.ResponseWriter, request *http.Request) {
	startedAt := h.now()
	type namedResult struct {
		name   string
		result readinessResult
	}
	resultChannel := make(chan namedResult, 3)
	checks := map[string]func(context.Context) error{
		"postgres":         h.dependencies.CheckPostgres,
		"minio":            h.dependencies.CheckMinio,
		"transform_worker": h.dependencies.CheckTransform,
	}
	for name, check := range checks {
		go func() {
			resultChannel <- namedResult{
				name:   name,
				result: h.runReadinessCheck(request.Context(), check),
			}
		}()
	}
	dependencies := make(map[string]readinessResult, len(checks))
	ready := true
	for range checks {
		result := <-resultChannel
		dependencies[result.name] = result.result
		ready = ready && result.result.OK
	}
	status := "ready"
	httpStatus := http.StatusOK
	if !ready {
		status = "degraded"
		httpStatus = http.StatusServiceUnavailable
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, httpStatus, map[string]any{
		"success":        ready,
		"status":         status,
		"service":        serviceName,
		"pid":            os.Getpid(),
		"uptime_seconds": int64(h.now().Sub(h.startedAt).Seconds() + 0.5),
		"duration_ms":    h.now().Sub(startedAt).Milliseconds(),
		"dependencies":   dependencies,
	})
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		sendHTTPError(response, 404, "VMD_ROUTE_NOT_FOUND")
		return
	}
	switch request.URL.Path {
	case "/health":
		h.health(response)
	case "/ready":
		h.ready(response, request)
	default:
		h.serveImage(response, request)
	}
}
