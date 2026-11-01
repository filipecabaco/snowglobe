package native

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestReleaseNeedsARelease(t *testing.T) {
	if _, err := Release("dev", "darwin", "arm64"); err == nil {
		t.Fatal("a dev build fetched a runtime")
	}
}

func TestEnvironmentWinsForThisMachine(t *testing.T) {
	t.Setenv("SNOWGLOBE_VM", "/opt/vm")
	if p, err := VM("dev", nil); err != nil || p != "/opt/vm" {
		t.Fatalf("got %q, %v", p, err)
	}
	other := "linux"
	if runtime.GOOS == "linux" {
		other = "darwin"
	}
	if p, err := For("dev", other, runtime.GOARCH, nil); err == nil {
		t.Fatalf("SNOWGLOBE_VM used for %s: %q", other, p)
	}
}

func TestToolsImageIsTheLinuxFallback(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	calls := 0
	img := &Image{Key: "abc", Extract: func(dest string) error {
		calls++
		return os.WriteFile(dest, []byte("#!vm"), 0o755)
	}}
	p, err := For("dev", "linux", runtime.GOARCH, img)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := For("dev", "linux", runtime.GOARCH, img); err != nil || calls != 1 {
		t.Fatalf("not cached: %d calls, %v", calls, err)
	}
	if got, _ := os.ReadFile(p); string(got) != "#!vm" {
		t.Fatalf("got %q", got)
	}
}

func TestExtract(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("#!vm")
	tw.WriteHeader(&tar.Header{Name: "x/snowglobe-vm", Mode: 0o755, Size: int64(len(body))})
	tw.Write(body)
	tw.Close()
	gz.Close()
	dest := filepath.Join(t.TempDir(), "rt", "snowglobe-vm")
	if err := Extract(&buf, "x/snowglobe-vm", dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); string(got) != "#!vm" {
		t.Fatalf("got %q", got)
	}
}
