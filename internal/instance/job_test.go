package instance

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// jobRequest is what a job asks the instance's control socket for.
type jobRequest struct {
	Mode    string            `json:"mode"`
	Cmd     string            `json:"cmd"`
	Env     map[string]string `json:"env"`
	Timeout float64           `json:"timeout"`
	Files   map[string][]byte `json:"files"`
}

// fakeJobInstance is a running native instance called name whose control socket answers each job
// with answer's reply (a JobResult, or anything else to send as is; nil hangs up). It records the
// requests. The instance's pid is this process's, so it counts as running: never Stop it.
func fakeJobInstance(t *testing.T, name string, answer func(jobRequest) any) *[]jobRequest {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	dir, err := instancesDir()
	if err != nil {
		t.Fatal(err)
	}
	dir = filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A short path: a Unix socket's has to fit sun_path
	short, err := os.MkdirTemp("", "sgt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(short) })
	sock := filepath.Join(short, "sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	var mu sync.Mutex
	var reqs []jobRequest
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadBytes('\n')
			var req jobRequest
			json.Unmarshal(line, &req)
			mu.Lock()
			reqs = append(reqs, req)
			mu.Unlock()
			switch reply := answer(req); reply := reply.(type) {
			case nil:
			case string:
				io.WriteString(c, reply)
			default:
				data, _ := json.Marshal(reply)
				c.Write(append(data, '\n'))
			}
			c.Close()
		}
	}()
	if err := writeState(dir, nativeState{Pid: os.Getpid(), Site: "/sites/demo", VM: "/bin/false", Socket: sock}); err != nil {
		t.Fatal(err)
	}
	return &reqs
}

func status(n int) *int { return &n }

// captureStdout is what fn printed on stdout.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = old }()
	done := make(chan []byte)
	go func() { data, _ := io.ReadAll(r); done <- data }()
	fn()
	w.Close()
	return string(<-done)
}

func TestJobSendsTheJobAndReadsItsResult(t *testing.T) {
	reqs := fakeJobInstance(t, "web", func(req jobRequest) any {
		return JobResult{Status: status(0), Output: []byte("hi\n"), Out: map[string][]byte{"f": []byte("x")}, Ms: 7}
	})
	res, err := Job("web", JobRequest{Cmd: "echo hi", Env: map[string]string{"A": "1"}, Files: map[string][]byte{"in": []byte("data")}})
	if err != nil {
		t.Fatal(err)
	}
	if *res.Status != 0 || string(res.Output) != "hi\n" || string(res.Out["f"]) != "x" || res.Ms != 7 {
		t.Errorf("got %+v", res)
	}
	got := (*reqs)[0]
	// Out of time after 300 s unless it says otherwise
	if got.Mode != "job" || got.Cmd != "echo hi" || got.Env["A"] != "1" || string(got.Files["in"]) != "data" || got.Timeout != 300 {
		t.Errorf("sent %+v", got)
	}
}

func TestJobFails(t *testing.T) {
	for _, tc := range []struct {
		name   string
		answer any
		want   string
	}{
		{"not JSON", "nonsense\n", "web:"},
		{"the instance refused it", JobResult{Error: "a job is running already"}, "a job is running already"},
	} {
		fakeJobInstance(t, "web", func(jobRequest) any { return tc.answer })
		if _, err := Job("web", JobRequest{Cmd: "true", Timeout: 5}); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestJobNeedsANativeInstance(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir()) // no docker
	if _, err := Job("nope", JobRequest{Cmd: "true"}); err == nil || !strings.Contains(err.Error(), "no instance called nope") {
		t.Errorf("no instance: %v", err)
	}
	fakeDocker(t, `echo boxed`)
	if _, err := Job("boxed", JobRequest{Cmd: "true"}); err == nil || !strings.Contains(err.Error(), "runs in a container") {
		t.Errorf("a container: %v", err)
	}
}

func TestShellEndsWithTheCommandsExitStatus(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result JobResult
		code   int
	}{
		{"success", JobResult{Status: status(0), Output: []byte("out\n")}, 0},
		{"failure", JobResult{Status: status(3), Output: []byte("out\n")}, 3},
		{"out of time", JobResult{Output: []byte("out\n"), TimedOut: true, Killed: true}, ExitMaxRuntime},
		{"stopped", JobResult{Output: []byte("out\n"), Cancelled: true}, ExitStopped},
	} {
		fakeJobInstance(t, "web", func(jobRequest) any { return tc.result })
		var err error
		out := captureStdout(t, func() { err = Shell("web", "cmd", false, 10) })
		var exit ExitError
		if code := 0; errors.As(err, &exit) {
			code = exit.Code
			if code != tc.code {
				t.Errorf("%s: exit %d, want %d", tc.name, code, tc.code)
			}
		} else if err != nil || tc.code != 0 {
			t.Errorf("%s: got %v, want exit %d", tc.name, err, tc.code)
		}
		if out != "out\n" {
			t.Errorf("%s: printed %q", tc.name, out)
		}
	}
}

