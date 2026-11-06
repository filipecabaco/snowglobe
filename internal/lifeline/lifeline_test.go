//go:build unix

package lifeline

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The helper child: re-executed test binary that watches its lifeline and exits 0 when it breaks
func TestMain(m *testing.M) {
	if os.Getenv("LIFELINE_HELPER") == "1" {
		if !Watch(func() { os.Exit(0) }) {
			os.Exit(3)
		}
		os.Stdout.WriteString("ready\n")
		time.Sleep(time.Minute)
		os.Exit(4)
	}
	os.Exit(m.Run())
}

// resetPipe forgets the process-wide lifeline (closing its write end: what ending the process does)
func resetPipe() {
	if w != nil {
		w.Close()
	}
	if r != nil {
		r.Close()
	}
	once, r, w, pipeErr = sync.Once{}, nil, nil, nil
}

func envOf(cmd *exec.Cmd) (vals []string) {
	for _, kv := range cmd.Env {
		if strings.HasPrefix(kv, Env+"=") {
			vals = append(vals, strings.TrimPrefix(kv, Env+"="))
		}
	}
	return
}

func TestPassFdNumbering(t *testing.T) {
	t.Cleanup(resetPipe)
	for extra := 0; extra < 3; extra++ {
		cmd := exec.Command("true")
		for i := 0; i < extra; i++ {
			f, err := os.Open(os.DevNull)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			cmd.ExtraFiles = append(cmd.ExtraFiles, f)
		}
		if err := Pass(cmd); err != nil {
			t.Fatal(err)
		}
		if len(cmd.ExtraFiles) != extra+1 {
			t.Fatalf("extra %d: ExtraFiles has %d", extra, len(cmd.ExtraFiles))
		}
		vals := envOf(cmd)
		if len(vals) != 1 || vals[0] != strconv.Itoa(3+extra) {
			t.Fatalf("extra %d: %s = %v, want %d", extra, Env, vals, 3+extra)
		}
		if cmd.ExtraFiles[extra] != r {
			t.Fatalf("extra %d: the lifeline is not the last ExtraFile", extra)
		}
	}
}

func TestPassReplacesExistingEnv(t *testing.T) {
	t.Cleanup(resetPipe)
	cmd := exec.Command("true")
	cmd.Env = []string{"A=1", Env + "=99", "B=2"}
	if err := Pass(cmd); err != nil {
		t.Fatal(err)
	}
	if vals := envOf(cmd); len(vals) != 1 || vals[0] != "3" {
		t.Fatalf("%s = %v, want exactly [3]", Env, vals)
	}
	if !strings.Contains(strings.Join(cmd.Env, " "), "A=1") || !strings.Contains(strings.Join(cmd.Env, " "), "B=2") {
		t.Fatalf("other variables lost: %v", cmd.Env)
	}
	// Inherited environment (Env nil): replaced too
	t.Setenv(Env, "42")
	cmd = exec.Command("true")
	if err := Pass(cmd); err != nil {
		t.Fatal(err)
	}
	if vals := envOf(cmd); len(vals) != 1 || vals[0] != "3" {
		t.Fatalf("inherited: %s = %v, want exactly [3]", Env, vals)
	}
}

func getfd(fd int) (int, error) {
	v, _, e := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFD, 0)
	if e != 0 {
		return 0, e
	}
	return int(v), nil
}

func TestWatchSetsCloexecAndUnsetsEnv(t *testing.T) {
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer pw.Close()
	// dup clears close-on-exec, as an inherited descriptor has it
	fd, err := syscall.Dup(int(pr.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	pr.Close()
	if flags, _ := getfd(fd); flags&syscall.FD_CLOEXEC != 0 {
		t.Fatal("test setup: dup is close-on-exec already")
	}
	t.Setenv(Env, strconv.Itoa(fd))
	gone := make(chan struct{})
	if !Watch(func() { close(gone) }) {
		t.Fatal("Watch found no lifeline")
	}
	if _, ok := os.LookupEnv(Env); ok {
		t.Fatalf("%s still set", Env)
	}
	if flags, err := getfd(fd); err != nil || flags&syscall.FD_CLOEXEC == 0 {
		t.Fatalf("not close-on-exec: flags %d, %v", flags, err)
	}
	select {
	case <-gone:
		t.Fatal("gone called while the write end is open")
	case <-time.After(100 * time.Millisecond):
	}
	pw.Close()
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("gone not called after the write end closed")
	}
}

func TestWatchWithoutLifeline(t *testing.T) {
	os.Unsetenv(Env)
	if Watch(func() {}) {
		t.Fatal("Watch with no variable")
	}
	t.Setenv(Env, "x")
	if Watch(func() {}) {
		t.Fatal("Watch with a bad variable")
	}
	t.Setenv(Env, "1")
	if Watch(func() {}) {
		t.Fatal("Watch with fd 1")
	}
}

func TestChildExitsWhenParentEnds(t *testing.T) {
	t.Cleanup(resetPipe)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "LIFELINE_HELPER=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := Pass(cmd); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill() })
	exited := make(chan error, 1)
	line := make(chan string, 1)
	go func() {
		l, _ := bufio.NewReader(out).ReadString('\n')
		line <- l
		// (the pipe is read to its end before Wait, as os/exec asks)
	}()
	select {
	case l := <-line:
		if l != "ready\n" {
			t.Fatalf("helper said %q", l)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper never got ready")
	}
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		t.Fatalf("helper exited while the lifeline held: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	// What ending this process does: the only write end closes. (The read end this process holds
	// stays open, as the child's copy does; end-of-file needs only the write end gone.)
	w.Close()
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("helper: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper still running after the lifeline broke")
	}
}
