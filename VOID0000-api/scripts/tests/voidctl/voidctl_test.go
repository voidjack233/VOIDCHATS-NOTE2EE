package voidctl_test

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/internal/voidctl"
)

type fakeExecutor struct {
	runs        [][]string
	interactive [][]string
}

func (executor *fakeExecutor) Run(
	_ context.Context,
	_ string,
	_ []string,
	name string,
	args ...string,
) (voidctl.Result, error) {
	command := append([]string{name}, args...)
	executor.runs = append(executor.runs, command)
	if name == "git" && reflect.DeepEqual(args, []string{"rev-parse", "HEAD"}) {
		return voidctl.Result{Stdout: strings.Repeat("a", 40) + "\n"}, nil
	}
	return voidctl.Result{}, nil
}

func (executor *fakeExecutor) Interactive(
	_ context.Context,
	_ string,
	_ []string,
	name string,
	args ...string,
) error {
	executor.interactive = append(executor.interactive, append([]string{name}, args...))
	return nil
}

func deploymentTemplate() string {
	return strings.Join([]string{
		"VOID_COMPOSE_PROJECT=voidapp-test",
		"VOID_IMAGE_TAG=replace-with-git-sha",
		"VOID_GIT_SHA=replace-with-full-git-sha",
		"VOID_DNS_RESOLVER=127.0.0.11",
		"PGPASSWORD=replace-with-random-password",
		"MINIO_ACCESS_KEY=replace-with-random-access-key",
		"MINIO_SECRET_KEY=replace-with-random-secret-key",
		"ACCESS_SECRET=replace-with-random-secret",
		"REFRESH_SECRET=replace-with-random-secret",
		"CSRF_ENCRYPTION_KEY=replace-with-base64-key",
		"TOTP_ENCRYPTION_KEY=replace-with-hex-key",
		"TWO_FACTOR_CODE_SECRET=replace-with-random-secret",
		"VMD_SIGNING_SECRET=replace-with-random-secret",
		"PHX_SECRET_KEY_BASE=replace-with-random-secret",
	}, "\n") + "\n"
}

func testRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "deploy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "deploy", ".env.example"),
		[]byte(deploymentTemplate()),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestSetupGeneratesPrivateSecretsAndIsIdempotent(t *testing.T) {
	root := testRoot(t)
	executor := &fakeExecutor{}
	app := voidctl.App{
		Root: root, Executor: executor,
		Stdout: io.Discard, Stderr: io.Discard,
	}
	if err := app.Run(context.Background(), []string{"setup", "--runtime", "docker"}); err != nil {
		t.Fatal(err)
	}
	environmentPath := filepath.Join(root, "deploy", ".env")
	first, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("deploy/.env mode = %04o, want 0600", got)
	}
	if strings.Contains(string(first), "replace-with-") {
		t.Fatal("generated environment contains placeholders")
	}
	if err := app.Run(context.Background(), []string{"setup"}); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("idempotent setup changed existing secrets")
	}
	selected, err := voidctl.LoadSelectedRuntime(root)
	if err != nil || selected != voidctl.Docker {
		t.Fatalf("selected runtime = %q, %v", selected, err)
	}
}

func TestDownNeverRequestsVolumeDeletion(t *testing.T) {
	root := testRoot(t)
	if err := os.WriteFile(
		filepath.Join(root, "deploy", ".env"),
		[]byte("VOID_COMPOSE_PROJECT=voidapp-test\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := voidctl.SaveSelectedRuntime(root, voidctl.Docker); err != nil {
		t.Fatal(err)
	}
	executor := &fakeExecutor{}
	app := voidctl.App{Root: root, Executor: executor, Stdout: io.Discard, Stderr: io.Discard}
	if err := app.Run(context.Background(), []string{"down"}); err != nil {
		t.Fatal(err)
	}
	if len(executor.interactive) != 1 {
		t.Fatalf("interactive commands = %d, want 1", len(executor.interactive))
	}
	command := strings.Join(executor.interactive[0], " ")
	if strings.Contains(command, " --volumes") || strings.Contains(command, " -v") {
		t.Fatalf("destructive down command: %s", command)
	}
	if !strings.Contains(command, " down --remove-orphans") {
		t.Fatalf("unexpected down command: %s", command)
	}
}

func healthyContainers() []voidctl.ContainerState {
	containers := make([]voidctl.ContainerState, 0, 15)
	for _, service := range []string{"volume-init", "minio-init", "migrate"} {
		containers = append(containers, voidctl.ContainerState{
			Service: service, State: "exited", ExitCode: 0,
		})
	}
	for _, service := range []string{
		"postgres", "scylla", "valkey", "minio", "worker", "account", "message",
		"social", "conversation", "vmd", "gateway", "edge",
	} {
		containers = append(containers, voidctl.ContainerState{
			Service: service, State: "running", Health: "healthy",
		})
	}
	return containers
}

func TestDeploymentStateClassification(t *testing.T) {
	tests := []struct {
		name       string
		containers func() []voidctl.ContainerState
		want       voidctl.DeploymentState
	}{
		{name: "stopped", containers: func() []voidctl.ContainerState { return nil }, want: voidctl.Stopped},
		{name: "ready", containers: healthyContainers, want: voidctl.Ready},
		{name: "running", containers: func() []voidctl.ContainerState {
			states := healthyContainers()
			states[3].Health = "starting"
			return states
		}, want: voidctl.Running},
		{name: "degraded", containers: func() []voidctl.ContainerState {
			states := healthyContainers()
			states[3].Health = "unhealthy"
			return states
		}, want: voidctl.Degraded},
		{name: "failed migration", containers: func() []voidctl.ContainerState {
			states := healthyContainers()
			states[2].ExitCode = 1
			return states
		}, want: voidctl.Failed},
		{name: "missing service", containers: func() []voidctl.ContainerState {
			states := healthyContainers()
			return states[:len(states)-1]
		}, want: voidctl.Failed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := voidctl.ClassifyStatus(test.containers()).State; got != test.want {
				t.Fatalf("state = %s, want %s", got, test.want)
			}
		})
	}
}

func TestParseComposePSAcceptsArrayAndJSONLines(t *testing.T) {
	array := `[{"Service":"edge","State":"running","Health":"healthy","ExitCode":0}]`
	lines := "{\"Service\":\"edge\",\"State\":\"running\",\"Health\":\"healthy\",\"ExitCode\":0}\n" +
		"{\"Service\":\"migrate\",\"State\":\"exited\",\"ExitCode\":0}\n"
	parsedArray, err := voidctl.ParseComposePS([]byte(array))
	if err != nil || len(parsedArray) != 1 {
		t.Fatalf("array parse = %v, %v", parsedArray, err)
	}
	parsedLines, err := voidctl.ParseComposePS([]byte(lines))
	if err != nil || len(parsedLines) != 2 {
		t.Fatalf("line parse = %v, %v", parsedLines, err)
	}
}

func TestPersistedRuntimeDoesNotSilentlySwitch(t *testing.T) {
	root := t.TempDir()
	if err := voidctl.SaveSelectedRuntime(root, voidctl.Podman); err != nil {
		t.Fatal(err)
	}
	selected, err := voidctl.LoadSelectedRuntime(root)
	if err != nil {
		t.Fatal(err)
	}
	if selected != voidctl.Podman {
		t.Fatal(fmt.Sprintf("selected runtime = %q, want podman", selected))
	}
}
