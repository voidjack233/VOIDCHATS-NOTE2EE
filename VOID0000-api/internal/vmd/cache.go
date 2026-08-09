package vmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
)

const cacheVersion = "v1"

type CacheIdentity struct {
	AttachmentID      string
	SourceFingerprint string
	Variant           string
	ObjectKey         string
}

type sourceDescriptor struct {
	ObjectKey    string `json:"object_key"`
	ETag         string `json:"etag"`
	VersionID    string `json:"version_id"`
	Size         int64  `json:"size"`
	LastModified string `json:"last_modified"`
}

type cacheReadResult struct {
	status string
	image  Image
	err    error
}

func normalizeETag(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), `"`))
}

func javascriptISOString(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func CreateCacheIdentity(attachmentID, objectKey, variant string, objectInfo minio.ObjectInfo) (CacheIdentity, error) {
	descriptor := sourceDescriptor{
		ObjectKey:    objectKey,
		ETag:         normalizeETag(objectInfo.ETag),
		VersionID:    objectInfo.VersionID,
		Size:         objectInfo.Size,
		LastModified: javascriptISOString(objectInfo.LastModified),
	}
	serialized, err := json.Marshal(descriptor)
	if err != nil {
		return CacheIdentity{}, err
	}
	hash := sha256.Sum256(serialized)
	fingerprint := hex.EncodeToString(hash[:])
	normalizedAttachmentID := strings.ToLower(attachmentID)
	return CacheIdentity{
		AttachmentID:      normalizedAttachmentID,
		SourceFingerprint: fingerprint,
		Variant:           variant,
		ObjectKey: fmt.Sprintf(
			"variants/%s/%s/%s/%s.webp",
			cacheVersion,
			normalizedAttachmentID,
			fingerprint,
			variant,
		),
	}, nil
}

func checksumBase64URL(value []byte) string {
	checksum := sha256.Sum256(value)
	return base64.RawURLEncoding.EncodeToString(checksum[:])
}

func metadataValue(info minio.ObjectInfo, names ...string) string {
	for _, name := range names {
		if value := info.Metadata.Get(name); value != "" {
			return value
		}
	}
	for key, value := range info.UserMetadata {
		for _, name := range names {
			trimmedName := strings.TrimPrefix(strings.ToLower(name), "x-amz-meta-")
			trimmedKey := strings.TrimPrefix(strings.ToLower(key), "x-amz-meta-")
			if trimmedKey == trimmedName {
				return value
			}
		}
	}
	return ""
}

func objectContentType(info minio.ObjectInfo) string {
	if info.ContentType != "" {
		return strings.ToLower(strings.TrimSpace(strings.SplitN(info.ContentType, ";", 2)[0]))
	}
	return strings.ToLower(strings.TrimSpace(strings.SplitN(
		metadataValue(info, "Content-Type"),
		";",
		2,
	)[0]))
}

func parsePositiveMetadata(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}

func isMissingObjectError(err error) bool {
	if err == nil {
		return false
	}
	response := minio.ToErrorResponse(err)
	code := response.Code
	if code == "" {
		code = err.Error()
	}
	switch code {
	case "NoSuchKey", "NoSuchObject", "NotFound", "NoSuchBucket":
		return true
	default:
		return strings.Contains(code, "The specified key does not exist")
	}
}

func readBoundedObject(ctx context.Context, client *minio.Client, bucket, objectKey string, expectedSize, maximum int64) ([]byte, error) {
	if expectedSize <= 0 || expectedSize > maximum {
		return nil, fmt.Errorf("object has an invalid size")
	}
	object, err := client.GetObject(ctx, bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer object.Close()
	body, err := io.ReadAll(io.LimitReader(object, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maximum {
		return nil, fmt.Errorf("object exceeds its configured size limit")
	}
	if int64(len(body)) != expectedSize {
		return nil, fmt.Errorf("object size does not match metadata")
	}
	return body, nil
}

func readCachedImage(ctx context.Context, client *minio.Client, bucket string, identity CacheIdentity, maxVariantBytes int64) cacheReadResult {
	objectInfo, err := client.StatObject(ctx, bucket, identity.ObjectKey, minio.StatObjectOptions{})
	if err != nil {
		if isMissingObjectError(err) {
			return cacheReadResult{status: "miss"}
		}
		return cacheReadResult{status: "unavailable", err: err}
	}
	body, err := readBoundedObject(
		ctx,
		client,
		bucket,
		identity.ObjectKey,
		objectInfo.Size,
		maxVariantBytes,
	)
	if err != nil {
		if isMissingObjectError(err) {
			return cacheReadResult{status: "miss"}
		}
		return cacheReadResult{status: "corrupt", err: err}
	}

	checksum := checksumBase64URL(body)
	width := parsePositiveMetadata(metadataValue(objectInfo, "vmd-width"))
	height := parsePositiveMetadata(metadataValue(objectInfo, "vmd-height"))
	pages := parsePositiveMetadata(metadataValue(objectInfo, "vmd-pages"))
	if pages == 0 {
		pages = 1
	}
	valid := objectContentType(objectInfo) == "image/webp" &&
		metadataValue(objectInfo, "vmd-cache-version") == cacheVersion &&
		metadataValue(objectInfo, "vmd-source-fingerprint") == identity.SourceFingerprint &&
		metadataValue(objectInfo, "vmd-variant") == identity.Variant &&
		metadataValue(objectInfo, "vmd-checksum-sha256") == checksum &&
		width > 0 && height > 0
	if !valid {
		return cacheReadResult{status: "corrupt"}
	}
	return cacheReadResult{
		status: "hit",
		image: Image{
			Body:        body,
			ContentType: "image/webp",
			Width:       width,
			Height:      height,
			Pages:       pages,
			ETag:        `"` + checksum + `"`,
		},
	}
}

func writeCachedImage(ctx context.Context, client *minio.Client, bucket string, identity CacheIdentity, image Image, maxVariantBytes int64) (string, error) {
	if len(image.Body) == 0 || int64(len(image.Body)) > maxVariantBytes {
		return "", fmt.Errorf("generated VMD variant has an invalid size")
	}
	checksum := checksumBase64URL(image.Body)
	_, err := client.PutObject(
		ctx,
		bucket,
		identity.ObjectKey,
		bytes.NewReader(image.Body),
		int64(len(image.Body)),
		minio.PutObjectOptions{
			ContentType:  "image/webp",
			CacheControl: "private, no-store",
			UserMetadata: map[string]string{
				"vmd-cache-version":      cacheVersion,
				"vmd-source-fingerprint": identity.SourceFingerprint,
				"vmd-variant":            identity.Variant,
				"vmd-checksum-sha256":    checksum,
				"vmd-width":              strconv.Itoa(image.Width),
				"vmd-height":             strconv.Itoa(image.Height),
				"vmd-pages":              strconv.Itoa(image.Pages),
			},
		},
	)
	if err != nil {
		return "", err
	}
	return `"` + checksum + `"`, nil
}

func trustedInlineImage(info minio.ObjectInfo) bool {
	if metadataValue(info, "void-sanitized-image", "x-amz-meta-void-sanitized-image") != "1" {
		return false
	}
	switch objectContentType(info) {
	case "image/avif", "image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp":
		return true
	default:
		return false
	}
}

func setNoStoreHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-store")
	headers.Set("CDN-Cache-Control", "no-store")
	headers.Set("Cloudflare-CDN-Cache-Control", "no-store")
}
