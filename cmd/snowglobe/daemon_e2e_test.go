package main

import (
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The orchestrator, driven as a user does: a daemon, a template of the site, machines forked from
// it with a port forwarded, and sh, cp, ps and stop reaching them through the daemon.
func (e *e2e) daemonFleet(t *testing.T) {
	dir, err := os.MkdirTemp("", "sgd-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	t.Setenv("SNOWGLOBE_DAEMON_DIR", dir)
	d := exec.Command(e.bin, "daemon")
	log, _ := os.Create(filepath.Join(dir, "daemon.log"))
	d.Stdout, d.Stderr = log, log
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		e.run(t, nil, "template", "rm", "e2e")
		d.Process.Signal(syscall.SIGTERM)
		d.Wait()
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(dir, "daemon.log"))
			t.Logf("daemon log:\n%s", data)
		}
	}()
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if _, code := e.run(t, nil, "template", "ls"); code == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the daemon did not start")
		}
	}

	if out := e.must(t, 0, "template", "add", e.site, "--name", "e2e"); !strings.Contains(out, "serving jobs") {
		t.Errorf("template add: %q", out)
	}
	out := e.must(t, 0, "up", "e2e", "--name", "m1", "-p", "0:8000", "--label", "app=web")
	port := regexp.MustCompile(`127\.0\.0\.1:(\d+)→8000`).FindStringSubmatch(out)
	if port == nil {
		t.Fatalf("up: %q", out)
	}
	e.must(t, 0, "up", "e2e", "--name", "m2")

	// Each machine keeps what it writes; the other doesn't see it
	e.must(t, 0, "sh", "m1", "echo kept > /root/f")
	if out := e.must(t, 0, "sh", "m1", "cat /root/f"); out != "kept\n" {
		t.Errorf("m1: %q", out)
	}
	e.must(t, 1, "sh", "m2", "test -e /root/f")

	// cp both ways
	local := filepath.Join(t.TempDir(), "a.txt")
	os.WriteFile(local, []byte("from the host\n"), 0o644)
	e.must(t, 0, "cp", local, "m2:/root/a.txt")
	back := filepath.Join(t.TempDir(), "b.txt")
	e.must(t, 0, "cp", "m2:/root/a.txt", back)
	if data, _ := os.ReadFile(back); string(data) != "from the host\n" {
		t.Errorf("cp back: %q", data)
	}

	// A server in m1, reached on the host port the daemon forwards
	e.must(t, 0, "sh", "m1", `(while true; do printf "HTTP/1.0 200 OK\r\n\r\nhello from m1\n" | nc -l -p 8000; done) >/dev/null 2>&1 &`)
	var body string
	for i := 0; i < 10 && !strings.Contains(body, "hello from m1"); i++ {
		if resp, err := (&http.Client{Timeout: 20 * time.Second}).Get("http://127.0.0.1:" + port[1] + "/"); err == nil {
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			body = string(data)
		}
		if !strings.Contains(body, "hello from m1") {
			time.Sleep(time.Second)
		}
	}
	if !strings.Contains(body, "hello from m1") {
		t.Errorf("forwarded port: %q", body)
	}

	if out := e.must(t, 0, "ps"); !strings.Contains(out, "m1\ttemplate e2e") || !strings.Contains(out, "m2\ttemplate e2e") {
		t.Errorf("ps: %q", out)
	}
	e.must(t, 0, "stop", "m1")
	if out := e.must(t, 0, "ps"); strings.Contains(out, "m1\t") {
		t.Errorf("ps after stop: %q", out)
	}
	if _, code := e.run(t, nil, "sh", "m1", "true"); code == 0 {
		t.Error("sh on a stopped machine")
	}
	e.must(t, 0, "template", "rm", "e2e")
	if out := e.must(t, 0, "ps"); strings.Contains(out, "m2\t") {
		t.Errorf("ps after template rm: %q", out)
	}
}
