package instance

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// A run driven by a program: it ends after --max-runtime (exit 124) or once its --stop-file exists
// (exit 143), killing the job running in the guest, and keeps durable logs in --log-dir
// (console.log, serial.log, events.jsonl), on either runtime.

// Exit statuses of a run its driver ended.
const (
	ExitMaxRuntime = 124
	ExitStopped    = 143
)

// driverArgs are the container's flags (Docker: the stop file's directory and the log directory
// mounted in) and snowglobe-vm's for o's driver controls. The log directory is made here.
func driverArgs(o Options, inContainer bool) (docker, vm []string, err error) {
	if o.MaxRuntime < 0 {
		return nil, nil, fmt.Errorf("--max-runtime %s: more than 0", o.MaxRuntime)
	}
	if o.MaxRuntime > 0 {
		vm = append(vm, "--max-runtime", strconv.FormatFloat(o.MaxRuntime.Seconds(), 'f', -1, 64))
	}
	if o.StopFile != "" {
		stop, err := filepath.Abs(o.StopFile)
		if err != nil {
			return nil, nil, err
		}
		if st, err := os.Stat(filepath.Dir(stop)); err != nil || !st.IsDir() {
			return nil, nil, fmt.Errorf("--stop-file %s: its directory must exist", o.StopFile)
		}
		if inContainer {
			// The directory, read-only: the file appears in the container when it appears here
			docker = append(docker, "-v", filepath.Dir(stop)+":/stop:ro")
			stop = "/stop/" + filepath.Base(stop)
		}
		vm = append(vm, "--stop-file", stop)
	}
	if o.LogDir != "" {
		dir, err := filepath.Abs(o.LogDir)
		if err != nil {
			return nil, nil, err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, nil, err
		}
		if inContainer {
			// The container runs as nobody: it writes into a directory open to it
			if err := os.Chmod(dir, 0o777); err != nil {
				return nil, nil, err
			}
			docker = append(docker, "-v", dir+":/logs")
			dir = "/logs"
		}
		vm = append(vm, "--log-dir", dir)
	}
	return docker, vm, nil
}

// LogsDir is where a named native instance keeps its logs unless --log-dir says otherwise: they
// stay after it stops (the instance's own directory does not).
func LogsDir(name string) (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "snowglobe", "logs", name), nil
}

// stopGrace is how long a native instance gets to stop itself (kill its job, save, log) once its
// stop file exists, before it is sent SIGTERM
var stopGrace = 25 * time.Second
