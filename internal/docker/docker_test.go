package docker

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeDocker puts a docker on the PATH that prints its arguments, then FAKE_OUT, and exits with
// FAKE_EXIT (after a line on stderr when it fails).
func fakeDocker(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := `#!/bin/sh
echo "args: $*"
[ -n "$FAKE_OUT" ] && printf '%s\n' "$FAKE_OUT"
[ "${FAKE_EXIT:-0}" = 0 ] || echo "something broke" >&2
exit "${FAKE_EXIT:-0}"
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("FAKE_OUT", "")
	t.Setenv("FAKE_EXIT", "0")
}

// The build retries a boot on the snapshot's exit status, read through these errors
func TestAFailureKeepsItsExitStatus(t *testing.T) {
	fakeDocker(t)
	t.Setenv("FAKE_EXIT", "75")
	for name, run := range map[string]func() error{
		"Run":   func() error { return Run("run", "img") },
		"Quiet": func() error { return Quiet("run", "img") },
		"Stream": func() error {
			return Stream(func(r io.Reader) error { _, err := io.ReadAll(r); return err }, "run", "img")
		},
		"Output": func() error { _, err := Output("run", "img"); return err },
	} {
		err := run()
		var x *exec.ExitError
		if !errors.As(err, &x) || x.ExitCode() != 75 || !strings.Contains(err.Error(), "docker run img") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestOutputIsTrimmedAndFailuresSayWhy(t *testing.T) {
	fakeDocker(t)
	t.Setenv("FAKE_OUT", "  abc123  ")
	out, err := Output("create", "img")
	if err != nil || out != "args: create img\n  abc123" {
		t.Fatalf("got %q, %v", out, err)
	}
	t.Setenv("FAKE_EXIT", "1")
	if _, err := Output("create", "img"); err == nil || !strings.HasSuffix(err.Error(), ": something broke") {
		t.Fatalf("got %v", err)
	}
}

func TestStreamHandsOverStdoutAndItsConsumersError(t *testing.T) {
	fakeDocker(t)
	t.Setenv("FAKE_OUT", "the image")
	var got string
	err := Stream(func(r io.Reader) error {
		data, err := io.ReadAll(r)
		got = string(data)
		return err
	}, "save", "img")
	if err != nil || got != "args: save img\nthe image\n" {
		t.Fatalf("got %q, %v", got, err)
	}
	// A consumer that stops early: docker still exits, and the consumer's error is the result
	broken := errors.New("bad tar")
	if err := Stream(func(io.Reader) error { return broken }, "save", "img"); !errors.Is(err, broken) {
		t.Fatalf("got %v", err)
	}
}

func TestNoDockerSaysSo(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if err := Run("version"); err == nil || !strings.Contains(err.Error(), "no docker on the PATH") {
		t.Fatalf("got %v", err)
	}
}
