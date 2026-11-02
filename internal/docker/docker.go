// Package docker runs the docker CLI.
package docker

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Run runs docker with its output streamed to the terminal.
func Run(args ...string) error {
	cmd := exec.Command("docker", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return wrap(cmd.Run(), args)
}

// Attached runs docker connected to this process's stdin, stdout and stderr, for sessions.
func Attached(args ...string) error {
	cmd := exec.Command("docker", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return wrap(cmd.Run(), args)
}

// Quiet runs docker with its output on stderr, keeping stdout for the caller's own output.
func Quiet(args ...string) error {
	cmd := exec.Command("docker", args...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	return wrap(cmd.Run(), args)
}

// Output runs docker and returns its trimmed stdout.
func Output(args ...string) (string, error) {
	var stderr bytes.Buffer
	cmd := exec.Command("docker", args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%w: %s", wrap(err, args), strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// Stream runs docker and hands its stdout to consume, e.g. `docker save` into a tar reader.
func Stream(consume func(io.Reader) error, args ...string) error {
	cmd := exec.Command("docker", args...)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return wrap(err, args)
	}
	consumeErr := consume(stdout)
	// Drain whatever consume left so docker can exit
	io.Copy(io.Discard, stdout)
	if err := cmd.Wait(); err != nil {
		return wrap(err, args)
	}
	return consumeErr
}

// Image is the part of an image's config snowglobe needs, as `docker save` and OCI layouts
// store it.
type Image struct {
	Architecture string
	Config       struct {
		Env        []string
		WorkingDir string
		Entrypoint []string
		Cmd        []string
		Labels     map[string]string
	}
}

func wrap(err error, args []string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return errors.New("snowglobe needs Docker: no docker on the PATH")
	}
	return fmt.Errorf("docker %s: %w", strings.Join(args, " "), err)
}