func TestShellAsJSON(t *testing.T) {
	fakeJobInstance(t, "web", func(jobRequest) any { return JobResult{Output: []byte("partial"), TimedOut: true, Killed: true} })
	var err error
	out := captureStdout(t, func() { err = Shell("web", "sleep 99", true, 1) })
	if (err != ExitError{Code: ExitMaxRuntime}) {
		t.Errorf("got %v", err)
	}
	var got map[string]any
	if json.Unmarshal([]byte(out), &got) != nil || got["exit"] != float64(ExitMaxRuntime) || got["output"] != "partial" ||
		got["timed_out"] != true || got["killed"] != true {
		t.Errorf("printed %q", out)
	}
}

func TestCopyAFileIn(t *testing.T) {
	reqs := fakeJobInstance(t, "web", func(jobRequest) any { return JobResult{Status: status(0)} })
	local := filepath.Join(t.TempDir(), "it's.txt")
	os.WriteFile(local, []byte("data"), 0o640)
	if err := Copy(local, "web:/root/dir"); err != nil {
		t.Fatal(err)
	}
	req := (*reqs)[0]
	if string(req.Files["payload"]) != "data" {
		t.Errorf("sent %q", req.Files)
	}
	// Into the directory under its own name (quoted), with its mode
	for _, want := range []string{`d='/root/dir'`, `d="$d"/'it'\''s.txt'`, "chmod 640"} {
		if !strings.Contains(req.Cmd, want) {
			t.Errorf("%q isn't in %s", want, req.Cmd)
		}
	}
}

func TestCopyADirectoryIn(t *testing.T) {
	reqs := fakeJobInstance(t, "web", func(jobRequest) any { return JobResult{Status: status(0)} })
	local := t.TempDir()
	os.MkdirAll(filepath.Join(local, "sub"), 0o755)
	os.WriteFile(filepath.Join(local, "sub", "a.txt"), []byte("A"), 0o644)
	os.Symlink("sub/a.txt", filepath.Join(local, "link"))
	if err := Copy(local, "web:/srv/app"); err != nil {
		t.Fatal(err)
	}
	req := (*reqs)[0]
	if req.Cmd != `mkdir -p '/srv/app' && tar -xf payload.tar -C '/srv/app'` {
		t.Errorf("cmd %s", req.Cmd)
	}
	// The tar has the tree, its symlink as one
	out := t.TempDir()
	if err := untar(bytes.NewReader(req.Files["payload.tar"]), out); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(out, "sub", "a.txt")); string(got) != "A" {
		t.Errorf("got %q", got)
	}
	if link, err := os.Readlink(filepath.Join(out, "link")); err != nil || link != "sub/a.txt" {
		t.Errorf("link %q, %v", link, err)
	}
}

