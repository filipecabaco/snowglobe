package main

import (
	"context"
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
// startDaemon runs `snowglobe daemon` in a directory of its own until the test ends.
func (e *e2e) startDaemon(t *testing.T, flags ...string) {
	dir, err := os.MkdirTemp("", "sgd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_DAEMON_DIR", dir)
	d := exec.Command(e.bin, append([]string{"daemon"}, flags...)...)
	log, _ := os.Create(filepath.Join(dir, "daemon.log"))
	d.Stdout, d.Stderr = log, log
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		d.Process.Signal(syscall.SIGTERM)
		d.Wait()
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(dir, "daemon.log"))
			t.Logf("daemon log:\n%s", data)
		}
		os.RemoveAll(dir)
	})
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if _, code := e.run(t, nil, "template", "ls"); code == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the daemon did not start")
		}
	}
}

// get is the body at url, retried while the server in the guest comes up.
func get(url, want string) (string, time.Duration) {
	var body string
	begun := time.Now()
	for i := 0; i < 10 && !strings.Contains(body, want); i++ {
		if resp, err := (&http.Client{Timeout: 20 * time.Second}).Get(url); err == nil {
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			body = string(data)
		}
		if !strings.Contains(body, want) {
			time.Sleep(time.Second)
		}
	}
	return body, time.Since(begun)
}

func (e *e2e) daemonFleet(t *testing.T) {
	e.startDaemon(t)
	defer e.run(t, nil, "template", "rm", "e2e")

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
	// top: the template, its machines and what they take
	if out := e.must(t, 0, "top", "--once"); !strings.Contains(out, "1 templates (1 awake), 2 machines") ||
		!regexp.MustCompile(`(?m)^m1\s+e2e\s+\d+ MB`).MatchString(out) {
		t.Errorf("top: %q", out)
	}
	// events: what happened so far, as it streams
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	evs, _ := exec.CommandContext(ctx, e.bin, "events").Output()
	for _, want := range []string{"template.added", "machine.up               machine m1", "machine.up               machine m2"} {
		if !strings.Contains(string(evs), want) {
			t.Errorf("events lack %q: %q", want, evs)
		}
	}

	// A snapshot carries the whole machine on: the file it wrote, and a process still running
	e.must(t, 0, "sh", "m1", `(while true; do sleep 1; done) >/dev/null 2>&1 & echo $! > /root/pid`)
	if out := e.must(t, 0, "snapshot", "save", "m1", "--name", "s1"); !strings.Contains(out, "s1: m1 saved") {
		t.Errorf("snapshot save: %q", out)
	}
	defer e.run(t, nil, "snapshot", "rm", "s1")
	e.must(t, 0, "up", "e2e", "--name", "m3", "--snapshot", "s1")
	if out := e.must(t, 0, "sh", "m3", "cat /root/f; kill -0 $(cat /root/pid) && echo running"); out != "kept\nrunning\n" {
		t.Errorf("m3, from the snapshot: %q", out)
	}
	// A template made of it: every machine of it starts there
	e.must(t, 0, "template", "add", "--snapshot", "s1", "--name", "e2e-s1")
	defer e.run(t, nil, "template", "rm", "e2e-s1")
	e.must(t, 0, "up", "e2e-s1", "--name", "m4")
	if out := e.must(t, 0, "sh", "m4", "cat /root/f"); out != "kept\n" {
		t.Errorf("m4, of the snapshot's template: %q", out)
	}
	if out := e.must(t, 0, "snapshot", "ls"); !strings.Contains(out, "s1\tm1\te2e\t") {
		t.Errorf("snapshot ls: %q", out)
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

// Scale to zero: a service on a template whose machines start with a server listening (made of a
// snapshot) wakes on a request, goes to zero when idle, and wakes again; one that keeps its state
// carries it across zero.
func (e *e2e) scaleToZero(t *testing.T) {
	e.startDaemon(t)
	e.must(t, 0, "template", "add", e.site, "--name", "z")
	defer e.run(t, nil, "template", "rm", "z")
	e.must(t, 0, "up", "z", "--name", "base")
	e.must(t, 0, "sh", "base", `(while true; do printf "HTTP/1.0 200 OK\r\n\r\nawake\n" | nc -l -p 8000; done) >/dev/null 2>&1 &`)
	e.must(t, 0, "snapshot", "save", "base", "--name", "serving")
	defer e.run(t, nil, "snapshot", "rm", "serving")
	e.must(t, 0, "stop", "base")
	e.must(t, 0, "template", "add", "--snapshot", "serving", "--name", "z-serving")
	defer e.run(t, nil, "template", "rm", "z-serving")

	out := e.must(t, 0, "service", "add", "web", "--template", "z-serving", "-p", "0:8000", "--idle", "2s")
	defer e.run(t, nil, "service", "rm", "web")
	port := regexp.MustCompile(`127\.0\.0\.1:(\d+)→8000`).FindStringSubmatch(out)
	if port == nil {
		t.Fatalf("service add: %q", out)
	}
	runningNow := func() string {
		for _, line := range strings.Split(e.must(t, 0, "service", "ls"), "\n") {
			if f := strings.Split(line, "\t"); f[0] == "web" {
				return f[2]
			}
		}
		return "?"
	}
	if n := runningNow(); n != "0" {
		t.Errorf("before any request: %s running", n)
	}
	url := "http://127.0.0.1:" + port[1] + "/"
	if body, took := get(url, "awake"); !strings.Contains(body, "awake") {
		t.Fatalf("woken: %q", body)
	} else {
		t.Logf("from zero to an answer: %s", took)
	}
	if n := runningNow(); n != "1" {
		t.Errorf("after a request: %s running", n)
	}
	for deadline := time.Now().Add(20 * time.Second); runningNow() != "0"; time.Sleep(200 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("not scaled to zero")
		}
	}
	if body, took := get(url, "awake"); !strings.Contains(body, "awake") {
		t.Errorf("woken again: %q", body)
	} else {
		t.Logf("from zero again: %s", took)
	}

	// State kept across zero: sh on the service wakes it
	e.must(t, 0, "service", "add", "kv", "--template", "z", "--state", "keep", "--idle", "2s")
	defer e.run(t, nil, "service", "rm", "kv")
	if out := e.must(t, 0, "sh", "kv", "echo x >> /root/n; wc -l < /root/n"); strings.TrimSpace(out) != "1" {
		t.Errorf("kv: %q", out)
	}
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if strings.Contains(e.must(t, 0, "service", "ls"), "kv\tz\t0\t") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("kv not scaled to zero")
		}
	}
	if out := e.must(t, 0, "sh", "kv", "echo x >> /root/n; wc -l < /root/n"); strings.TrimSpace(out) != "2" {
		t.Errorf("kv after zero: %q", out)
	}
}

