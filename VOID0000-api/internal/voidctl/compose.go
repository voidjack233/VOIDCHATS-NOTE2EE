package voidctl

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

func composeInvocation(root string, runtime Runtime, command ...string) (string, []string, error) {
	environment, err := ReadEnvironment(filepath.Join(root, "deploy", ".env"))
	if err != nil {
		return "", nil, fmt.Errorf("read deployment environment: %w", err)
	}
	project := strings.TrimSpace(environment["VOID_COMPOSE_PROJECT"])
	if project == "" {
		return "", nil, fmt.Errorf("VOID_COMPOSE_PROJECT is missing")
	}
	args := append([]string{}, runtime.ComposePrefix...)
	args = append(args,
		"--env-file", filepath.Join("deploy", ".env"),
		"--project-name", project,
		"--file", "compose.yaml",
	)
	args = append(args, command...)
	return runtime.Executable, args, nil
}

func queryDeploymentStatus(
	ctx context.Context,
	executor Executor,
	root string,
	runtime Runtime,
) (DeploymentStatus, error) {
	executable, args, err := composeInvocation(root, runtime, "ps", "--all", "--format", "json")
	if err != nil {
		return DeploymentStatus{}, err
	}
	result, runErr := executor.Run(ctx, root, nil, executable, args...)
	if runErr != nil {
		return DeploymentStatus{}, fmt.Errorf("compose status failed: %w: %s", runErr, strings.TrimSpace(result.Stderr))
	}
	containers, err := ParseComposePS([]byte(result.Stdout))
	if err != nil {
		return DeploymentStatus{}, fmt.Errorf("parse compose status: %w", err)
	}
	return ClassifyStatus(containers), nil
}
