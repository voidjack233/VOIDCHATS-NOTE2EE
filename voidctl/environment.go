package voidctl

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func randomBytes(reader io.Reader, size int) ([]byte, error) {
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func randomURLToken(reader io.Reader, size int) (string, error) {
	payload, err := randomBytes(reader, size)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func generateEnvironmentValues(
	runtime Runtime,
	fullSHA string,
	random io.Reader,
) (map[string]string, error) {
	if len(fullSHA) < 12 {
		return nil, fmt.Errorf("Git SHA is invalid")
	}
	values := map[string]string{
		"VOID_IMAGE_TAG":    fullSHA[:12],
		"VOID_GIT_SHA":      fullSHA,
		"VOID_DNS_RESOLVER": runtime.DNSResolver,
	}

	urlKeys := []string{
		"PGPASSWORD", "MINIO_SECRET_KEY", "ACCESS_SECRET", "REFRESH_SECRET",
		"TWO_FACTOR_CODE_SECRET", "VMD_SIGNING_SECRET", "PHX_SECRET_KEY_BASE",
	}
	for _, key := range urlKeys {
		value, err := randomURLToken(random, 48)
		if err != nil {
			return nil, err
		}
		values[key] = value
	}
	accessKeyBytes, err := randomBytes(random, 8)
	if err != nil {
		return nil, err
	}
	values["MINIO_ACCESS_KEY"] = "void" + hex.EncodeToString(accessKeyBytes)
	csrfBytes, err := randomBytes(random, 32)
	if err != nil {
		return nil, err
	}
	values["CSRF_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(csrfBytes)
	totpBytes, err := randomBytes(random, 32)
	if err != nil {
		return nil, err
	}
	values["TOTP_ENCRYPTION_KEY"] = hex.EncodeToString(totpBytes)
	return values, nil
}

func ReplaceEnvironmentValues(template string, replacements map[string]string) (string, error) {
	var output strings.Builder
	scanner := bufio.NewScanner(strings.NewReader(template))
	seen := make(map[string]bool, len(replacements))
	for scanner.Scan() {
		line := scanner.Text()
		if index := strings.IndexByte(line, '='); index > 0 && !strings.HasPrefix(line, "#") {
			key := line[:index]
			if replacement, exists := replacements[key]; exists {
				line = key + "=" + replacement
				seen[key] = true
			}
		}
		output.WriteString(line)
		output.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	for key := range replacements {
		if !seen[key] {
			return "", fmt.Errorf("deployment environment template is missing %s", key)
		}
	}
	return output.String(), nil
}

func writePrivateFile(path string, payload []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".voidctl-env-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func EnsureDeploymentEnvironment(root string, runtime Runtime, fullSHA string) (bool, error) {
	path := filepath.Join(root, "deploy", ".env")
	if _, err := os.Stat(path); err == nil {
		if err := os.Chmod(path, 0o600); err != nil {
			return false, err
		}
		return false, UpdateDeploymentEnvironment(root, map[string]string{
			"VOID_DNS_RESOLVER": runtime.DNSResolver,
		})
	} else if !os.IsNotExist(err) {
		return false, err
	}

	template, err := os.ReadFile(filepath.Join(root, "deploy", ".env.example"))
	if err != nil {
		return false, err
	}
	values, err := generateEnvironmentValues(runtime, fullSHA, rand.Reader)
	if err != nil {
		return false, err
	}
	payload, err := ReplaceEnvironmentValues(string(template), values)
	if err != nil {
		return false, err
	}
	if strings.Contains(payload, "replace-with-") {
		return false, fmt.Errorf("deployment environment still contains placeholders")
	}
	return true, writePrivateFile(path, []byte(payload))
}

func ReadEnvironment(path string) (map[string]string, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := make(map[string]string)
	scanner := bufio.NewScanner(bytesReader(payload))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		index := strings.IndexByte(line, '=')
		if index <= 0 {
			return nil, fmt.Errorf("invalid environment line for %q", line)
		}
		values[line[:index]] = line[index+1:]
	}
	return values, scanner.Err()
}

func bytesReader(payload []byte) io.Reader {
	return strings.NewReader(string(payload))
}

func UpdateDeploymentEnvironment(root string, replacements map[string]string) error {
	path := filepath.Join(root, "deploy", ".env")
	payload, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	updated, err := ReplaceEnvironmentValues(string(payload), replacements)
	if err != nil {
		return err
	}
	return writePrivateFile(path, []byte(updated))
}
