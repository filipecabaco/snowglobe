package main

// End to end: the snowglobe command, built here, driving a real built site the way a program
// driving a sandbox does. Natively and in Docker: jobs (sh, cp, mcp), kills of everything a job
// started, timeouts, --max-runtime, --stop-file, snowglobe stop, the durable logs, and bundles.
//
//	SNOWGLOBE_E2E_SITE=dist/curl go test ./cmd/snowglobe -run TestE2E -v -timeout 20m
//
// The site must have a shell (curl's has). SNOWGLOBE_E2E_DOCKER=0 skips the Docker runs (they
// need the tools image); SNOWGLOBE_VM names a snowglobe-vm for the native runs and bundles where
// there is no release for this system (macOS from source, say).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type e2e struct {
	bin, site string
}

func setupE2E(t *testing.T) *e2e {
	site := os.Getenv("SNOWGLOBE_E2E_SITE")
	if site == "" {
		t.Skip("set SNOWGLOBE_E2E_SITE to a built site to run the end-to-end tests")
	}
	// Relative to the repository, not to this package (where go test runs)
	if !filepath.IsAbs(site) {
		site = filepath.Join("..", "..", site)
	}
	site, err := filepath.Abs(site)
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "snowglobe")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return &e2e{bin: bin, site: site}
}

// run runs snowglobe; its output (stdout and stderr) and exit status.
func (e *e2e) run(t *testing.T, stdin io.Reader, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(e.bin, args...)
	cmd.Stdin = stdin
	out, err := cmd.CombinedOutput()
	code := 0
	if x, ok := err.(*exec.ExitError); ok {
		code = x.ExitCode()
	} else if err != nil {
		t.Fatalf("snowglobe %v: %v", args, err)
	}
	return string(out), code
}

// must runs snowglobe and fails unless it exits with want.
func (e *e2e) must(t *testing.T, want int, args ...string) string {
	t.Helper()
	out, code := e.run(t, nil, args...)
	if code != want {
		t.Fatalf("snowglobe %s: exit %d, want %d\n%s", strings.Join(args, " "), code, want, out)
	}
	return out
}

func events(t *testing.T, dir string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "events.jsonl"))
	if err != nil {
		return nil
	}
	var all []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("events.jsonl: %q: %v", line, err)
		}
		all = append(all, ev)
	}
	return all
}

// event is the last event of this kind whose fields include match.
func event(t *testing.T, dir, kind string, match map[string]any) map[string]any {
	t.Helper()
	evs := events(t, dir)
	for i := len(evs) - 1; i >= 0; i-- {
		ev := evs[i]
		if ev["event"] != kind {
			continue
		}
		ok := true
		for k, v := range match {
			if fmt.Sprint(ev[k]) != fmt.Sprint(v) {
				ok = false
			}
		}
		if ok {
			return ev
		}
	}
	return nil
}

func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(d); !cond(); time.Sleep(200 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not within %s", what, d)
		}
	}
}

// The command a job leaves behind if nothing kills it: in the background, ignoring TERM, in a
// shell of its own, and in the foreground. Each is `sleep <n>`.
func stubborn(n int) string {
	return fmt.Sprintf(`sleep %d & (trap "" TERM; sleep %d) & sh -c "sleep %d; true"; sleep %d`, n, n+1, n+2, n+3)
}

// countSleeping is a command printing how many guest processes are `sleep <n>` for n in n..n+3.
func countSleeping(n int) string {
	return fmt.Sprintf(`for p in /proc/[0-9]*; do tr "\000" " " < $p/cmdline 2>/dev/null; echo; done | grep -cE "^sleep (%d|%d|%d|%d) $" || true`, n, n+1, n+2, n+3)
}

