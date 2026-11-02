package instance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeVM is a snowglobe-vm that runs script (sh), its arguments in $@.
func fakeVM(t *testing.T, script string) string {
	t.Helper()
	vm := filepath.Join(t.TempDir(), "snowglobe-vm")
	if err := os.WriteFile(vm, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return vm
}

// An unnamed run's control socket is in a private directory of its own, not at a name in the
// shared temporary directory another user could take first; it goes when the run ends.
func TestAnUnnamedRunsSocketIsPrivate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	args := filepath.Join(t.TempDir(), "args")
	// What the socket's directory is while it runs
	vm := fakeVM(t, `for a; do [ "$prev" = --socket ] && sock=$a; prev=$a; done
ls -ld "$(dirname "$sock")" > '`+args+`'; echo "$sock" >> '`+args+`'`)
	if err := runNative(Options{}, fakeSite(t), vm, "none", nil); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(args)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "drwx------") {
		t.Fatalf("its directory: %q", lines)
	}
	sock := lines[1]
	if !strings.HasPrefix(filepath.Base(filepath.Dir(sock)), "sg-") || len(sock) > sockMax {
		t.Errorf("socket %s", sock)
	}
	if _, err := os.Stat(filepath.Dir(sock)); !os.IsNotExist(err) {
		t.Error("its directory was kept")
	}
}

// A detached run that never restores is stopped and forgotten, not left running unlisted by
// anything but ps.
func TestADetachedRunThatNeverRestoresIsStopped(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	restoreTimeout = 2 * time.Second // time for the script to start and say so, on a loaded machine
	t.Cleanup(func() { restoreTimeout = 2 * time.Minute })
	vm := fakeVM(t, `echo "booting, slowly"; exec sleep 30`)
	err := runNative(Options{Name: "slow", Detach: true, LogDir: t.TempDir()}, fakeSite(t), vm, "none", nil)
	if err == nil || !strings.Contains(err.Error(), "did not restore") || !strings.Contains(err.Error(), "booting, slowly") {
		t.Fatalf("got %v", err)
	}
	st, dir, ok := loadNative("slow")
	if ok {
		t.Fatalf("still running: pid %d", st.Pid)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("its directory was kept")
	}
}
