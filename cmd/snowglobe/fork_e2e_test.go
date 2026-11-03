package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Machines forked from one restore (snowglobe-vm --serve, {"mode": "spawn"}): each lasts and
// serves its own control socket (jobs, connections to its ports), keeps what it wrote from one
// job to the next, sees nothing of another machine's, and is held to --max-machines. Driven
// through a bundle, which is snowglobe-vm with the site in it.
func (e *e2e) forkMachines(t *testing.T) {
	b := filepath.Join(t.TempDir(), "site")
	args := []string{"bundle", e.site, "-o", b}
	if vm := os.Getenv("SNOWGLOBE_VM"); vm != "" {
		args = append(args, "--runtime", vm)
	}
	e.must(t, 0, args...)

	// A short directory: Unix socket paths are short
	dir, err := os.MkdirTemp("", "sgf-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	server := exec.Command(b, "--serve", "s.sock", "--jobs-root", "jobs", "--max-machines", "2")
	server.Dir = dir
	log, _ := os.Create(filepath.Join(dir, "log"))
	server.Stdout, server.Stderr = log, log
	// Its own process group: the machines it forks go with it at the end
	server.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		syscall.Kill(-server.Process.Pid, syscall.SIGKILL)
		server.Wait()
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(dir, "log"))
			t.Logf("server log:\n%s", data)
		}
	}()
	for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(100 * time.Millisecond) {
		if data, _ := os.ReadFile(filepath.Join(dir, "log")); strings.Contains(string(data), "serving jobs") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the server did not restore")
		}
	}

	// One JSON line to a socket, one JSON line back
	ask := func(sock string, req map[string]any) map[string]any {
		t.Helper()
		c, err := net.Dial("unix", filepath.Join(dir, sock))
		if err != nil {
			t.Fatalf("%s: %v", sock, err)
		}
		defer c.Close()
		data, _ := json.Marshal(req)
		c.Write(append(data, '\n'))
		c.SetReadDeadline(time.Now().Add(2 * time.Minute))
		line, err := bufio.NewReader(c).ReadBytes('\n')
		if err != nil {
			t.Fatalf("%s %v: %v", sock, req, err)
		}
		var v map[string]any
		if err := json.Unmarshal(line, &v); err != nil {
			t.Fatalf("%s: %q", sock, line)
		}
		return v
	}
	spawn := func(name string) map[string]any {
		return ask("s.sock", map[string]any{"mode": "spawn", "name": name})
	}
	job := func(machine, cmd string) (int, string) {
		t.Helper()
		v := ask(machine+".sock", map[string]any{"mode": "job", "cmd": cmd, "timeout": 60})
		if v["error"] != nil {
			t.Fatalf("job on %s: %v", machine, v["error"])
		}
		out, _ := base64.StdEncoding.DecodeString(v["output"].(string))
		return int(v["status"].(float64)), string(out)
	}

	a, b2 := spawn("a"), spawn("b")
	for _, m := range []map[string]any{a, b2} {
		if m["pid"] == nil || m["error"] != nil {
			t.Fatalf("spawn: %v", m)
		}
	}
	if a["pid"] == b2["pid"] {
		t.Fatal("two machines, one process")
	}

	// A machine keeps what it wrote; another doesn't see it
	if s, out := job("a", "echo kept > /root/f; cat /root/f"); s != 0 || out != "kept\n" {
		t.Fatalf("a: %d %q", s, out)
	}
	if s, out := job("a", "cat /root/f"); s != 0 || out != "kept\n" {
		t.Errorf("a, next job: %d %q", s, out)
	}
	if s, _ := job("b", "test -e /root/f"); s == 0 {
		t.Error("b sees a's file")
	}

	// Refused: a name that is running, a third machine (--max-machines 2), a name that is a path
	if v := spawn("a"); v["error"] == nil || !strings.Contains(fmt.Sprint(v["error"]), "running") {
		t.Errorf("spawn a again: %v", v)
	}
	if v := spawn("c"); v["error"] == nil || !strings.Contains(fmt.Sprint(v["error"]), "--max-machines") {
		t.Errorf("a third machine: %v", v)
	}
	if v := spawn("../x"); v["error"] == nil {
		t.Errorf("spawn ../x: %v", v)
	}

	// A connection to a port of a's: what the daemon's port forwards are made of
	job("a", `(while true; do printf "HTTP/1.0 200 OK\r\n\r\nhello from a\n" | nc -l -p 8000; done) >/dev/null 2>&1 &`)
	var body string
	for i := 0; i < 10 && !strings.Contains(body, "hello from a"); i++ {
		c, err := net.Dial("unix", filepath.Join(dir, "a.sock"))
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte(`{"mode":"connect","port":8000}` + "\n"))
		c.SetReadDeadline(time.Now().Add(20 * time.Second))
		r := bufio.NewReader(c)
		if line, _ := r.ReadString('\n'); !strings.Contains(line, `"connected":8000`) {
			t.Fatalf("connect: %q", line)
		}
		c.Write([]byte("GET / HTTP/1.0\r\n\r\n"))
		data, _ := io.ReadAll(r)
		body = string(data)
		c.Close()
		if !strings.Contains(body, "hello from a") {
			time.Sleep(time.Second)
		}
	}
	if !strings.Contains(body, "hello from a") {
		t.Errorf("connect: got %q", body)
	}

	// A machine stopped: its socket goes, the server serves on, and its place is free again
	syscall.Kill(int(a["pid"].(float64)), syscall.SIGKILL)
	time.Sleep(500 * time.Millisecond)
	if v := spawn("c"); v["error"] != nil {
		t.Errorf("spawn after a stopped: %v", v)
	}
	if s, out := job("c", "test -e /root/f && echo leaked || echo fresh"); s != 0 || out != "fresh\n" {
		t.Errorf("c: %d %q", s, out)
	}
}
