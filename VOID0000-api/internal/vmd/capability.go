package vmd

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Variant struct {
	Bound   int
	Quality int
}

var Variants = map[string]Variant{
	"thumb":  {Bound: 160, Quality: 72},
	"small":  {Bound: 480, Quality: 78},
	"medium": {Bound: 960, Quality: 82},
	"large":  {Bound: 1600, Quality: 84},
}

var (
	uuidPattern      = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	signaturePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	digitsPattern    = regexp.MustCompile(`^[0-9]+$`)
)

type CapabilityVerification struct {
	ExpiresAt int64
}

func capabilityPayload(attachmentID, variant string, expiresAt int64) string {
	return "void-vmd-v1\n" + strings.ToLower(attachmentID) + "\n" + variant + "\n" + strconv.FormatInt(expiresAt, 10)
}

func signCapability(attachmentID, variant string, expiresAt int64, signingKey []byte) []byte {
	mac := hmac.New(sha256.New, signingKey)
	_, _ = mac.Write([]byte(capabilityPayload(attachmentID, variant, expiresAt)))
	return mac.Sum(nil)
}

func VerifyCapability(attachmentID, variant, expiresAt, signature string, now time.Time, signingKey []byte) (CapabilityVerification, *MediaError) {
	if !uuidPattern.MatchString(attachmentID) {
		return CapabilityVerification{}, mediaError(400, "VMD_ATTACHMENT_ID_INVALID", "VMD attachment ID is invalid", nil)
	}
	if _, ok := Variants[variant]; !ok {
		return CapabilityVerification{}, mediaError(400, "VMD_VARIANT_UNSUPPORTED", "VMD image variant is unsupported", nil)
	}
	if !digitsPattern.MatchString(expiresAt) {
		return CapabilityVerification{}, mediaError(400, "VMD_EXPIRATION_INVALID", "VMD expiration is invalid", nil)
	}
	parsedExpiresAt, err := strconv.ParseInt(expiresAt, 10, 64)
	if err != nil {
		return CapabilityVerification{}, mediaError(400, "VMD_EXPIRATION_INVALID", "VMD expiration is invalid", nil)
	}
	if parsedExpiresAt <= now.Unix() {
		return CapabilityVerification{}, mediaError(410, "VMD_CAPABILITY_EXPIRED", "VMD capability has expired", nil)
	}
	if !signaturePattern.MatchString(signature) {
		return CapabilityVerification{}, mediaError(403, "VMD_SIGNATURE_INVALID", "VMD signature is invalid", nil)
	}

	supplied, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(supplied) != sha256.Size {
		return CapabilityVerification{}, mediaError(403, "VMD_SIGNATURE_INVALID", "VMD signature is invalid", nil)
	}
	expected := signCapability(attachmentID, variant, parsedExpiresAt, signingKey)
	if subtle.ConstantTimeCompare(expected, supplied) != 1 {
		return CapabilityVerification{}, mediaError(403, "VMD_SIGNATURE_INVALID", "VMD signature is invalid", nil)
	}

	return CapabilityVerification{ExpiresAt: parsedExpiresAt}, nil
}
