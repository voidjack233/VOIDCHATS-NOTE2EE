package voidctl

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
)

type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

type Executor interface {
	Run(context.Context, string, []string, string, ...string) (Result, error)
	Interactive(context.Context, string, []string, string, ...string) error
}

type OSExecutor struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

func (executor OSExecutor) Run(
	ctx context.Context,
	directory string,
	environment []string,
	name string,
	args ...string,
) (Result, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
	command.Env = append(os.Environ(), environment...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	result := Result{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 0}
	if err == nil {
		return result, nil
	}
	var exitError *exec.ExitError
	if ok := errorAs(err, &exitError); ok {
		result.ExitCode = exitError.ExitCode()
		return result, fmt.Errorf("%s %v exited with code %d", name, args, result.ExitCode)
	}
	result.ExitCode = -1
	return result, err
}

func (executor OSExecutor) Interactive(
	ctx context.Context,
	directory string,
	environment []string,
	name string,
	args ...string,
) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
	command.Env = append(os.Environ(), environment...)
	command.Stdin = executor.Stdin
	command.Stdout = executor.Stdout
	command.Stderr = executor.Stderr
	return command.Run()
}
