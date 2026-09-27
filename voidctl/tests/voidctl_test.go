package voidctl_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/voidjack233/voidchats-note2ee/voidctl"
)

type fakeExecutor struct {
	runs         [][]string
	interactive  [][]string
	commands     []recordedCommand
	composePS    string
	dirtyTracked bool
	failOn       string
}

type recordedCommand struct {
	args []string
	tag  string
	sha  string
}

func (executor *fakeExecutor) record(root string, command []string) {
	recorded := recordedCommand{args: command}
	if values, err := voidctl.ReadEnvironment(filepath.Join(root, "deploy", ".env")); err == nil {
		recorded.tag = values["VOID_IMAGE_TAG"]
		recorded.sha = values["VOID_GIT_SHA"]
	}
	executor.commands = append(executor.commands, recorded)
}

func (executor *fakeExecutor) Run(
	_ context.Context,
	root string,
	_ []string,
	name string,
	args ...string,
) (voidctl.Result, error) {
	command := append([]string{name}, args...)
	executor.runs = append(executor.runs, command)
	executor.record(root, command)
	if executor.failOn != "" && strings.Contains(strings.Join(command, " "), executor.failOn) {
		return voidctl.Result{Stderr: "injected failure"}, fmt.Errorf("injected failure")
	}
	if name == "git" && reflect.DeepEqual(args, []string{"rev-parse", "HEAD"}) {
		return voidctl.Result{Stdout: strings.Repeat("a", 40) + "\n"}, nil
	}
	if name == "git" && reflect.DeepEqual(args, []string{"status", "--porcelain", "--untracked-files=no"}) && executor.dirtyTracked {
		return voidctl.Result{Stdout: " M tracked.go\n"}, nil
	}
	if name == "docker" && executor.composePS != "" {
		for _, argument := range args {
			if argument == "ps" {
				return voidctl.Result{Stdout: executor.composePS}, nil
			}
		}
	}
	return voidctl.Result{}, nil
}

func (executor *fakeExecutor) Interactive(
	_ context.Context,
	root string,
	_ []string,
	name string,
	args ...string,
) error {
	command := append([]string{name}, args...)
	executor.interactive = append(executor.interactive, command)
	executor.record(root, command)
	if executor.failOn != "" && strings.Contains(strings.Join(command, " "), executor.failOn) {
		return fmt.Errorf("injected failure")
	}
	return nil
}

