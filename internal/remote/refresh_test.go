package remote

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A process runs a fetched site from the directory Fetch gave it, for as long as it runs: a
// second process refreshing the same URL to a new build doesn't touch that directory.
func TestARefreshLeavesTheSiteARunIsUsing(t *testing.T) {
	cacheHome(t)
	build := "1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"`+build+`"`)
		if r.Header.Get("If-None-Match") == `"`+build+`"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Write(gzipped(t, tarOf(t, map[string]string{"run.json": `{"build":` + build + `}`, "system/state.bin.zst": "state " + build})))
	}))
	defer srv.Close()
	source := srv.URL + "/site.tar.gz"

	running, err := Fetch(source)
	if err != nil {
		t.Fatal(err)
	}
	// Unchanged: the same directory
	if again, err := Fetch(source); err != nil || again != running {
		t.Fatalf("unchanged: %s, %v", again, err)
	}
	build = "2"
	refreshed, err := Fetch(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ dir, want string }{{running, "state 1"}, {refreshed, "state 2"}} {
		if got, _ := os.ReadFile(filepath.Join(c.dir, "system", "state.bin.zst")); string(got) != c.want {
			t.Errorf("%s: %q, want %q", c.dir, got, c.want)
		}
	}
	// The newest is the one a new run gets
	if again, err := Fetch(source); err != nil || again != refreshed {
		t.Fatalf("after the refresh: %s, %v", again, err)
	}
}

// An old build nothing is using any more goes at the next refresh.
func TestARefreshRemovesOldBuildsNothingUses(t *testing.T) {
	cacheHome(t)
	file := filepath.Join(t.TempDir(), "site.tar")
	os.WriteFile(file, tarOf(t, map[string]string{"run.json": "{}"}), 0o644)
	dir, err := Unpack(file)
	if err != nil {
		t.Fatal(err)
	}
	// A build from before, that no process holds
	stale := filepath.Join(filepath.Dir(dir), "v-stale")
	os.MkdirAll(stale, 0o755)
	os.WriteFile(filepath.Join(stale, "run.json"), []byte("{}"), 0o644)
	// The file changes: unpacked again, under its new size and time
	os.WriteFile(file, tarOf(t, map[string]string{"run.json": `{"v":2}`}), 0o644)
	if _, err := Unpack(file); err != nil {
		t.Fatal(err)
	}
	// Another cache entry altogether: the stale build is only removed from its own
	if _, err := os.Stat(stale); err != nil {
		t.Fatal("removed a build from another cache entry")
	}
	if _, err := unpackInto(openFile(t, file), file, filepath.Dir(dir)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("an old build nothing uses was kept")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Error("removed the build this process uses")
	}
}

func openFile(t *testing.T, name string) *os.File {
	t.Helper()
	f, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}
