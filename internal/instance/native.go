package instance

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/tools"
	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

// A site run natively: snowglobe-vm itself, which sandboxes itself (Landlock and seccomp, or
// Seatbelt), with no container around it. A named instance keeps its state in
// <cache>/snowglobe/instances/<name>: the process, its control socket (for exec and attach) and
// its log.

type nativeState struct {
	Pid    int    `json:"pid"`
	Site   string `json:"site"`
	VM     string `json:"vm"`
	Socket string `json:"socket"`
	Log    string `json:"log"`
	// Logs is its durable log directory; StopFile, created, stops it gracefully
	Logs     string    `json:"logs,omitempty"`
	StopFile string    `json:"stop_file,omitempty"`
	Started  time.Time `json:"started"`
}

func instancesDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "snowglobe", "instances"), nil
}

// loadNative is the native instance called name, if one is running.
func loadNative(name string) (*nativeState, string, bool) {
	dir, err := instancesDir()
	if err != nil || name == "" || strings.ContainsAny(name, "/\\") {
		return nil, "", false
	}
	dir = filepath.Join(dir, name)
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, dir, false
	}
	var st nativeState
	if json.Unmarshal(data, &st) != nil || !alive(st.Pid) {
		return nil, dir, false
	}
	return &st, dir, true
}

func alive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

// runNative runs the site with snowglobe-vm at vm, attached or (named) detached.
func runNative(o Options, site, vm, network string, tunnels []tunnel.Tunnel) error {
	args := append([]string{"run", site}, tools.TunnelArgs(tunnels, o.AllowPrivate)...)
	if o.RecordReads != "" {
		record, err := filepath.Abs(o.RecordReads)
		if err != nil {
			return err
		}
		args = append(args, "--record-reads", record)
	}
	for _, spec := range o.Publish {
		if network != "fetch" {
			return fmt.Errorf("-p needs a guest with a network: build the site with --network fetch")
		}
		p, err := ParsePort(spec)
		if err != nil {
			return err
		}
		args = append(args, "--forward", fmt.Sprintf("%s:%d:%d", p.IP, p.Host, p.Guest))
		fmt.Fprintf(os.Stderr, "forwarding %s:%d to the guest's port %d\n", p.IP, p.Host, p.Guest)
	}
	// A pooled site keeps its blobs in the directory next to it
	if _, err := os.Stat(filepath.Join(site, "system", "filesystem")); err != nil {
		blobs := filepath.Join(filepath.Dir(site), "blobs")
		if _, err := os.Stat(blobs); err != nil {
			return fmt.Errorf("%s has neither system/filesystem nor a pooled ../blobs", o.Site)
		}
		args = append(args, "--blobs", blobs)
	}
	// Driven from outside: a time limit, a stop file, durable logs (a named instance keeps them
	// where they outlive it)
	logs := o.LogDir
	if logs == "" && o.Name != "" {
		var err error
		if logs, err = LogsDir(o.Name); err != nil {
			return err
		}
	}
	driven := o
	driven.LogDir = logs
	_, vmDriver, err := driverArgs(driven, false)
	if err != nil {
		return err
	}
	args = append(args, vmDriver...)

	if !o.Detach {
		// Its own control socket, so that runs side by side don't share one
		sock := filepath.Join(os.TempDir(), fmt.Sprintf("snowglobe-%d.sock", os.Getpid()))
		defer os.Remove(sock)
		dir := ""
		if o.Name != "" {
			st, d, running := loadNative(o.Name)
			if running {
				return fmt.Errorf("%s is running already (pid %d)", o.Name, st.Pid)
			}
			if err := os.MkdirAll(d, 0o700); err != nil {
				return err
			}
			defer os.RemoveAll(d)
			dir = d
			if sock, err = socketPath(d); err != nil {
				return err
			}
			defer removeSocket(sock, d)
			// snowglobe stop creates it: the run stops itself, killing its job and logging why
			stop := filepath.Join(d, "stop")
			os.Remove(stop)
			args = append(args, "--stop-file", stop)
		}
		cmd := exec.Command(vm, append(args, "--socket", sock)...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			return err
		}
		// A named run: exec, attach and stop find it while it runs
		if dir != "" {
			if err := writeState(dir, nativeState{Pid: cmd.Process.Pid, Site: site, VM: vm, Socket: sock, Started: time.Now(),
				Logs: logs, StopFile: filepath.Join(dir, "stop")}); err != nil {
				return err
			}
		}
		return exitStatus(cmd.Wait())
	}

	if o.Name == "" {
		return fmt.Errorf("a detached instance needs --name, to exec into it later")
	}
	st, dir, running := loadNative(o.Name)
	if running {
		return fmt.Errorf("%s is running already (pid %d)", o.Name, st.Pid)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sock, err := socketPath(dir)
	if err != nil {
		return err
	}
	stop := filepath.Join(dir, "stop")
	os.Remove(stop)
	args = append(args, "--stop-file", stop)
	logPath := filepath.Join(dir, "log")
	log, err := os.Create(logPath)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(vm, append(args, "--detached", "--socket", sock)...)
	cmd.Stdout, cmd.Stderr = log, log
	// Its own session: it outlives this command and the terminal it was started from
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := writeState(dir, nativeState{Pid: cmd.Process.Pid, Site: site, VM: vm, Socket: sock, Log: logPath, Started: time.Now(),
		Logs: logs, StopFile: stop}); err != nil {
		return err
	}
	// Wait until it has restored (or failed)
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case err := <-exited:
			// What it said, before its directory (and the log in it) goes
			said := lastLines(logPath, 5)
			removeSocket(sock, dir)
			os.RemoveAll(dir)
			return fmt.Errorf("%s stopped while restoring (%v): %s", o.Name, err, said)
		case <-deadline:
			return fmt.Errorf("%s did not restore within 2 minutes; its log: %s", o.Name, logPath)
		case <-time.After(100 * time.Millisecond):
		}
		if line := firstLine(logPath, "restored "); line != "" {
			fmt.Fprintf(os.Stderr, "%s: %s\n  snowglobe exec %s '<command>'\n  snowglobe attach %s\n  snowglobe stop %s\n  logs: %s\n",
				o.Name, line, o.Name, o.Name, o.Name, logs)
			return nil
		}
	}
}