func deploymentTemplate() string {
	return strings.Join([]string{
		"VOID_COMPOSE_PROJECT=voidapp-test",
		"VOID_IMAGE_TAG=replace-with-git-sha",
		"VOID_GIT_SHA=replace-with-full-git-sha",
		"VOID_EDGE_BIND=127.0.0.1",
		"VOID_EDGE_PORT=8080",
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

func restartFixture(t *testing.T) (voidctl.App, *fakeExecutor, string, *bytes.Buffer) {
	t.Helper()
	root := testRoot(t)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	host, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	states, err := json.Marshal(healthyContainers())
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakeExecutor{composePS: string(states)}
	var output bytes.Buffer
	app := voidctl.App{Root: root, Executor: executor, Stdout: &output, Stderr: &output}
	if err := app.Run(context.Background(), []string{"setup", "--runtime", "docker"}); err != nil {
		t.Fatal(err)
	}
	if err := voidctl.UpdateDeploymentEnvironment(root, map[string]string{
		"VOID_EDGE_BIND": host,
		"VOID_EDGE_PORT": port,
		"VOID_IMAGE_TAG": strings.Repeat("b", 12),
		"VOID_GIT_SHA":   strings.Repeat("b", 40),
	}); err != nil {
		t.Fatal(err)
	}
	executor.commands = nil
	executor.runs = nil
	executor.interactive = nil
	output.Reset()
	return app, executor, root, &output
}

func assertDeploymentIdentity(t *testing.T, root, prefix string) {
	t.Helper()
	values, err := voidctl.ReadEnvironment(filepath.Join(root, "deploy", ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if values["VOID_IMAGE_TAG"] != strings.Repeat(prefix, 12) || values["VOID_GIT_SHA"] != strings.Repeat(prefix, 40) {
		t.Fatalf("deployment identity does not match %s", prefix)
	}
}

func commandPosition(commands []recordedCommand, fragment string) int {
	for index, command := range commands {
		if strings.Contains(strings.Join(command.args, " "), fragment) {
			return index
		}
	}
	return -1
}

func assertNoActivation(commands []recordedCommand, t *testing.T) {
	t.Helper()
	for _, fragment := range []string{" down --remove-orphans", " up --detach --remove-orphans"} {
		if commandPosition(commands, fragment) >= 0 {
			t.Fatalf("unexpected activation command %q", fragment)
		}
	}
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

func TestUpBuildsProductionImagesSequentiallyBeforeStarting(t *testing.T) {
	root := testRoot(t)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	host, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	states, err := json.Marshal(healthyContainers())
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakeExecutor{composePS: string(states)}
	app := voidctl.App{Root: root, Executor: executor, Stdout: io.Discard, Stderr: io.Discard}
	if err := app.Run(context.Background(), []string{"setup", "--runtime", "docker"}); err != nil {
		t.Fatal(err)
	}
	if err := voidctl.UpdateDeploymentEnvironment(root, map[string]string{
		"VOID_EDGE_BIND": host,
		"VOID_EDGE_PORT": port,
	}); err != nil {
		t.Fatal(err)
	}

	if err := app.Run(context.Background(), []string{"up"}); err != nil {
		t.Fatal(err)
	}
	if len(executor.interactive) != 6 {
		t.Fatalf("interactive commands = %d, want 6", len(executor.interactive))
	}
	for index, service := range []string{"account", "vmd", "media-worker", "gateway", "edge"} {
		command := strings.Join(executor.interactive[index], " ")
		if !strings.HasSuffix(command, " build "+service) {
			t.Fatalf("build %d = %s, want only %s", index, command, service)
		}
	}
	startCommand := strings.Join(executor.interactive[5], " ")
	if !strings.HasSuffix(startCommand, " up --detach --remove-orphans") {
		t.Fatalf("start command = %s", startCommand)
	}
	if commandPosition(executor.commands, " config --quiet") < 0 || commandPosition(executor.commands, " ps --all --format json") < 0 {
		t.Fatal("up did not validate Compose configuration and wait for READY")
	}
	if commandPosition(executor.commands, " build edge") >= commandPosition(executor.commands, " config --quiet") ||
		commandPosition(executor.commands, " config --quiet") >= commandPosition(executor.commands, " up --detach --remove-orphans") ||
		commandPosition(executor.commands, " up --detach --remove-orphans") >= commandPosition(executor.commands, " ps --all --format json") {
		t.Fatal("up preparation, activation, or readiness commands are out of order")
	}
}

func TestRestartPreflightFailureLeavesDeploymentRunning(t *testing.T) {
	app, executor, root, _ := restartFixture(t)
	executor.dirtyTracked = true
	if err := app.Run(context.Background(), []string{"restart"}); err == nil || !strings.Contains(err.Error(), "tracked Git changes") {
		t.Fatalf("restart error = %v", err)
	}
	assertNoActivation(executor.commands, t)
	if commandPosition(executor.commands, " build account") >= 0 {
		t.Fatal("dirty tree reached image builds")
	}
	assertDeploymentIdentity(t, root, "b")
}

func TestRestartInvalidEnvironmentPermissionsLeaveDeploymentRunning(t *testing.T) {
	app, executor, root, _ := restartFixture(t)
	if err := os.Chmod(filepath.Join(root, "deploy", ".env"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := app.Run(context.Background(), []string{"restart"}); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("restart error = %v", err)
	}
	assertNoActivation(executor.commands, t)
	assertDeploymentIdentity(t, root, "b")
}

func TestRestartBuildFailurePreservesDeploymentAndIdentity(t *testing.T) {
	app, executor, root, _ := restartFixture(t)
	environmentPath := filepath.Join(root, "deploy", ".env")
	before, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	executor.failOn = " build media-worker"
	if err := app.Run(context.Background(), []string{"restart"}); err == nil || !strings.Contains(err.Error(), "media-worker") {
		t.Fatalf("restart error = %v", err)
	}
	assertNoActivation(executor.commands, t)
	for _, service := range []string{"account", "vmd", "media-worker"} {
		position := commandPosition(executor.commands, " build "+service)
		if position < 0 || executor.commands[position].tag != strings.Repeat("a", 12) || executor.commands[position].sha != strings.Repeat("a", 40) {
			t.Fatalf("%s build did not use target image identity", service)
		}
	}
	if commandPosition(executor.commands, " build gateway") >= 0 {
		t.Fatal("builds continued after failure")
	}
	assertDeploymentIdentity(t, root, "b")
	after, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("failed build changed the persistent deployment environment")
	}
}

func TestRestartComposeValidationFailureRestoresIdentity(t *testing.T) {
	app, executor, root, _ := restartFixture(t)
	executor.failOn = " config --quiet"
	if err := app.Run(context.Background(), []string{"restart"}); err == nil || !strings.Contains(err.Error(), "Compose configuration") {
		t.Fatalf("restart error = %v", err)
	}
	assertNoActivation(executor.commands, t)
	if commandPosition(executor.commands, " build edge") < 0 {
		t.Fatal("Compose validation did not follow all builds")
	}
	assertDeploymentIdentity(t, root, "b")
}

func TestRestartPreparesAllImagesBeforeStoppingAndPreservesVolumes(t *testing.T) {
	app, executor, root, _ := restartFixture(t)
	if err := app.Run(context.Background(), []string{"restart"}); err != nil {
		t.Fatal(err)
	}
	previous := -1
	for _, fragment := range []string{
		"docker info", "docker compose version", "git status --porcelain --untracked-files=no",
		"git rev-parse HEAD", " build account", " build vmd", " build media-worker",
		" build gateway", " build edge", " config --quiet", " down --remove-orphans",
		" up --detach --remove-orphans", " ps --all --format json",
	} {
		position := commandPosition(executor.commands, fragment)
		if position <= previous {
			t.Fatalf("command %q was missing or out of order", fragment)
		}
		previous = position
	}
	for _, command := range executor.commands {
		for _, argument := range command.args {
			if argument == "--volumes" || argument == "-v" {
				t.Fatalf("restart requested volume deletion: %v", command.args)
			}
		}
		joined := strings.Join(command.args, " ")
		if strings.Contains(joined, " build ") || strings.Contains(joined, " config --quiet") ||
			strings.Contains(joined, " down --remove-orphans") || strings.Contains(joined, " up --detach") {
			if command.tag != strings.Repeat("a", 12) || command.sha != strings.Repeat("a", 40) {
				t.Fatalf("prepared command has wrong target image identity: %s", joined)
			}
		}
	}
	assertDeploymentIdentity(t, root, "a")
}

func TestRestartShutdownFailureReportsStateAndRestoresIdentity(t *testing.T) {
	app, executor, root, output := restartFixture(t)
	executor.failOn = " down --remove-orphans"
	if err := app.Run(context.Background(), []string{"restart"}); err == nil || !strings.Contains(err.Error(), "shutdown failed") {
		t.Fatalf("restart error = %v", err)
	}
	if commandPosition(executor.commands, " up --detach") >= 0 {
		t.Fatal("restart started replacement after failed shutdown")
	}
	if commandPosition(executor.commands, " ps --all --format json") < 0 || !strings.Contains(output.String(), "READY") {
		t.Fatal("failed shutdown did not report deployment state")
	}
	assertDeploymentIdentity(t, root, "b")
}

func TestRestartStartAndReadinessFailuresReportState(t *testing.T) {
	for _, scenario := range []string{"start", "readiness"} {
		t.Run(scenario, func(t *testing.T) {
			app, executor, root, output := restartFixture(t)
			if scenario == "start" {
				executor.failOn = " up --detach --remove-orphans"
				executor.composePS = ""
			} else {
				states := healthyContainers()
				states[2].ExitCode = 1
				payload, err := json.Marshal(states)
				if err != nil {
					t.Fatal(err)
				}
				executor.composePS = string(payload)
			}
			err := app.Run(context.Background(), []string{"restart"})
			if err == nil {
				t.Fatal("restart concealed activation failure")
			}
			if commandPosition(executor.commands, " down --remove-orphans") < 0 ||
				commandPosition(executor.commands, " ps --all --format json") < 0 {
				t.Fatal("activation failure did not occur after down or report status")
			}
			if !strings.Contains(output.String(), string(voidctl.Stopped)) && !strings.Contains(output.String(), string(voidctl.Failed)) {
				t.Fatal("activation failure did not print deployment state")
			}
			assertDeploymentIdentity(t, root, "a")
		})
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
		"social", "conversation", "vmd", "media-worker", "gateway", "edge",
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
