//go:build unix

// Package lifeline ties a child process's life to this one's, on Linux and macOS alike: the child
// inherits the read end of a pipe whose only write end this process holds, and never writes to.
// When this process ends, however it ends (a crash, kill -9, the OOM killer), the kernel closes
// that write end and the child reads end-of-file: its cue to stop.
//
// The child is told which descriptor it is by SNOWGLOBE_LIFELINE in its environment. snowglobe-vm
// reads it (and watches it from a thread, or from its poll loop when it serves forks); a snowglobe
// command started by the daemon (a build) watches it with Watch.
package lifeline

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// Env is the variable that names the inherited descriptor.
const Env = "SNOWGLOBE_LIFELINE"

var (
	once    sync.Once
	r, w    *os.File
	pipeErr error
)

// pipe is this process's lifeline: made once, its write end held (and never written) until the
// process ends. Both ends are close-on-exec: a child gets the read end only when Pass gives it.
func pipe() (*os.File, error) {
	once.Do(func() { r, w, pipeErr = os.Pipe() })
	return r, pipeErr
}

// Pass gives cmd the read end of this process's lifeline, as the next of its ExtraFiles, and says
// which descriptor that is in its environment. Call it after anything else adds to ExtraFiles.
func Pass(cmd *exec.Cmd) error {
	rd, err := pipe()
	if err != nil {
		return err
	}
	cmd.ExtraFiles = append(cmd.ExtraFiles, rd)
	fd := 3 + len(cmd.ExtraFiles) - 1
	env := cmd.Env
	if env == nil {
		env = os.Environ()
	}
	kept := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, Env+"=") {
			kept = append(kept, kv)
		}
	}
	cmd.Env = append(kept, Env+"="+strconv.Itoa(fd))
	return nil
}

// Watch, when this process was given a lifeline, takes it (unsetting Env, so that what this
// process starts doesn't take a descriptor of the same number for one) and calls gone, once, from
// a goroutine of its own, when it breaks. False if there was none.
func Watch(gone func()) bool {
	v, ok := os.LookupEnv(Env)
	if !ok {
		return false
	}
	os.Unsetenv(Env)
	fd, err := strconv.Atoi(v)
	if err != nil || fd < 3 {
		return false
	}
	// Close-on-exec, so that it isn't handed down further by accident
	syscall.CloseOnExec(fd)
	f := os.NewFile(uintptr(fd), "lifeline")
	if f == nil {
		return false
	}
	go func() {
		buf := make([]byte, 64)
		for {
			// Nothing is ever written: a read returns only at end-of-file (or on an error)
			if _, err := f.Read(buf); err != nil {
				gone()
				return
			}
		}
	}()
	return true
}

// Stop is what Watch's caller usually does when its lifeline breaks: what a stop does to it, a
// SIGTERM to itself (handled where the program handles one, else the end of it).
func Stop() {
	syscall.Kill(os.Getpid(), syscall.SIGTERM)
}
