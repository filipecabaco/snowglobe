package instance

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestParsePort(t *testing.T) {
	for spec, want := range map[string]Port{
		"8000":              {"127.0.0.1", 8000, 8000},
		"8080:4000":         {"127.0.0.1", 8080, 4000},
		"0.0.0.0:8080:4000": {"0.0.0.0", 8080, 4000},
	} {
		got, err := ParsePort(spec)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v", spec, got, err)
		}
	}
	for _, bad := range []string{"", "x", "70000", "1:2:3:4", "8000:"} {
		if _, err := ParsePort(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestNativeStateOfAStoppedInstanceIsForgotten(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	dir, err := instancesDir()
	if err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(dir, "gone")
	if err := os.MkdirAll(gone, 0o700); err != nil {
		t.Fatal(err)
	}
	// A pid that isn't running: this process's would be; find one that isn't
	if err := writeState(gone, nativeState{Pid: 1 << 22, Site: "/x"}); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := loadNative("gone"); ok {
		t.Fatal("a dead instance counts as running")
	}
	if n, err := listNative(); err != nil || n != 0 {
		t.Fatalf("listed %d, %v", n, err)
	}
	if _, err := os.Stat(gone); !os.IsNotExist(err) {
		t.Fatal("its state was kept")
	}
	if _, _, ok := loadNative("../escape"); ok {
		t.Fatal("a name with a path in it")
	}
}

func TestUntarStaysInside(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	outside := t.TempDir()
	tw.WriteHeader(&tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: outside})
	tw.WriteHeader(&tar.Header{Name: "link/escaped", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})
	tw.Write([]byte("x"))
	tw.Close()
	dir := t.TempDir()
	if err := untar(&buf, dir); err == nil {
		t.Fatal("a file written through a symlink to outside")
	}
	if _, err := os.Stat(filepath.Join(outside, "escaped")); err == nil {
		t.Fatal("it got out")
	}
	var ok bytes.Buffer
	tw = tar.NewWriter(&ok)
	tw.WriteHeader(&tar.Header{Name: "a/b.txt", Typeflag: tar.TypeReg, Size: 2, Mode: 0o644})
	tw.Write([]byte("hi"))
	tw.Close()
	if err := untar(&ok, dir); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a", "b.txt")); string(got) != "hi" {
		t.Fatalf("got %q", got)
	}
}

func TestGuestPath(t *testing.T) {
	for in, want := range map[string]bool{"web:/root/a": true, "web:rel": false, "./a:b": false, "/x": false, "C:/x": true} {
		if _, _, ok := guestPath(in); ok != want {
			t.Errorf("%s: %v", in, ok)
		}
	}
}
