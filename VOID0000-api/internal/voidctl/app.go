package voidctl

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type App struct {
	Root     string
	Executor Executor
	Stdout   io.Writer
	Stderr   io.Writer
}

func FindRepositoryRoot(start string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv("VOID_REPO_ROOT")); configured != "" {
		start = configured
	}
	absolute, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for candidate := absolute; ; candidate = filepath.Dir(candidate) {
		if fileExists(filepath.Join(candidate, "compose.yaml")) &&
			fileExists(filepath.Join(candidate, "VOID0000-api", "go.mod")) {
			return candidate, nil
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			break
		}
	}
	return "", fmt.Errorf("cannot locate repository root from %s", start)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (app App) usage() {
	fmt.Fprintln(app.Stderr, "Usage: voidctl <runtime|doctor|setup|up|down|restart|status|logs> [options]")
}

func (app App) selectedRuntime(ctx context.Context) (Runtime, error) {
	selected, err := LoadSelectedRuntime(app.Root)
	if err != nil {
		return Runtime{}, err
	}
	if selected == "" {
		return Runtime{}, fmt.Errorf("no runtime selected; run voidctl setup --runtime docker|podman")
	}
	return ProbeRuntime(ctx, app.Executor, app.Root, selected)
}

func (app App) Run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		app.usage()
		return fmt.Errorf("command is required")
	}
	switch args[0] {
	case "runtime":
		return app.runtime(ctx)
	case "doctor":
		return app.doctor(ctx)
	case "setup":
		return app.setup(ctx, args[1:])
	case "up":
		return app.up(ctx)
	case "down":
		return app.down(ctx)
	case "restart":
		if err := app.down(ctx); err != nil {
			return err
		}
		return app.up(ctx)
	case "status":
		return app.status(ctx)
	case "logs":
		return app.logs(ctx, args[1:])
	default:
		app.usage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func (app App) runtime(ctx context.Context) error {
	selected, err := LoadSelectedRuntime(app.Root)
	if err != nil {
		return err
	}
	functional := DetectFunctionalRuntimes(ctx, app.Executor, app.Root)
	fmt.Fprintf(app.Stdout, "selected: %s\n", valueOr(selected, "none"))
	for _, name := range []RuntimeName{Docker, Podman} {
		_, works := functional[name]
		fmt.Fprintf(app.Stdout, "%s: %s\n", name, yesNo(works))
	}
	return nil
}

func (app App) setup(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(app.Stderr)
	runtimeFlag := flags.String("runtime", "", "docker or podman")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected setup arguments: %v", flags.Args())
	}

	selected, err := LoadSelectedRuntime(app.Root)
	if err != nil {
		return err
	}
	requested := RuntimeName(strings.TrimSpace(*runtimeFlag))
	if requested == "" {
		if selected != "" {
			requested = selected
		} else {
			functional := DetectFunctionalRuntimes(ctx, app.Executor, app.Root)
			if len(functional) != 1 {
				return fmt.Errorf("select a runtime explicitly with --runtime docker or --runtime podman")
			}
			for name := range functional {
				requested = name
			}
		}
	}
	if requested != Docker && requested != Podman {
		return fmt.Errorf("unsupported runtime %q", requested)
	}
	runtime, err := ProbeRuntime(ctx, app.Executor, app.Root, requested)
	if err != nil {
		return err
	}
	sha, err := app.gitSHA(ctx)
	if err != nil {
		return err
	}
	created, err := EnsureDeploymentEnvironment(app.Root, runtime, sha)
	if err != nil {
		return fmt.Errorf("create deployment environment: %w", err)
	}
	if err := SaveSelectedRuntime(app.Root, requested); err != nil {
		return fmt.Errorf("persist runtime selection: %w", err)
	}
	if created {
		fmt.Fprintln(app.Stdout, "created deploy/.env with mode 0600")
	} else {
		fmt.Fprintln(app.Stdout, "kept existing deploy/.env secrets")
	}
	fmt.Fprintf(app.Stdout, "selected runtime: %s\n", requested)
	return nil
}

