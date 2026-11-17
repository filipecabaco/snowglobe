package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// A job's output is its own: what it prints (stdout and stderr, merged) comes back in its answer
// and nowhere else. Not in its template server's log, which the daemon keeps for the operator
// and every job of every team the template serves would share; not in another job's answer,
// though both run at once. A job also writes the guest's consoles (the serial line, the
// kernel's console, hvc0), which a fork's emulator would otherwise print on the stdout/stderr it
// inherited from its server: the template's log.
func (e *e2e) jobOutputIsolation(t *testing.T) {
	e.startDaemon(t)
	defer e.run(t, nil, "template", "rm", "e2e-out")
	e.must(t, 0, "template", "add", e.site, "--name", "e2e-out")
	dir := os.Getenv("SNOWGLOBE_DAEMON_DIR")
	c, err := daemon.NewClient("unix://"+filepath.Join(dir, "daemon.sock"), "")
	if err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "templates", "e2e-out", "log")
	before, _ := os.ReadFile(logPath)

	job := func(m string) string {
		// Each line printed twice, apart, so the two jobs' lines interleave if they share a stream
		return fmt.Sprintf(`for i in 1 2 3 4 5; do echo %[1]s-out-$i; echo %[1]s-err-$i >&2; `+
			`for d in /dev/ttyS0 /dev/console /dev/hvc0 /dev/kmsg; do echo %[1]s-dev-$i > $d; done 2>/dev/null; sleep 0.2; done`, m)
	}
	marks := []string{"JOBAAA", "JOBBBB"}
	res := make([]*control.JobResult, len(marks))
	errs := make([]error, len(marks))
	var wg sync.WaitGroup
	for i, m := range marks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res[i], errs[i] = c.TemplateJob("e2e-out", control.JobRequest{Cmd: job(m), Timeout: 60})
		}()
	}
	wg.Wait()
	for i, m := range marks {
		if errs[i] != nil {
			t.Fatalf("job %s: %v", m, errs[i])
		}
		out := string(res[i].Output)
		for n := 1; n <= 5; n++ {
			for _, want := range []string{fmt.Sprintf("%s-out-%d", m, n), fmt.Sprintf("%s-err-%d", m, n)} {
				if !strings.Contains(out, want) {
					t.Errorf("job %s lacks %q in its output: %q", m, want, out)
				}
			}
		}
		other := marks[1-i]
		if strings.Contains(out, other) {
			t.Errorf("job %s got job %s's output: %q", m, other, out)
		}
	}
	// And the fork running a job holds no descriptor of the template's log at all: its stdout and
	// stderr are /dev/null (Linux: read from /proc while the job runs)
	if runtime.GOOS == "linux" {
		ts, err := c.Templates()
		if err != nil {
			t.Fatal(err)
		}
		var server int
		for _, tpl := range ts {
			if tpl.Name == "e2e-out" {
				server = tpl.Pid
			}
		}
		done := make(chan error, 1)
		go func() {
			_, err := c.TemplateJob("e2e-out", control.JobRequest{Cmd: "sleep 3", Timeout: 60})
			done <- err
		}()
		var fds map[string]string
		for deadline := time.Now().Add(10 * time.Second); fds == nil && time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
			for _, kid := range children(server) {
				m := map[string]string{}
				entries, _ := os.ReadDir(fmt.Sprintf("/proc/%d/fd", kid))
				for _, e := range entries {
					if to, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", kid, e.Name())); err == nil {
						m[e.Name()] = to
					}
				}
				if len(m) > 0 {
					fds = m
				}
			}
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if fds == nil {
			t.Fatal("found no fork of the template's server running the job")
		}
		if fds["1"] != "/dev/null" || fds["2"] != "/dev/null" {
			t.Errorf("the job's fork has stdout %q, stderr %q (want /dev/null)", fds["1"], fds["2"])
		}
		for fd, to := range fds {
			if to == logPath {
				t.Errorf("the job's fork holds the template's log open (fd %s)", fd)
			}
		}
	}

	after, _ := os.ReadFile(logPath)
	added := strings.TrimPrefix(string(after), string(before))
	for _, m := range marks {
		if strings.Contains(added, m) {
			t.Errorf("the template's log has job %s's output:\n%s", m, added)
		}
	}
}

// children are the pids of pid's child processes (Linux).
func children(pid int) []int {
	var kids []int
	tasks, _ := filepath.Glob(fmt.Sprintf("/proc/%d/task/*/children", pid))
	for _, f := range tasks {
		data, _ := os.ReadFile(f)
		for _, w := range strings.Fields(string(data)) {
			var k int
			if _, err := fmt.Sscan(w, &k); err == nil {
				kids = append(kids, k)
			}
		}
	}
	return kids
}
