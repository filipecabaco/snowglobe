package main

import (
	"context"
	"encoding/json"
	"fmt"
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

// A fleet file applied on a real site: a template, a snapshot set up by a command (a server) and
// checked ready, a template of it, a service at zero on it, and machines; diff then has nothing to
// do; a change replaces only what changed; down removes it all.
func (e *e2e) fleetApply(t *testing.T) {
	e.startDaemon(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "snowglobe.toml")
	fleetFile := func(count int) string {
		return fmt.Sprintf(`name = "e2e-fleet"

[templates.base]
site = %q

[snapshots.serving]
template = "base"
run = ['(while true; do printf "HTTP/1.0 200 OK\r\n\r\nfrom the fleet\n" | nc -l -p 8000; done) >/dev/null 2>&1 &']
ready = "curl -sf -m 2 http://127.0.0.1:8000/"

[templates.serving]
snapshot = "serving"

[services.web]
template = "serving"
ports = ["0:8000"]
idle = "2s"

[machines.worker]
template = "base"
count = %d
`, e.site, count)
	}
	os.WriteFile(file, []byte(fleetFile(2)), 0o644)
	out := e.must(t, 0, "apply", "-f", file)
	for _, want := range []string{"+ template base", "+ snapshot serving", "+ template serving", "+ service web", "+ machine worker"} {
		if !strings.Contains(out, want) {
			t.Errorf("apply lacks %q: %q", want, out)
		}
	}
	defer e.run(t, nil, "down", "-f", file)
	if out := e.must(t, 0, "diff", "-f", file); !strings.Contains(out, "as the file says (5 entries)") {
		t.Errorf("diff after apply: %q", out)
	}
	if out := e.must(t, 0, "sh", "worker-2", "echo working"); out != "working\n" {
		t.Errorf("worker-2: %q", out)
	}
	port := regexp.MustCompile(`127\.0\.0\.1:(\d+)→8000`).FindStringSubmatch(e.must(t, 0, "service", "ls"))
	if port == nil {
		t.Fatal("no port for web")
	}
	if body, _ := get("http://127.0.0.1:"+port[1]+"/", "from the fleet"); !strings.Contains(body, "from the fleet") {
		t.Errorf("web: %q", body)
	}

	// A count changed: the workers only
	os.WriteFile(file, []byte(fleetFile(3)), 0o644)
	if out := e.must(t, 0, "diff", "-f", file); !strings.Contains(out, "~ machine worker (changed)") || strings.Contains(out, "service") {
		t.Errorf("diff after a change: %q", out)
	}
	e.must(t, 0, "apply", "-f", file)
	if out := e.must(t, 0, "ps"); !strings.Contains(out, "worker-3\t") {
		t.Errorf("ps: %q", out)
	}

	// Something outside the fleet stays when it goes
	e.must(t, 0, "template", "add", e.site, "--name", "outsider")
	defer e.run(t, nil, "template", "rm", "outsider")
	e.must(t, 0, "down", "-f", file)
	ls := e.must(t, 0, "template", "ls")
	if strings.Contains(ls, "base\t") || strings.Contains(ls, "serving\t") || !strings.Contains(ls, "outsider\t") {
		t.Errorf("templates after down: %q", ls)
	}
	if out := e.must(t, 0, "ps"); strings.Contains(out, "worker") || strings.Contains(out, "web\t") {
		t.Errorf("ps after down: %q", out)
	}
}

// Links between real machines, each confined as a daemon confines them (no Unix socket reached
// from a machine): to a machine of a snapshot, and to a service at zero, which the connection
// wakes. A machine asks its daemon for each link connection on its link channel; connecting to
// the link's socket itself, as machines once did, its sandbox refuses.
func (e *e2e) links(t *testing.T) {
	e.startDaemon(t)
	file := filepath.Join(t.TempDir(), "snowglobe.toml")
	os.WriteFile(file, []byte(fmt.Sprintf(`name = "e2e-links"

[templates.base]
site = %q

[snapshots.echo]
template = "base"
# A server that always listens (-lk): each connection gets a line and ends
run = [
  'printf "#!/bin/sh\\necho from the link\\n" > /root/say && chmod +x /root/say',
  '(nc -lk -p 7000 -e /root/say) >/dev/null 2>&1 &',
]
ready = "nc -z 127.0.0.1 7000"

[templates.echo]
snapshot = "echo"

[machines.db]
template = "echo"

[services.wake]
template = "echo"
min = 0
max = 1
idle = "5m"

[machines.app]
template = "base"

[links.app-db]
from = "app"
to = "db"
port = 7000
as = "db.internal"

[links.app-wake]
from = "app"
to = "wake"
port = 7000
as = "wake.internal"
`, e.site)), 0o644)
	e.must(t, 0, "apply", "-f", file)
	defer e.run(t, nil, "down", "-f", file)

	through := func(host string) string {
		var out string
		for i := 0; i < 10; i++ {
			out, _ = e.run(t, nil, "sh", "app", "nc -w 10 "+host+" 7000 </dev/null")
			if strings.HasPrefix(out, "from ") {
				break
			}
			time.Sleep(time.Second)
		}
		return out
	}
	if out := through("db.internal"); !strings.HasPrefix(out, "from ") {
		t.Errorf("app to db over the link: %q", out)
	}
	// Many connections, one after another: every one handed over whole (the daemon keeps its copy
	// until the machine has it, or the kernel may flush it on the way)
	if out := e.must(t, 0, "sh", "app", "for i in $(seq 20); do nc -w 10 db.internal 7000 </dev/null; done | grep -c '^from '"); strings.TrimSpace(out) != "20" {
		t.Errorf("20 connections over the link, whole: %q", out)
	}
	if out := through("wake.internal"); !strings.HasPrefix(out, "from ") {
		t.Errorf("app to the service at zero over the link: %q", out)
	}
	if out := e.must(t, 0, "ps"); !strings.Contains(out, "wake-") {
		t.Errorf("the link's connection woke no replica of wake: %q", out)
	}
}

// Randomness across machines of one snapshot, on real machines: the guest kernel is reseeded at each
// restore, before anything draws (a start command's first read differs, in machines of a fleet's
// snapshot and of the site's own), a process the snapshot kept running is copied with its random state (ash keeps $RANDOM's
// in its memory, as Node keeps crypto's), apply says so, and one started by the template's start
// draws its own.
func (e *e2e) randomness(t *testing.T) {
	e.startDaemon(t)
	file := filepath.Join(t.TempDir(), "snowglobe.toml")
	os.WriteFile(file, []byte(fmt.Sprintf(`name = "e2e-random"

[templates.base]
site = %q

[snapshots.kept]
template = "base"
# A draw each time the file \$1 appears (no fifo: a site with no kernel has none)
run = [
  'printf "while true; do if [ -e \$1 ]; then rm -f \$1; echo \$RANDOM-\$RANDOM-\$RANDOM > \$2; fi; sleep 0.1; done\n" > /root/draw',
  '(sh /root/draw /tmp/go /tmp/out >/dev/null 2>&1 &)',
  ': > /tmp/go; sleep 1; cat /tmp/out',
]

[templates.kept]
snapshot = "kept"
# The first thing each machine does, right after its restore: draw from the kernel
start = [
  'head -c 16 /dev/urandom | od -An -tx1 > /tmp/first',
  '(sh /root/draw /tmp/go2 /tmp/out2 >/dev/null 2>&1 &)',
]

[templates.fresh]
site = %q
start = ['head -c 16 /dev/urandom | od -An -tx1 > /tmp/first']

[machines.r]
template = "kept"
count = 2

[machines.f]
template = "fresh"
count = 2
`, e.site, e.site)), 0o644)
	out := e.must(t, 0, "apply", "-f", file)
	defer e.run(t, nil, "down", "-f", file)
	// (A child of it that runs as the list is taken, its sleep, may be named too)
	if !strings.Contains(out, "! kept keeps ") || !strings.Contains(out, "sh /root/draw /tmp/go /tmp/out") || !strings.Contains(out, "start") {
		t.Errorf("apply says nothing of the process the snapshot keeps: %q", out)
	}

	draw := func(m, cmd string) string {
		return strings.TrimSpace(e.must(t, 0, "sh", m, cmd))
	}
	// The first draw each machine made, in its start, right after its restore: of a fleet's
	// snapshot, and of the site's own
	for _, pair := range [][2]string{{"r-1", "r-2"}, {"f-1", "f-2"}} {
		if a, b := draw(pair[0], "cat /tmp/first"), draw(pair[1], "cat /tmp/first"); a == b || a == "" {
			t.Errorf("%s and %s drew the same first bytes: %q", pair[0], pair[1], a)
		}
	}
	// touch makes a file that isn't there (user mode said yes to utimensat for any path, so busybox's
	// touch made nothing, before armless 0.25.1)
	if out := draw("f-1", "touch /tmp/made && ls /tmp/made"); out != "/tmp/made" {
		t.Errorf("touch made no file: %q", out)
	}
	// The kernel's: each its own
	if a, b := draw("r-1", "head -c 16 /dev/urandom | od -An -tx1"), draw("r-2", "head -c 16 /dev/urandom | od -An -tx1"); a == b || a == "" {
		t.Errorf("/dev/urandom is the same in both machines: %q", a)
	}
	// The kept process's: the same in both (what the warning is about)
	kept := ": > /tmp/go; sleep 1; cat /tmp/out"
	if a, b := draw("r-1", kept), draw("r-2", kept); a != b || a == "" {
		t.Errorf("the kept process drew %q and %q: if it now differs, the warning and the docs say too much", a, b)
	}
	// Started by start: each its own
	fresh := ": > /tmp/go2; sleep 1; cat /tmp/out2"
	if a, b := draw("r-1", fresh), draw("r-2", fresh); a == b || a == "" {
		t.Errorf("processes started by start drew the same: %q", a)
	}
}

// A template's restart_app on real machines: the site's app (the curl site's shell, which its
// snapshot holds running) is every machine's same process, unless each machine starts it again
// before it is used, which the daemon logs. With a kernel the app's pid tells them apart: the
// snapshot's in every copy, a new one in each restarted machine. (Its $RANDOM can't: ash seeds it
// on first use, after the restore.) The restarted app answers at its console.
func (e *e2e) restartApp(t *testing.T) {
	e.startDaemon(t)
	file := filepath.Join(t.TempDir(), "snowglobe.toml")
	os.WriteFile(file, []byte(fmt.Sprintf(`name = "e2e-restart"

[templates.kept]
site = %q

[templates.fresh]
site = %q
restart_app = true

[machines.k]
template = "kept"
count = 2

[machines.f]
template = "fresh"
count = 2
`, e.site, e.site)), 0o644)
	e.must(t, 0, "apply", "-f", file)
	defer e.run(t, nil, "down", "-f", file)

	log, _ := os.ReadFile(filepath.Join(os.Getenv("SNOWGLOBE_DAEMON_DIR"), "daemon.log"))
	for _, m := range []string{"f-1", "f-2"} {
		if !strings.Contains(string(log), "machine "+m+": started its site's app again") {
			t.Errorf("%s didn't start its app again:\n%s", m, log)
		}
	}
	if strings.Contains(string(log), "machine k-1: started its site's app again") {
		t.Error("a machine of a template without restart_app started its app again")
	}

	var info struct {
		Kernel string `json:"kernel"`
	}
	data, _ := os.ReadFile(filepath.Join(e.site, "run.json"))
	json.Unmarshal(data, &info)
	pid := func(m string) string {
		out := e.must(t, 0, "exec", m, "echo P$$")
		for _, w := range strings.Fields(out) {
			if strings.HasPrefix(w, "P") && len(w) > 1 && w != "P$$" {
				return w
			}
		}
		t.Fatalf("%s's app said no pid: %q", m, out)
		return ""
	}
	if info.Kernel != "none" {
		k1, k2, f1 := pid("k-1"), pid("k-2"), pid("f-1")
		if k1 != k2 {
			t.Errorf("the snapshot's app has pids %s and %s in two copies", k1, k2)
		}
		if f1 == k1 {
			t.Errorf("the restarted app is still the snapshot's (%s)", f1)
		}
	}
	if out := e.must(t, 0, "exec", "f-1", "echo still-$((6*7))"); !strings.Contains(out, "still-42") {
		t.Errorf("the restarted app doesn't answer: %q", out)
	}
}