func TestE2E(t *testing.T) {
	e := setupE2E(t)
	t.Run("native instance", e.nativeInstance)
	t.Run("native stop file", e.nativeStopFile)
	t.Run("native long cache path", e.nativeLongCachePath)
	t.Run("native max runtime", e.nativeMaxRuntime)
	t.Run("mcp", e.mcp)
	t.Run("bundle", e.bundle)
	if os.Getenv("SNOWGLOBE_E2E_BUILD") == "1" {
		t.Run("build stall", e.buildStall)
	}
	if os.Getenv("SNOWGLOBE_E2E_DOCKER") != "0" {
		t.Run("docker max runtime", e.dockerMaxRuntime)
		t.Run("docker stop file", e.dockerStopFile)
	}
}

func (e *e2e) nativeInstance(t *testing.T) {
	name := fmt.Sprintf("e2e-%d", os.Getpid())
	logs := t.TempDir()
	e.must(t, 0, "run", e.site, "--runtime", "native", "--name", name, "--detach", "--log-dir", logs)
	stopped := false
	defer func() {
		if !stopped {
			e.run(t, nil, "stop", name)
		}
	}()

	// A job's output and exit status
	if out := e.must(t, 3, "sh", name, "echo hello; exit 3"); out != "hello\n" {
		t.Errorf("sh: %q", out)
	}
	var res struct {
		Exit   int    `json:"exit"`
		Output string `json:"output"`
	}
	if err := json.Unmarshal([]byte(e.must(t, 0, "sh", name, "--json", "echo json")), &res); err != nil || res.Output != "json\n" {
		t.Errorf("sh --json: %+v %v", res, err)
	}

	// What a job leaves running when it ends is its own business (a server, say); the check
	// below sees it, so it would see what a kill left
	if out := strings.TrimSpace(e.must(t, 0, "sh", name, "sleep 4170 & sleep 1; "+countSleeping(4167))); out != "1" {
		t.Fatalf("the check doesn't see a process that is running: %q", out)
	}

	// Out of time: everything it started is killed, and the shell is free for the next job
	begun := time.Now()
	e.must(t, 124, "sh", name, "--timeout", "3", stubborn(4171))
	if took := time.Since(begun); took > 25*time.Second {
		t.Errorf("a 3 s job took %s to kill", took)
	}
	if out := strings.TrimSpace(e.must(t, 0, "sh", name, countSleeping(4171))); out != "0" {
		t.Errorf("%s of the timed-out job's processes are still running", out)
	}
	if out := e.must(t, 0, "sh", name, "echo after"); out != "after\n" {
		t.Errorf("the next job: %q", out)
	}

	// cp, both ways, a file and a directory
	local := t.TempDir()
	os.WriteFile(filepath.Join(local, "f"), []byte("payload\n"), 0o644)
	os.MkdirAll(filepath.Join(local, "d", "sub"), 0o755)
	os.WriteFile(filepath.Join(local, "d", "sub", "g"), []byte("deep\n"), 0o644)
	e.must(t, 0, "cp", filepath.Join(local, "f"), name+":/tmp/e2e/f")
	e.must(t, 0, "cp", filepath.Join(local, "d"), name+":/tmp/e2e/d")
	back := t.TempDir()
	e.must(t, 0, "cp", name+":/tmp/e2e/f", filepath.Join(back, "f"))
	e.must(t, 0, "cp", name+":/tmp/e2e/d", filepath.Join(back, "d"))
	for rel, want := range map[string]string{"f": "payload\n", "d/sub/g": "deep\n"} {
		if got, _ := os.ReadFile(filepath.Join(back, rel)); string(got) != want {
			t.Errorf("cp round trip %s: %q", rel, got)
		}
	}

	// The app's terminal, logged
	if out := e.must(t, 0, "exec", name, "echo console-$((6 * 7))"); !strings.Contains(out, "console-42") {
		t.Errorf("exec: %q", out)
	}

	// Stopped while a job runs: the job is killed, the instance logs why it stopped
	type answer struct {
		out  string
		code int
	}
	answered := make(chan answer, 1)
	go func() {
		out, code := e.run(t, nil, "sh", name, stubborn(4181))
		answered <- answer{out, code}
	}()
	waitFor(t, 60*time.Second, "the job to start", func() bool {
		return event(t, logs, "job_start", map[string]any{"cmd": stubborn(4181)}) != nil
	})
	time.Sleep(time.Second)
	begun = time.Now()
	e.must(t, 0, "stop", name)
	stopped = true
	if took := time.Since(begun); took > 25*time.Second {
		t.Errorf("stop took %s", took)
	}
	if a := <-answered; a.code == 0 {
		t.Errorf("the stopped job succeeded: %q", a.out)
	}
	if strings.Contains(e.must(t, 0, "ps"), name) {
		t.Error("still listed after stop")
	}

	// The logs say all of it
	for _, want := range []struct {
		kind  string
		match map[string]any
	}{
		{"start", nil},
		{"restored", nil},
		{"job_start", map[string]any{"cmd": "echo hello; exit 3"}},
		{"job_end", map[string]any{"status": 3, "output": "hello\n"}},
		{"job_end", map[string]any{"timed_out": true, "killed": true}},
		{"job_end", map[string]any{"cancelled": true, "killed": true}},
		{"stop", map[string]any{"reason": "stop-file", "exit": 143}},
	} {
		if event(t, logs, want.kind, want.match) == nil {
			t.Errorf("no %s event with %v in:\n%v", want.kind, want.match, events(t, logs))
		}
	}
	if ev := event(t, logs, "job_start", map[string]any{"cmd": "echo hello; exit 3"}); ev != nil && ev["env"] == nil {
		t.Error("job_start without env names")
	}
	if data, _ := os.ReadFile(filepath.Join(logs, "console.log")); !bytes.Contains(data, []byte("console-42")) {
		t.Errorf("console.log lacks the exec: %q", data)
	}
	if data, _ := os.ReadFile(filepath.Join(logs, "serial.log")); !bytes.Contains(data, []byte("SGDONE_")) {
		t.Error("serial.log lacks the jobs")
	}
}

