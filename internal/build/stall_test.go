package build

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/tools"
)

// exit is a real *exec.ExitError with this status (0: success)
func exit(code int) error {
	return exec.Command("sh", "-c", fmt.Sprintf("exit %d", code)).Run()
}

func TestRetryStalled(t *testing.T) {
	for _, c := range []struct {
		name   string
		codes  []int // what each boot ends with
		boots  int
		failed string // the error, if any, contains this
	}{
		{"boots", []int{0}, 1, ""},
		{"stalls once, then boots", []int{tools.ExitBootStalled, 0}, 2, ""},
		{"stalls twice", []int{tools.ExitBootStalled, tools.ExitBootStalled}, 2, "stalled twice"},
		{"fails otherwise: no retry", []int{1}, 1, "exit status 1"},
		{"stalls, then fails otherwise", []int{tools.ExitBootStalled, 1}, 2, "exit status 1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			n := 0
			var log bytes.Buffer
			err := retryStalled(func() error { n++; return exit(c.codes[n-1]) }, &log)
			if n != c.boots {
				t.Errorf("%d boots, want %d", n, c.boots)
			}
			switch {
			case c.failed == "" && err != nil:
				t.Errorf("failed: %v", err)
			case c.failed != "" && (err == nil || !strings.Contains(err.Error(), c.failed)):
				t.Errorf("got %v, want an error with %q", err, c.failed)
			}
			if retried := strings.Contains(log.String(), "booting again"); retried != (c.codes[0] == tools.ExitBootStalled) {
				t.Errorf("log: %q", log.String())
			}
		})
	}
}
