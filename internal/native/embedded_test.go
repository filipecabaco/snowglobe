package native

import (
	"bytes"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func carrying(t *testing.T, body []byte) {
	t.Helper()
	enc, _ := zstd.NewWriter(nil)
	old := embeddedVM
	embeddedVM = enc.EncodeAll(body, nil)
	t.Cleanup(func() { embeddedVM = old })
}

// A snowglobe that carries its snowglobe-vm runs it, unpacked once into the cache; one that
// carries another runs that one, never the first's
func TestTheCarriedVMIsUnpackedOnceAndUsed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SNOWGLOBE_VM", "")
	body := bytes.Repeat([]byte("vm one "), 1<<16)
	carrying(t, body)
	if !Embedded() {
		t.Fatal("not carrying it")
	}
	p, err := For("v0.0.0-dev", runtime.GOOS, runtime.GOARCH, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	fi, _ := os.Stat(p)
	if !bytes.Equal(got, body) || fi.Mode()&0o111 == 0 {
		t.Fatalf("%s: %d bytes, mode %v", p, len(got), fi.Mode())
	}
	again, _ := For("v0.0.0-dev", runtime.GOOS, runtime.GOARCH, nil)
	if again != p {
		t.Errorf("unpacked again elsewhere: %s", again)
	}
	carrying(t, []byte("vm two"))
	other, _ := For("v0.0.0-dev", runtime.GOOS, runtime.GOARCH, nil)
	if other == p {
		t.Error("a different snowglobe-vm at the old one's path")
	}
	if got, _ := os.ReadFile(other); string(got) != "vm two" {
		t.Errorf("the new one: %q", got)
	}
	// SNOWGLOBE_VM still wins; another system's isn't the carried one
	t.Setenv("SNOWGLOBE_VM", "/opt/mine")
	if p, _ := For("v0.0.0-dev", runtime.GOOS, runtime.GOARCH, nil); p != "/opt/mine" {
		t.Errorf("SNOWGLOBE_VM: %s", p)
	}
	t.Setenv("SNOWGLOBE_VM", "")
	other_os := "linux"
	if runtime.GOOS == "linux" {
		other_os = "darwin"
	}
	if p, err := For("dev", other_os, runtime.GOARCH, nil); err == nil && strings.Contains(p, "embedded-") {
		t.Errorf("the carried one for %s: %s", other_os, p)
	}
}
