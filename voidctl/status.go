package voidctl

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type DeploymentState string

const (
	Stopped  DeploymentState = "STOPPED"
	Running  DeploymentState = "RUNNING"
	Ready    DeploymentState = "READY"
	Degraded DeploymentState = "DEGRADED"
	Failed   DeploymentState = "FAILED"
)

var longLivedServices = []string{
	"postgres", "scylla", "valkey", "minio", "worker", "account", "message",
	"social", "conversation", "vmd", "gateway", "edge",
}

var oneShotServices = []string{"volume-init", "minio-init", "migrate"}

type ContainerState struct {
	Service  string `json:"Service"`
	Name     string `json:"Name"`
	State    string `json:"State"`
	Health   string `json:"Health"`
	ExitCode int    `json:"ExitCode"`
}

type DeploymentStatus struct {
	State      DeploymentState
	Containers []ContainerState
	Reasons    []string
}

func ParseComposePS(payload []byte) ([]ContainerState, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var states []ContainerState
		if err := json.Unmarshal(trimmed, &states); err != nil {
			return nil, err
		}
		return states, nil
	}

	states := make([]ContainerState, 0)
	scanner := bufio.NewScanner(bytes.NewReader(trimmed))
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var state ContainerState
		if err := json.Unmarshal(line, &state); err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, scanner.Err()
}

func ClassifyStatus(containers []ContainerState) DeploymentStatus {
	status := DeploymentStatus{State: Stopped, Containers: containers}
	if len(containers) == 0 {
		return status
	}
	byService := make(map[string]ContainerState, len(containers))
	for _, container := range containers {
		byService[container.Service] = container
	}

	failed := false
	starting := false
	unhealthy := false
	for _, service := range oneShotServices {
		container, exists := byService[service]
		if !exists {
			failed = true
			status.Reasons = append(status.Reasons, service+" is missing")
			continue
		}
		state := strings.ToLower(container.State)
		if state == "running" || state == "created" || state == "restarting" {
			starting = true
			continue
		}
		if state != "exited" || container.ExitCode != 0 {
			failed = true
			status.Reasons = append(status.Reasons, fmt.Sprintf(
				"%s state=%s exit=%d", service, container.State, container.ExitCode,
			))
		}
	}

	for _, service := range longLivedServices {
		container, exists := byService[service]
		if !exists {
			failed = true
			status.Reasons = append(status.Reasons, service+" is missing")
			continue
		}
		if strings.ToLower(container.State) != "running" {
			failed = true
			status.Reasons = append(status.Reasons, service+" is "+container.State)
			continue
		}
		switch strings.ToLower(container.Health) {
		case "healthy":
		case "starting", "":
			starting = true
		default:
			unhealthy = true
			status.Reasons = append(status.Reasons, service+" health="+container.Health)
		}
	}

	sort.Strings(status.Reasons)
	switch {
	case failed:
		status.State = Failed
	case unhealthy:
		status.State = Degraded
	case starting:
		status.State = Running
	default:
		status.State = Ready
	}
	return status
}