// A cache path too long for a Unix socket (a long home, user or instance name): the instance keeps
// its socket somewhere shorter and works as any other
func (e *e2e) nativeLongCachePath(t *testing.T) {
	home := filepath.Join(t.TempDir(), strings.Repeat("a-rather-long-directory-name/", 4))
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	name := fmt.Sprintf("e2e-a-long-instance-name-%d", os.Getpid())
	e.must(t, 0, "run", e.site, "--runtime", "native", "--name", name, "--detach")
	defer e.run(t, nil, "stop", name)
	if out := e.must(t, 0, "sh", name, "echo long-ok"); out != "long-ok\n" {
		t.Errorf("sh: %q", out)
	}
	e.must(t, 0, "stop", name)
}

func (e *e2e) nativeStopFile(t *testing.T) {
	name := fmt.Sprintf("e2e-stop-%d", os.Getpid())
	logs, signals := t.TempDir(), t.TempDir()
	stop := filepath.Join(signals, "stop")
	e.must(t, 0, "run", e.site, "--runtime", "native", "--name", name, "--detach", "--log-dir", logs, "--stop-file", stop)
	defer e.run(t, nil, "stop", name)
	e.must(t, 0, "sh", name, "true")
	os.WriteFile(stop, nil, 0o644)
	waitFor(t, 30*time.Second, "the instance to stop", func() bool {
		return !strings.Contains(e.must(t, 0, "ps"), name)
	})
	if event(t, logs, "stop", map[string]any{"reason": "stop-file", "exit": 143}) == nil {
		t.Errorf("no stop event: %v", events(t, logs))
	}
}