func TestCopyAFileOut(t *testing.T) {
	reqs := fakeJobInstance(t, "web", func(jobRequest) any {
		return JobResult{Status: status(0), Out: map[string][]byte{"file": []byte("guest data")}}
	})
	local := filepath.Join(t.TempDir(), "copy.txt")
	if err := Copy("web:/etc/motd", local); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(local); string(got) != "guest data" {
		t.Errorf("got %q", got)
	}
	if cmd := (*reqs)[0].Cmd; !strings.Contains(cmd, "cp '/etc/motd' out/file") {
		t.Errorf("cmd %s", cmd)
	}
	// Into a directory, under the guest file's name
	dir := t.TempDir()
	if err := Copy("web:/etc/motd", dir); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "motd")); string(got) != "guest data" {
		t.Errorf("into a directory: %q", got)
	}
}

func TestCopyADirectoryOut(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	tw.WriteHeader(&tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o755})
	tw.WriteHeader(&tar.Header{Name: "./logs/", Typeflag: tar.TypeDir, Mode: 0o755})
	tw.WriteHeader(&tar.Header{Name: "./logs/app.log", Typeflag: tar.TypeReg, Size: 3, Mode: 0o600})
	tw.Write([]byte("log"))
	tw.Close()
	fakeJobInstance(t, "web", func(jobRequest) any {
		return JobResult{Status: status(0), Out: map[string][]byte{"dir.tar": buf.Bytes()}}
	})
	local := filepath.Join(t.TempDir(), "var")
	if err := Copy("web:/var", local); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(local, "logs", "app.log")); string(got) != "log" {
		t.Errorf("got %q", got)
	}
}

func TestCopyFails(t *testing.T) {
	if err := Copy("a", "b"); err == nil {
		t.Error("neither side in an instance")
	}
	if err := Copy("web:/a", "web:/b"); err == nil {
		t.Error("both sides in an instance")
	}
	for _, tc := range []struct {
		name     string
		src, dst string
		result   JobResult
		want     string
	}{
		{"no such guest file", "web:/nope", "local", JobResult{Status: status(1), Output: []byte("cp: /nope: No such file\n")}, "No such file"},
		{"nothing back", "web:/x", "local", JobResult{Status: status(0)}, "nothing came back"},
		{"out of time", "web:/x", "local", JobResult{}, "cp web:/x"},
		{"can't write in the guest", "", "web:/ro/x", JobResult{Status: status(1), Output: []byte("read-only file system")}, "read-only"},
	} {
		fakeJobInstance(t, "web", func(jobRequest) any { return tc.result })
		src, dst := tc.src, filepath.Join(t.TempDir(), tc.dst)
		if src == "" {
			src = filepath.Join(t.TempDir(), "f")
			os.WriteFile(src, nil, 0o644)
			dst = tc.dst
		}
		if err := Copy(src, dst); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
	if err := Copy(filepath.Join(t.TempDir(), "missing"), "web:/x"); err == nil {
		t.Error("a local file that isn't there")
	}
}

func TestShellQuote(t *testing.T) {
	for in, want := range map[string]string{"plain": "'plain'", "it's": `'it'\''s'`, "": "''", "$(rm -rf /)": "'$(rm -rf /)'"} {
		if got := shellQuote(in); got != want {
			t.Errorf("%s: got %s, want %s", in, got, want)
		}
	}
}

func TestUntarMakesNoDirectoryOutside(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	outside := t.TempDir()
	tw.WriteHeader(&tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: outside})
	tw.WriteHeader(&tar.Header{Name: "link/made/here.txt", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})
	tw.Write([]byte("x"))
	tw.Close()
	if err := untar(&buf, t.TempDir()); err == nil {
		t.Fatal("a file under a symlink to outside")
	}
	if _, err := os.Stat(filepath.Join(outside, "made")); err == nil {
		t.Fatal("a directory was made outside, through the symlink")
	}
}

func TestUntarRefusesToWriteThroughALink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	os.WriteFile(target, []byte("keep"), 0o644)
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	tw.WriteHeader(&tar.Header{Name: "f", Typeflag: tar.TypeSymlink, Linkname: target})
	tw.WriteHeader(&tar.Header{Name: "f", Typeflag: tar.TypeReg, Size: 4, Mode: 0o644})
	tw.Write([]byte("evil"))
	tw.Close()
	if err := untar(&buf, dir); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("got %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "keep" {
		t.Fatalf("written through: %q", got)
	}
}
