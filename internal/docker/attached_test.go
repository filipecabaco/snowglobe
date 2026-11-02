package docker

import (
	"errors"
	"os/exec"
	"testing"
)

func TestAttachedEndsWithDockersStatus(t *testing.T) {
	fakeDocker(t)
	if err := Attached("exec", "box", "ls"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_EXIT", "3")
	var x *exec.ExitError
	if err := Attached("exec", "box", "ls"); !errors.As(err, &x) || x.ExitCode() != 3 {
		t.Fatalf("got %v", err)
	}
}