// A run whose stdin stays open: it would wait for commands for ever
func (e *e2e) heldOpen(t *testing.T, args ...string) (int, time.Duration) {
	t.Helper()
	r, w := openPipe(t)
	defer w.Close()
	begun := time.Now()
	out, code := e.run(t, r, args...)
	t.Logf("%s", out)
	return code, time.Since(begun)
}

// openPipe is a pipe whose read end the run gets as its stdin itself (an io.Pipe would be copied
// by a goroutine that Wait waits for: for ever, while the write end is open)
func openPipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r, w
}

func (e *e2e) nativeMaxRuntime(t *testing.T) {
	logs := t.TempDir()
	code, took := e.heldOpen(t, "run", e.site, "--runtime", "native", "--max-runtime", "10", "--log-dir", logs)
	if code != 124 {
		t.Errorf("exit %d, want 124", code)
	}
	if took < 10*time.Second || took > 60*time.Second {
		t.Errorf("a 10 s run took %s", took)
	}
	if event(t, logs, "stop", map[string]any{"reason": "max-runtime", "exit": 124}) == nil {
		t.Errorf("no stop event: %v", events(t, logs))
	}
}

func (e *e2e) dockerMaxRuntime(t *testing.T) {
	logs := t.TempDir()
	code, took := e.heldOpen(t, "run", e.site, "--runtime", "docker", "--max-runtime", "10", "--log-dir", logs)
	if code != 124 {
		t.Errorf("exit %d, want 124", code)
	}
	if took < 10*time.Second || took > 90*time.Second {
		t.Errorf("a 10 s run took %s", took)
	}
	if event(t, logs, "stop", map[string]any{"reason": "max-runtime", "exit": 124}) == nil {
		t.Errorf("no stop event: %v", events(t, logs))
	}
	if _, err := os.Stat(filepath.Join(logs, "console.log")); err != nil {
		t.Error("no console.log")
	}
}