// sockMax is the longest control socket path this system takes: a Unix socket's path has to fit
// sun_path (104 bytes on macOS and the BSDs, 108 on Linux), terminating NUL included.
var sockMax = 103

// socketPath is where an instance in dir keeps its control socket: in dir, unless that path is too
// long for a Unix socket (a long cache path, user or instance name), and then in a private
// directory of its own under the temporary directory, so the run may write there and nowhere else
// in it.
func socketPath(dir string) (string, error) {
	if p := filepath.Join(dir, "sock"); len(p) <= sockMax {
		return p, nil
	}
	for _, base := range []string{os.TempDir(), "/tmp"} {
		if len(filepath.Join(base, "sg-0123456789", "sock")) > sockMax {
			continue
		}
		private, err := os.MkdirTemp(base, "sg-")
		if err != nil {
			continue
		}
		return filepath.Join(private, "sock"), nil
	}
	return "", fmt.Errorf("%s: too long a path for a control socket, and no short temporary directory", dir)
}

// removeSocket removes a control socket kept outside its instance's directory, and the private
// directory socketPath made for it.
func removeSocket(sock, dir string) {
	if sock == "" || strings.HasPrefix(sock, dir+string(filepath.Separator)) {
		return
	}
	os.Remove(sock)
	if parent := filepath.Dir(sock); strings.HasPrefix(filepath.Base(parent), "sg-") {
		os.Remove(parent)
	}
}

func writeState(dir string, st nativeState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "state.json"), data, 0o600)
}

// ExitError carries the exit status of the runtime, for the command to end with.
type ExitError struct{ Code int }

func (e ExitError) Error() string { return fmt.Sprintf("exit status %d", e.Code) }

func exitStatus(err error) error {
	var x *exec.ExitError
	if errors.As(err, &x) {
		return ExitError{Code: x.ExitCode()}
	}
	return err
}

func firstLine(path, prefix string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		if strings.HasPrefix(s.Text(), prefix) {
			return s.Text()
		}
	}
	return ""
}

func lastLines(path string, n int) string {
	data, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// execNative and attachNative talk to a native instance's control socket.
func execNative(st *nativeState, command []string) error {
	cmd := exec.Command(st.VM, append([]string{"exec", "--socket", st.Socket}, command...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return exitStatus(cmd.Run())
}

func attachNative(st *nativeState) error {
	cmd := exec.Command(st.VM, "attach", "--socket", st.Socket)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return exitStatus(cmd.Run())
}

// stopNative ends a native instance: its stop file first, so that it kills the job running in the
// guest, saves and logs why it stopped; then SIGTERM if it hasn't gone within stopGrace, then
// SIGKILL if it hasn't gone 5 s after that.
func stopNative(st *nativeState, dir string) error {
	defer os.RemoveAll(dir)
	defer removeSocket(st.Socket, dir)
	if !alive(st.Pid) {
		return nil
	}
	if st.StopFile != "" && os.WriteFile(st.StopFile, nil, 0o600) == nil && gone(st.Pid, stopGrace) {
		return nil
	}
	if err := syscall.Kill(st.Pid, syscall.SIGTERM); err != nil {
		return nil // gone already
	}
	if gone(st.Pid, 5*time.Second) {
		return nil
	}
	return syscall.Kill(st.Pid, syscall.SIGKILL)
}

// gone waits up to d for pid to exit.
func gone(pid int, d time.Duration) bool {
	for deadline := time.Now().Add(d); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if !alive(pid) {
			return true
		}
	}
	return !alive(pid)
}

// listNative prints the native instances that are running (and forgets those that aren't).
func listNative() (int, error) {
	dir, err := instancesDir()
	if err != nil {
		return 0, err
	}
	entries, _ := os.ReadDir(dir)
	n := 0
	for _, e := range entries {
		st, d, running := loadNative(e.Name())
		if !running {
			// Its socket too, if it was kept outside
			var gone nativeState
			if data, err := os.ReadFile(filepath.Join(d, "state.json")); err == nil && json.Unmarshal(data, &gone) == nil {
				removeSocket(gone.Socket, d)
			}
			os.RemoveAll(d)
			continue
		}
		if n == 0 {
			fmt.Println("NAME\tSITE\tSTARTED\tRUNTIME")
		}
		fmt.Printf("%s\t%s\t%s ago\tnative (pid %d)\n", e.Name(), st.Site, time.Since(st.Started).Round(time.Second), st.Pid)
		n++
	}
	return n, nil
}