func (app App) doctor(ctx context.Context) error {
	runtime, err := app.selectedRuntime(ctx)
	if err != nil {
		return err
	}
	checks := []struct {
		name string
		err  error
	}{
		{name: "runtime", err: nil},
		{name: "deployment environment", err: requirePrivateEnvironment(app.Root)},
		{name: "tracked Git tree", err: app.requireCleanTrackedTree(ctx)},
	}
	executable, composeArgs, composeErr := composeInvocation(app.Root, runtime, "config", "--quiet")
	if composeErr == nil {
		result, runErr := app.Executor.Run(ctx, app.Root, nil, executable, composeArgs...)
		if runErr != nil {
			composeErr = fmt.Errorf("%w: %s", runErr, strings.TrimSpace(result.Stderr))
		}
	}
	checks = append(checks, struct {
		name string
		err  error
	}{name: "Compose configuration", err: composeErr})
	checks = append(checks, struct {
		name string
		err  error
	}{name: "edge bind", err: app.checkEdgeBind(ctx, runtime)})

	failed := false
	for _, check := range checks {
		if check.err != nil {
			failed = true
			fmt.Fprintf(app.Stdout, "FAIL %-24s %v\n", check.name, check.err)
		} else {
			fmt.Fprintf(app.Stdout, "OK   %s\n", check.name)
		}
	}
	if runtime.Name == Podman {
		fmt.Fprintln(app.Stdout, "WARN Podman topology support is implemented but must be verified on this host")
	}
	if failed {
		return fmt.Errorf("one or more doctor checks failed")
	}
	return nil
}