func (e *e2e) dockerStopFile(t *testing.T) {
	logs, signals := t.TempDir(), t.TempDir()
	stop := filepath.Join(signals, "stop")
	r, w := openPipe(t)
	defer w.Close()
	done := make(chan int, 1)
	go func() {
		_, code := e.run(t, r, "run", e.site, "--runtime", "docker", "--stop-file", stop, "--log-dir", logs)
		done <- code
	}()
	waitFor(t, 120*time.Second, "the run to restore", func() bool { return event(t, logs, "restored", nil) != nil })
	os.WriteFile(stop, nil, 0o644)
	select {
	case code := <-done:
		if code != 143 {
			t.Errorf("exit %d, want 143", code)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the stop file didn't stop it")
	}
	if event(t, logs, "stop", map[string]any{"reason": "stop-file", "exit": 143}) == nil {
		t.Errorf("no stop event: %v", events(t, logs))
	}
}

// An agent's session: a command out of time is killed, and the next one runs
func (e *e2e) mcp(t *testing.T) {
	cmd := exec.Command(e.bin, "mcp", e.site, "--name", fmt.Sprintf("e2e-mcp-%d", os.Getpid()))
	in, _ := cmd.StdinPipe()
	outPipe, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	out := bufio.NewReader(outPipe)
	id := 0
	call := func(method string, params any) map[string]any {
		t.Helper()
		id++
		req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		in.Write(append(req, '\n'))
		line, err := out.ReadBytes('\n')
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		var reply map[string]any
		json.Unmarshal(line, &reply)
		return reply
	}
	text := func(reply map[string]any) string {
		res, _ := reply["result"].(map[string]any)
		content, _ := res["content"].([]any)
		if len(content) == 0 {
			return fmt.Sprint(reply)
		}
		return fmt.Sprint(content[0].(map[string]any)["text"])
	}
	call("initialize", map[string]any{"protocolVersion": "2025-06-18"})
	got := text(call("tools/call", map[string]any{"name": "run_command",
		"arguments": map[string]any{"command": stubborn(4191), "timeout_seconds": 3}}))
	if !strings.Contains(got, "timed out; everything it started was killed") {
		t.Errorf("run_command out of time: %q", got)
	}
	got = text(call("tools/call", map[string]any{"name": "run_command", "arguments": map[string]any{"command": countSleeping(4191)}}))
	if !strings.HasPrefix(got, "0\n[exit 0]") {
		t.Errorf("left running after the timeout: %q", got)
	}
	in.Close()
	if err := cmd.Wait(); err != nil {
		t.Errorf("mcp: %v", err)
	}
}

// A bundle as a job runner runs it (Exclave's way): one job, its workspace in and out/ back
func (e *e2e) bundle(t *testing.T) {
	b := filepath.Join(t.TempDir(), "site")
	args := []string{"bundle", e.site, "-o", b}
	if vm := os.Getenv("SNOWGLOBE_VM"); vm != "" {
		args = append(args, "--runtime", vm)
	}
	e.must(t, 0, args...)
	job := func(cmd string, extra ...string) (string, int, string, string) {
		ws, logs := t.TempDir(), t.TempDir()
		c := exec.Command(b, append([]string{"--workspace", ws, "--cmd", cmd, "--log-dir", logs}, extra...)...)
		out, err := c.CombinedOutput()
		code := 0
		if x, ok := err.(*exec.ExitError); ok {
			code = x.ExitCode()
		}
		return string(out), code, ws, logs
	}
	out, code, ws, _ := job("echo done > out/r; echo printed")
	if code != 0 || !strings.Contains(out, "printed") {
		t.Errorf("job: exit %d: %q", code, out)
	}
	if got, _ := os.ReadFile(filepath.Join(ws, "out", "r")); string(got) != "done\n" {
		t.Errorf("out/r: %q", got)
	}
	_, code, _, logs := job(stubborn(4201), "--timeout", "3")
	if code != 124 {
		t.Errorf("out of time: exit %d", code)
	}
	if event(t, logs, "job_end", map[string]any{"timed_out": true, "killed": true}) == nil {
		t.Errorf("the job wasn't killed: %v", events(t, logs))
	}
	// The run's own limit, below the job's
	begun := time.Now()
	_, code, _, logs = job("sleep 600", "--timeout", "600", "--max-runtime", "8")
	if code != 124 || time.Since(begun) > 60*time.Second {
		t.Errorf("max runtime: exit %d after %s", code, time.Since(begun))
	}
	if event(t, logs, "job_end", map[string]any{"cancelled": true, "killed": true}) == nil ||
		event(t, logs, "stop", map[string]any{"reason": "max-runtime"}) == nil {
		t.Errorf("events: %v", events(t, logs))
	}
}

// A build whose app never gets ready and whose guest goes idle: the boot is found stalled (with
// every CPU's state printed), booted once more, and the build fails saying so, in about a minute
// rather than the 20 a boot may take. Builds examples/curl (SNOWGLOBE_BUILDER picks the builder).
func (e *e2e) buildStall(t *testing.T) {
	t.Setenv("SNOWGLOBE_BOOT_STALL_SECS", "20")
	begun := time.Now()
	out, code := e.run(t, nil, "build", filepath.Join("..", "..", "examples", "curl"),
		"--ready", "TEXT-THE-APP-NEVER-PRINTS", "--out", filepath.Join(t.TempDir(), "site"))
	if code == 0 {
		t.Fatalf("a build that never got ready succeeded:\n%s", out)
	}
	if n := strings.Count(out, "the boot stalled: nothing printed"); n != 2 {
		t.Errorf("stalled %d times, want 2 (once, then the retry)", n)
	}
	for _, want := range []string{"booting again", "the boot stalled twice", "cpu0: pc=0x"} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in the build's output", want)
		}
	}
	if took := time.Since(begun); took > 10*time.Minute {
		t.Errorf("took %s", took)
	}
	if t.Failed() {
		t.Logf("%s", out)
	}
}
