package native

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDownloadWritesTheFileWhole(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/asset" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("contents"))
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "deep", "asset")
	if err := Download(srv.URL+"/asset", dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); string(got) != "contents" {
		t.Fatalf("got %q", got)
	}
	if _, err := os.Stat(dest + ".tmp"); err == nil {
		t.Error("its temporary file was kept")
	}
	missing := filepath.Join(t.TempDir(), "missing")
	if err := Download(srv.URL+"/nope", missing); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("a 404: %v", err)
	}
	if _, err := os.Stat(missing); err == nil {
		t.Error("a failed download left a file")
	}
}

func TestAReleaseInTheCacheIsNotFetchedAgain(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SNOWGLOBE_VM", "")
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	cached := filepath.Join(cache, "snowglobe", "runtime", "snowglobe-vm_1.2.3_plan9_mips", "snowglobe-vm")
	os.MkdirAll(filepath.Dir(cached), 0o755)
	os.WriteFile(cached, []byte("#!vm"), 0o755)
	if p, err := Release("v1.2.3", "plan9", "mips"); err != nil || p != cached {
		t.Fatalf("got %q, %v", p, err)
	}
	// For prefers the release, for any system
	if p, err := For("v1.2.3", "plan9", "mips", nil); err != nil || p != cached {
		t.Fatalf("got %q, %v", p, err)
	}
}

func TestNoRuntimeForThisSystem(t *testing.T) {
	t.Setenv("SNOWGLOBE_VM", "")
	// Not a release, and not Linux on this architecture: nothing to fall back to
	_, err := For("dev", "plan9", runtime.GOARCH, &Image{Key: "k"})
	if !errors.Is(err, ErrNone) || !strings.Contains(err.Error(), "plan9/") {
		t.Fatalf("got %v", err)
	}
	if _, err := For("dev", "linux", runtime.GOARCH, nil); !errors.Is(err, ErrNone) {
		t.Fatalf("without the tools image: %v", err)
	}
}

func TestAToolsImageThatFailsToExtractIsNotCached(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SNOWGLOBE_VM", "")
	broken := &Image{Key: "broken", Extract: func(string) error { return errors.New("no docker daemon") }}
	if _, err := For("dev", "linux", runtime.GOARCH, broken); err == nil || !strings.Contains(err.Error(), "no docker daemon") {
		t.Fatalf("got %v", err)
	}
	fixed := &Image{Key: "broken", Extract: func(dest string) error { return os.WriteFile(dest, []byte("#!vm"), 0o755) }}
	if _, err := For("dev", "linux", runtime.GOARCH, fixed); err != nil {
		t.Fatalf("a later try: %v", err)
	}
}

func TestExtractFails(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "x/other", Mode: 0o644, Size: 1})
	tw.Write([]byte("x"))
	tw.Close()
	gz.Close()
	dest := filepath.Join(t.TempDir(), "snowglobe-vm")
	if err := Extract(&buf, "x/snowglobe-vm", dest); err == nil || !strings.Contains(err.Error(), "not in the release's archive") {
		t.Errorf("a missing member: %v", err)
	}
	if err := Extract(strings.NewReader("not a gzip stream at all"), "x/snowglobe-vm", dest); err == nil {
		t.Error("not a gzip")
	}
	if _, err := os.Stat(dest); err == nil {
		t.Error("a failed extract left a file")
	}
}

func TestDockerAvailable(t *testing.T) {
	empty := t.TempDir()
	t.Setenv("PATH", empty)
	if DockerAvailable() {
		t.Fatal("no docker on the PATH")
	}
	os.WriteFile(filepath.Join(empty, "docker"), []byte("#!/bin/sh\n"), 0o755)
	if !DockerAvailable() {
		t.Fatal("a docker on the PATH")
	}
}
