package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// startDetached runs `snowglobe daemon args…` in a session of its own, so it outlives this
// terminal, with its output in daemon.log beside its socket; it returns once the daemon answers.
func startDetached(args []string) (*daemon.Client, error) {
	if c, ok := daemon.Find(); ok {
		return c, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	dir, err := daemon.Dir()
	if err != nil {
		return nil, err
	}
	// (The first start: nothing has made its directory yet)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	logPath := filepath.Join(dir, "daemon.log")
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer logf.Close()
	cmd := exec.Command(exe, append([]string{"daemon"}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.After(60 * time.Second)
	for {
		select {
		case err := <-exited:
			return nil, fmt.Errorf("the daemon stopped as it started (%v): see %s", err, logPath)
		case <-deadline:
			return nil, fmt.Errorf("the daemon didn't answer in time: see %s", logPath)
		case <-time.After(200 * time.Millisecond):
			if c, ok := daemon.Find(); ok {
				fmt.Printf("snowglobe daemon started (pid %d), its log at %s\n", cmd.Process.Pid, logPath)
				cmd.Process.Release()
				return c, nil
			}
		}
	}
}
