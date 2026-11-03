package instance

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/remote"
)

// A second run with a name already taken fails, and never removes what the first made: even in
// the moment before the first has written its state (made lasting here by a first run whose
// snowglobe-vm removes its state as soon as it appears).
func TestASecondRunOfANameNeverTakesTheFirstsDirectory(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	first := fakeVM(t, `for a; do [ "$prev" = --stop-file ] && stop=$a; prev=$a; done
dir=$(dirname "$stop")
while [ ! -e "$dir/state.json" ]; do sleep 0.01; done
rm "$dir/state.json"; touch "$dir/mine"
while [ ! -e "$stop" ]; do sleep 0.01; done`)
	done := make(chan error, 1)
	go func() { done <- runNative(Options{Name: "web", LogDir: t.TempDir()}, fakeSite(t), first, "none", nil) }()

	instances, _ := instancesDir()
	dir := filepath.Join(instances, "web")
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, err := os.Stat(filepath.Join(dir, "mine")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the first run never started")
		}
	}

	second := fakeVM(t, `exit 1`)
	for _, detach := range []bool{false, true} {
		err := runNative(Options{Name: "web", Detach: detach, LogDir: t.TempDir()}, fakeSite(t), second, "none", nil)
		if err == nil || !strings.Contains(err.Error(), "instance web is already running") {
			t.Errorf("detached %v: got %v", detach, err)
		}
		if _, err := os.Stat(filepath.Join(dir, "mine")); err != nil {
			t.Fatalf("detached %v: the second run removed the first's directory", detach)
		}
	}

	os.WriteFile(filepath.Join(dir, "stop"), nil, 0o600)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the first run didn't stop")
	}
	// Ended, the name is free again
	if err := runNative(Options{Name: "web", LogDir: t.TempDir()}, fakeSite(t), second, "none", nil); (err != ExitError{Code: 1}) {
		t.Errorf("the name after the first run ended: %v", err)
	}
}

// ps forgets instances that aren't running, but not one starting up: claimed, its state not yet
// written.
func TestPsLeavesAnInstanceThatIsStarting(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	instances, _ := instancesDir()
	dir := filepath.Join(instances, "starting")
	lock, err := claim("starting", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if _, err := listNative(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("ps removed an instance that was starting")
	}
}

// A detached snowglobe-vm outlives the command that started it: it inherits the lock on its name,
// and on the build of a fetched site it runs from, so neither is taken from under it.
func TestADetachedRunHoldsItsNameAndItsSite(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// A site fetched (unpacked) by this process
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	tw.WriteHeader(&tar.Header{Name: "run.json", Mode: 0o644, Size: 2})
	tw.Write([]byte("{}"))
	tw.WriteHeader(&tar.Header{Name: "system/filesystem/", Mode: 0o755, Typeflag: tar.TypeDir})
	tw.Close()
	archive := filepath.Join(t.TempDir(), "site.tar")
	os.WriteFile(archive, buf.Bytes(), 0o644)
	site, err := remote.Unpack(archive)
	if err != nil {
		t.Fatal(err)
	}
	held := filepath.Join(t.TempDir(), "held")
	// What it inherited: the name's lock as file 3, and its site's among those after it (the
	// process holds every build it fetched, earlier ones in the same process too)
	vm := fakeVM(t, `for a; do [ "$prev" = --stop-file ] && stop=$a; prev=$a; done
ino() { stat -L -c %i "$1" 2>/dev/null || stat -L -f %i "$1"; }
r=; [ "$(ino /dev/fd/3)" = "$(ino "$(dirname "$stop")/.lock")" ] && r="$r name"
want=$(ino '`+site+`.lock')
for f in /dev/fd/*; do [ "${f#/dev/fd/}" -ge 4 ] 2>/dev/null && [ "$(ino "$f")" = "$want" ] && { r="$r site"; break; }; done
echo "$r" > '`+held+`'; echo "restored fake"
while [ ! -e "$stop" ]; do sleep 0.01; done`)
	if err := runNative(Options{Name: "held", Detach: true, LogDir: t.TempDir()}, site, vm, "none", nil); err != nil {
		t.Fatal(err)
	}
	defer Stop("held")
	if data, _ := os.ReadFile(held); strings.TrimSpace(string(data)) != "name site" {
		t.Errorf("it holds %q", data)
	}
}
