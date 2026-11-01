package instance

import (
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
