package instance

import (
	"bufio"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestDriverArgsNative(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	docker, vm, err := driverArgs(Options{MaxRuntime: 90 * time.Second, StopFile: "stop", LogDir: "logs/run"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(docker) != 0 {
		t.Errorf("docker flags for a native run: %v", docker)
	}
	want := []string{"--max-runtime", "90", "--stop-file", filepath.Join(dir, "stop"), "--log-dir", filepath.Join(dir, "logs/run")}
	if !slices.Equal(vm, want) {
		t.Errorf("got %v\nwant %v", vm, want)
	}
	if st, err := os.Stat(filepath.Join(dir, "logs/run")); err != nil || !st.IsDir() {
		t.Error("the log directory wasn't made")
	}
	// Fractions of a second survive
	_, vm, _ = driverArgs(Options{MaxRuntime: 1500 * time.Millisecond}, false)
	if !slices.Equal(vm, []string{"--max-runtime", "1.5"}) {
		t.Errorf("got %v", vm)
	}
}

func TestDriverArgsDocker(t *testing.T) {
	dir := t.TempDir()
	stop := filepath.Join(dir, "signals", "stop")
	if err := os.MkdirAll(filepath.Dir(stop), 0o755); err != nil {
		t.Fatal(err)
	}
	logs := filepath.Join(dir, "logs")
	docker, vm, err := driverArgs(Options{StopFile: stop, LogDir: logs}, true)
	if err != nil {
		t.Fatal(err)
	}
	// The stop file's directory read-only, the logs writable, at fixed paths in the container
	wantDocker := []string{"-v", filepath.Dir(stop) + ":/stop:ro", "-v", logs + ":/logs"}
	wantVM := []string{"--stop-file", "/stop/stop", "--log-dir", "/logs"}
	if !slices.Equal(docker, wantDocker) || !slices.Equal(vm, wantVM) {
		t.Errorf("got %v %v", docker, vm)
	}
	// The container runs as nobody
	if st, err := os.Stat(logs); err != nil || st.Mode().Perm() != 0o777 {
		t.Errorf("the log directory isn't open to the container: %v %v", st.Mode(), err)
	}
}

func TestDriverArgsAreChecked(t *testing.T) {
	if _, _, err := driverArgs(Options{StopFile: "/no/such/dir/stop"}, false); err == nil {
		t.Error("a stop file whose directory doesn't exist")
	}
	if _, _, err := driverArgs(Options{MaxRuntime: -time.Second}, false); err == nil {
		t.Error("a negative max runtime")
	}
	if _, vm, err := driverArgs(Options{}, true); err != nil || len(vm) != 0 {
		t.Errorf("no controls, no flags: %v %v", vm, err)
	}
}

// A process standing in for snowglobe-vm: it exits by itself once its stop file exists, as a
// run does, unless it ignores it.
func fakeInstance(t *testing.T, honours bool) (*nativeState, string, chan error) {
	t.Helper()
	dir := t.TempDir()
	stop := filepath.Join(dir, "stop")
	script := `trap 'exit 99' TERM; while [ ! -e "$1" ]; do sleep 0.05; done; exit 0`
	if !honours {
		script = `trap 'exit 99' TERM; while :; do sleep 0.05; done`
	}
	cmd := exec.Command("sh", "-c", script, "sh", stop)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// Reaped here, as init reaps a detached instance: a zombie still counts as alive
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() { cmd.Process.Kill() })
	return &nativeState{Pid: cmd.Process.Pid, StopFile: stop}, dir, exited
}

func TestStopNativeStopsWithTheStopFile(t *testing.T) {
	st, dir, exited := fakeInstance(t, true)
	begun := time.Now()
	if err := stopNative(st, dir); err != nil {
		t.Fatal(err)
	}
	if err := <-exited; err != nil {
		t.Fatalf("it didn't stop by itself: %v", err)
	}
	if time.Since(begun) > 5*time.Second {
		t.Errorf("took %s", time.Since(begun))
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("the instance's directory was kept")
	}
}

func TestStopNativeEscalatesWhenTheStopFileIsIgnored(t *testing.T) {
	old := stopGrace
	stopGrace = 300 * time.Millisecond
	t.Cleanup(func() { stopGrace = old })
	st, dir, exited := fakeInstance(t, false)
	if err := stopNative(st, dir); err != nil {
		t.Fatal(err)
	}
	var x *exec.ExitError
	if err := <-exited; !errors.As(err, &x) || x.ExitCode() != 99 {
		t.Fatalf("not ended by SIGTERM: %v", err)
	}
}

// An instance that goes away while a job runs (stopped): the job says so.
func TestAJobOnAStoppingInstanceSaysSo(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	dir, err := instancesDir()
	if err != nil {
		t.Fatal(err)
	}
	inst := filepath.Join(dir, "stopping")
	if err := os.MkdirAll(inst, 0o700); err != nil {
		t.Fatal(err)
	}
	// Unix socket paths are short: not under the temp home
	sock := filepath.Join(os.TempDir(), "sgjob-test.sock")
	os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		// Reads the job, then the process exits without answering
		bufio.NewReader(c).ReadBytes('\n')
		c.Close()
	}()
	if err := writeState(inst, nativeState{Pid: os.Getpid(), Socket: sock}); err != nil {
		t.Fatal(err)
	}
	_, err = Job("stopping", JobRequest{Cmd: "sleep 100", Timeout: 5})
	if err == nil || !strings.Contains(err.Error(), "stopped while the job ran") {
		t.Fatalf("got %v", err)
	}
}

func TestAliveAndGone(t *testing.T) {
	if !alive(os.Getpid()) || gone(os.Getpid(), 10*time.Millisecond) {
		t.Fatal("this process is running")
	}
	cmd := exec.Command("sh", "-c", "exit 0")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if !gone(cmd.Process.Pid, time.Second) {
		t.Fatal("an exited, reaped process")
	}
}
