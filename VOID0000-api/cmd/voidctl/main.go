package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/internal/voidctl"
)

func main() {
	root, err := voidctl.FindRepositoryRoot(mustWorkingDirectory())
	if err != nil {
		fmt.Fprintln(os.Stderr, "voidctl:", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app := voidctl.App{
		Root: root,
		Executor: voidctl.OSExecutor{
			Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr,
		},
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	}
	if err := app.Run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "voidctl:", err)
		os.Exit(1)
	}
}

func mustWorkingDirectory() string {
	directory, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "voidctl:", err)
		os.Exit(1)
	}
	return directory
}
