package remote

import (
	"os"
	"path/filepath"
	"testing"
)

// A tarball that ends early (a download cut short, a disk that filled) leaves no site that looks
// unpacked: run.json comes first in a packed site, so it would be there.
func TestAnUnpackCutShortIsNotTakenForASite(t *testing.T) {
	cacheHome(t)
	whole := tarOf(t, map[string]string{"run.json": "{}"})
	more := tarOf(t, map[string]string{"system/state.bin.zst": "state that never arrives"})
	// run.json, then the start of a header the archive never finishes
	cut := append(whole[:len(whole)-1024], more[:100]...)
	file := filepath.Join(t.TempDir(), "site.tar")
	os.WriteFile(file, cut, 0o644)

	if _, err := Unpack(file); err == nil {
		t.Fatal("a cut tarball unpacked")
	}
	if dir, err := Unpack(file); err == nil {
		t.Fatalf("the second try took the half-unpacked %s for the site", dir)
	}
}

// Unpacked, a site is readable by others as it was before: a container runs it as nobody.
func TestAnUnpackedSiteIsReadableByOthers(t *testing.T) {
	cacheHome(t)
	file := filepath.Join(t.TempDir(), "site.tar")
	os.WriteFile(file, tarOf(t, map[string]string{"run.json": "{}"}), 0o644)
	dir, err := Unpack(file)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(dir); err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("%v %v", st.Mode(), err)
	}
}
