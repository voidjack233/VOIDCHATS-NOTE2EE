package voidctl

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"time"
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
	status := ClassifyStatus(containers)
	if status.State == Ready {
		if edgeErr := checkEdgeEndpoint(ctx, root); edgeErr != nil {
			status.State = Degraded
			status.Reasons = append(status.Reasons, "edge endpoint unreachable: "+edgeErr.Error())
		}
	}
	return status, nil
}

func edgeAddress(root string) (string, error) {
	environment, err := ReadEnvironment(filepath.Join(root, "deploy", ".env"))
	if err != nil {
		return "", err
	}
	bind := strings.TrimSpace(environment["VOID_EDGE_BIND"])
	if bind == "" || bind == "0.0.0.0" {
		bind = "127.0.0.1"
	} else if bind == "::" {
		bind = "::1"
	}
	port := strings.TrimSpace(environment["VOID_EDGE_PORT"])
	if port == "" {
		port = "8080"
	}
	return net.JoinHostPort(bind, port), nil
}

func checkEdgeEndpoint(ctx context.Context, root string) error {
	address, err := edgeAddress(root)
	if err != nil {
		return err
	}
	requestContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestContext,
		http.MethodGet,
		"http://"+address+"/health",
		nil,
	)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("HTTP status %d", response.StatusCode)
	}
	return nil
}
