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
	Pid     int       `json:"pid"`
	Site    string    `json:"site"`
	VM      string    `json:"vm"`
	Socket  string    `json:"socket"`
	Log     string    `json:"log"`
	Started time.Time `json:"started"`
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
			dir, sock = d, filepath.Join(d, "sock")
		}
		cmd := exec.Command(vm, append(args, "--socket", sock)...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			return err
		}
		// A named run: exec, attach and stop find it while it runs
		if dir != "" {
			if err := writeState(dir, nativeState{Pid: cmd.Process.Pid, Site: site, VM: vm, Socket: sock, Started: time.Now()}); err != nil {
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
	sock := filepath.Join(dir, "sock")
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
	if err := writeState(dir, nativeState{Pid: cmd.Process.Pid, Site: site, VM: vm, Socket: sock, Log: logPath, Started: time.Now()}); err != nil {
		return err
	}
	// Wait until it has restored (or failed)
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case err := <-exited:
			os.RemoveAll(dir)
			return fmt.Errorf("%s stopped while restoring (%v): %s", o.Name, err, lastLines(logPath, 5))
		case <-deadline:
			return fmt.Errorf("%s did not restore within 2 minutes; its log: %s", o.Name, logPath)
		case <-time.After(100 * time.Millisecond):
		}
		if line := firstLine(logPath, "restored "); line != "" {
			fmt.Fprintf(os.Stderr, "%s: %s\n  snowglobe exec %s '<command>'\n  snowglobe attach %s\n  snowglobe stop %s\n",
				o.Name, line, o.Name, o.Name, o.Name)
			return nil
		}
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

// stopNative ends a native instance: SIGTERM, then SIGKILL if it hasn't gone after 5 s.
func stopNative(st *nativeState, dir string) error {
	defer os.RemoveAll(dir)
	if err := syscall.Kill(st.Pid, syscall.SIGTERM); err != nil {
		return nil // gone already
	}
	for range 50 {
		if !alive(st.Pid) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return syscall.Kill(st.Pid, syscall.SIGKILL)
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