func (app App) up(ctx context.Context) error {
	runtime, err := app.selectedRuntime(ctx)
	if err != nil {
		return err
	}
	if err := requirePrivateEnvironment(app.Root); err != nil {
		return err
	}
	if err := app.requireCleanTrackedTree(ctx); err != nil {
		return err
	}
	sha, err := app.gitSHA(ctx)
	if err != nil {
		return err
	}
	if err := UpdateDeploymentEnvironment(app.Root, map[string]string{
		"VOID_IMAGE_TAG": sha[:12],
		"VOID_GIT_SHA":   sha,
	}); err != nil {
		return err
	}

	// Build one image at a time so TypeScript, Go, and Elixir compilers cannot
	// contend for the host's memory during a production deployment.
	for _, service := range []string{"account", "vmd", "gateway", "edge"} {
		fmt.Fprintf(app.Stdout, "building production image: %s\n", service)
		if err := app.composeInteractive(ctx, runtime, "build", service); err != nil {
			return fmt.Errorf("production image build failed for %s: %w", service, err)
		}
	}
	if err := app.composeInteractive(ctx, runtime, "up", "--detach", "--remove-orphans"); err != nil {
		status, _ := queryDeploymentStatus(ctx, app.Executor, app.Root, runtime)
		app.printStatus(status)
		return fmt.Errorf("deployment start failed: %w", err)
	}

	deadline := time.Now().Add(10 * time.Minute)
	lastState := DeploymentState("")
	for time.Now().Before(deadline) {
		status, statusErr := queryDeploymentStatus(ctx, app.Executor, app.Root, runtime)
		if statusErr != nil {
			return statusErr
		}
		if status.State != lastState {
			fmt.Fprintf(app.Stdout, "deployment state: %s\n", status.State)
			lastState = status.State
		}
		if status.State == Ready {
			return nil
		}
		if status.State == Failed {
			app.printStatus(status)
			return fmt.Errorf("deployment entered FAILED state")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("deployment did not become READY within 10 minutes")
}

func (app App) down(ctx context.Context) error {
	runtime, err := app.selectedRuntime(ctx)
	if err != nil {
		return err
	}
	// Deliberately no --volumes/-v: normal lifecycle must preserve all data.
	return app.composeInteractive(ctx, runtime, "down", "--remove-orphans")
}

func (app App) status(ctx context.Context) error {
	runtime, err := app.selectedRuntime(ctx)
	if err != nil {
		return err
	}
	status, err := queryDeploymentStatus(ctx, app.Executor, app.Root, runtime)
	if err != nil {
		return err
	}
	app.printStatus(status)
	if status.State == Failed || status.State == Degraded {
		return fmt.Errorf("deployment state is %s", status.State)
	}
	return nil
}

func (app App) logs(ctx context.Context, args []string) error {
	runtime, err := app.selectedRuntime(ctx)
	if err != nil {
		return err
	}
	command := append([]string{"logs"}, args...)
	return app.composeInteractive(ctx, runtime, command...)
}

func (app App) composeInteractive(ctx context.Context, runtime Runtime, command ...string) error {
	executable, args, err := composeInvocation(app.Root, runtime, command...)
	if err != nil {
		return err
	}
	return app.Executor.Interactive(ctx, app.Root, nil, executable, args...)
}

func (app App) gitSHA(ctx context.Context) (string, error) {
	result, err := app.Executor.Run(ctx, app.Root, nil, "git", "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(result.Stdout)
	if len(sha) != 40 {
		return "", fmt.Errorf("unexpected Git SHA %q", sha)
	}
	return sha, nil
}

func (app App) requireCleanTrackedTree(ctx context.Context) error {
	result, err := app.Executor.Run(
		ctx, app.Root, nil, "git", "status", "--porcelain", "--untracked-files=no",
	)
	if err != nil {
		return err
	}
	if strings.TrimSpace(result.Stdout) != "" {
		return fmt.Errorf("tracked Git changes exist; commit or restore them before deployment")
	}
	return nil
}

func requirePrivateEnvironment(root string) error {
	path := filepath.Join(root, "deploy", ".env")
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("run voidctl setup first: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("deploy/.env permissions must be 0600, got %04o", info.Mode().Perm())
	}
	values, err := ReadEnvironment(path)
	if err != nil {
		return err
	}
	for key, value := range values {
		if strings.Contains(strings.ToLower(value), "replace-with-") {
			return fmt.Errorf("deploy/.env contains placeholder %s", key)
		}
	}
	return nil
}

func (app App) checkEdgeBind(ctx context.Context, runtime Runtime) error {
	values, err := ReadEnvironment(filepath.Join(app.Root, "deploy", ".env"))
	if err != nil {
		return err
	}
	bind := valueOr(values["VOID_EDGE_BIND"], "127.0.0.1")
	port := valueOr(values["VOID_EDGE_PORT"], "8080")
	if _, err := strconv.Atoi(port); err != nil {
		return fmt.Errorf("invalid VOID_EDGE_PORT %q", port)
	}
	if _, err := net.ResolveTCPAddr("tcp", net.JoinHostPort(bind, port)); err != nil {
		return fmt.Errorf("invalid edge bind address: %w", err)
	}
	// A running edge must be reachable. A stopped deployment must leave the bind free.
	status, statusErr := queryDeploymentStatus(ctx, app.Executor, app.Root, runtime)
	if statusErr == nil {
		for _, container := range status.Containers {
			if container.Service == "edge" && strings.ToLower(container.State) == "running" {
				return checkEdgeEndpoint(ctx, app.Root)
			}
		}
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(bind, port))
	if err == nil {
		return listener.Close()
	}
	return fmt.Errorf("cannot bind %s: %w", net.JoinHostPort(bind, port), err)
}

func (app App) printStatus(status DeploymentStatus) {
	fmt.Fprintf(app.Stdout, "%s\n", status.State)
	containers := append([]ContainerState(nil), status.Containers...)
	sort.Slice(containers, func(i, j int) bool { return containers[i].Service < containers[j].Service })
	for _, container := range containers {
		fmt.Fprintf(
			app.Stdout, "%-14s state=%-10s health=%-10s exit=%d\n",
			container.Service, container.State, valueOr(container.Health, "-"), container.ExitCode,
		)
	}
	for _, reason := range status.Reasons {
		fmt.Fprintln(app.Stdout, "- "+reason)
	}
}

func valueOr[T ~string](value T, fallback string) string {
	if strings.TrimSpace(string(value)) == "" {
		return fallback
	}
	return string(value)
}

func yesNo(value bool) string {
	if value {
		return "available"
	}
	return "unavailable"
}