// Limits and lifecycle on a real site: a memory budget that has no room refuses a machine and says
// why; a template idle for a while sleeps and wakes on the next machine; a machine's time to live.
func (e *e2e) lifecycle(t *testing.T) {
	t.Run("budget", func(t *testing.T) {
		e.startDaemon(t, "--memory", "1M", "--wait", "1s")
		e.must(t, 0, "template", "add", e.site, "--name", "tight")
		defer e.run(t, nil, "template", "rm", "tight")
		out, code := e.run(t, nil, "up", "tight")
		if code == 0 || !strings.Contains(out, "no room in the memory budget") {
			t.Errorf("up over the budget: %d %q", code, out)
		}
	})
	t.Run("idle template and ttl", func(t *testing.T) {
		e.startDaemon(t)
		e.must(t, 0, "template", "add", e.site, "--name", "sleepy", "--idle", "2s")
		defer e.run(t, nil, "template", "rm", "sleepy")
		for deadline := time.Now().Add(30 * time.Second); !strings.Contains(e.must(t, 0, "template", "ls"), "sleepy\t"+e.site+"\tasleep"); time.Sleep(200 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("not asleep")
			}
		}
		begun := time.Now()
		e.must(t, 0, "up", "sleepy", "--name", "woke")
		t.Logf("up on an asleep template: %s", time.Since(begun))
		if out := e.must(t, 0, "sh", "woke", "echo up"); out != "up\n" {
			t.Errorf("a machine of a woken template: %q", out)
		}
		e.must(t, 0, "stop", "woke")
		e.must(t, 0, "up", "sleepy", "--name", "brief", "--ttl", "2s")
		for deadline := time.Now().Add(30 * time.Second); strings.Contains(e.must(t, 0, "ps"), "brief\t"); time.Sleep(200 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("brief outlived its ttl")
			}
		}
	})
}
