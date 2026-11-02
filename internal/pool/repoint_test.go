package pool

import (
	"os"
	"path/filepath"
	"testing"
)

// A page that can't be pointed at the pool fails the run before its blobs move: the site still
// loads as it is.
func TestASiteThatCantBeRepointedKeepsItsBlobs(t *testing.T) {
	root := t.TempDir()
	site(t, root, "odd", "kernel")
	os.WriteFile(filepath.Join(root, "odd", "index.html"), []byte(`a page of its own`), 0o644)
	if _, err := Run(root); err == nil {
		t.Fatal("pooled a page with no blob location")
	}
	if !exists(filepath.Join(root, "odd", "system", "filesystem", "kernel")) {
		t.Error("its blobs were moved out from under it")
	}
}
