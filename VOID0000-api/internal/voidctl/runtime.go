package voidctl

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type RuntimeName string

const (
	Docker RuntimeName = "docker"
	Podman RuntimeName = "podman"
)

type Runtime struct {
	Name          RuntimeName
	Executable    string
	ComposePrefix []string
	DNSResolver   string
	TestedOnHost  bool
}

func runtimeStatePath(root string) string {
	return filepath.Join(root, ".voidctl", "runtime")
}

func LoadSelectedRuntime(root string) (RuntimeName, error) {
	payload, err := os.ReadFile(runtimeStatePath(root))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	value := RuntimeName(strings.TrimSpace(string(payload)))
	if value != Docker && value != Podman {
		return "", fmt.Errorf("invalid persisted container runtime %q", value)
	}
	return value, nil
}

func SaveSelectedRuntime(root string, runtime RuntimeName) error {
	if runtime != Docker && runtime != Podman {
		return fmt.Errorf("unsupported container runtime %q", runtime)
	}
	directory := filepath.Dir(runtimeStatePath(root))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, "runtime-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.WriteString(string(runtime) + "\n"); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, runtimeStatePath(root))
}

func ProbeRuntime(
	ctx context.Context,
	executor Executor,
	root string,
	name RuntimeName,
) (Runtime, error) {
	probeContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	switch name {
	case Docker:
		if _, err := executor.Run(probeContext, root, nil, "docker", "info"); err != nil {
			return Runtime{}, fmt.Errorf("Docker engine is unavailable: %w", err)
		}
		if _, err := executor.Run(probeContext, root, nil, "docker", "compose", "version"); err != nil {
			return Runtime{}, fmt.Errorf("Docker Compose is unavailable: %w", err)
		}
		return Runtime{
			Name: Docker, Executable: "docker", ComposePrefix: []string{"compose"},
			DNSResolver: "127.0.0.11", TestedOnHost: true,
		}, nil
	case Podman:
		if _, err := executor.Run(probeContext, root, nil, "podman", "info"); err != nil {
			return Runtime{}, fmt.Errorf("Podman engine is unavailable: %w", err)
		}
		if _, err := executor.Run(probeContext, root, nil, "podman", "compose", "version"); err == nil {
			return Runtime{
				Name: Podman, Executable: "podman", ComposePrefix: []string{"compose"},
				DNSResolver: "10.89.0.1", TestedOnHost: true,
			}, nil
		}
		if _, err := executor.Run(probeContext, root, nil, "podman-compose", "version"); err != nil {
			return Runtime{}, fmt.Errorf("neither podman compose nor podman-compose is available")
		}
		return Runtime{
			Name: Podman, Executable: "podman-compose", DNSResolver: "10.89.0.1",
			TestedOnHost: true,
		}, nil
	default:
		return Runtime{}, fmt.Errorf("unsupported container runtime %q", name)
	}
}

func DetectFunctionalRuntimes(
	ctx context.Context,
	executor Executor,
	root string,
) map[RuntimeName]Runtime {
	functional := make(map[RuntimeName]Runtime, 2)
	for _, name := range []RuntimeName{Docker, Podman} {
		if runtime, err := ProbeRuntime(ctx, executor, root, name); err == nil {
			functional[name] = runtime
		}
	}
	return functional
}
