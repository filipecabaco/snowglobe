package remote

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A server that sends more than any site file could be is cut off with an error, not held in
// memory or written to disk without end; nor is what it sent kept as if it were the file.
func TestASiteFileTooLargeIsRefused(t *testing.T) {
	cacheHome(t)
	maxFile, maxRunJSON = 200, 32
	t.Cleanup(func() { maxFile, maxRunJSON = 16<<30, 16<<20 })
	files := map[string]string{
		"/run.json": "{}", "/index.html": "page", "/system/filesystem.json": twoBlobs,
		"/system/state.bin.zst":                 strings.Repeat("s", 201),
		"/system/filesystem/aaaaaaaaaa.bin.zst": "A", "/system/filesystem/bbbbbbbbbb.bin.zst": "B",
	}
	srv := newSiteServer(t, files)
	dir, err := Fetch(srv.URL + "/")
	if err == nil || !strings.Contains(err.Error(), "more than 200 bytes") {
		t.Fatalf("a state too large: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "system", "state.bin.zst")); err == nil {
		t.Error("the cut-off state was kept")
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "system", "*.part-*")); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}

	// Exactly the limit is fine; so are blobs within it
	files["/system/state.bin.zst"] = strings.Repeat("s", 200)
	if _, err := Fetch(srv.URL + "/"); err != nil {
		t.Fatal(err)
	}

	files["/run.json"] = `{"title":"` + strings.Repeat("x", 40) + `"}`
	if _, err := Fetch(srv.URL + "/"); err == nil || !strings.Contains(err.Error(), "more than 32 bytes") {
		t.Errorf("a run.json too large: %v", err)
	}
}
