package pack

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An --out pack refuses is left as it was, and a pack that fails leaves no half-written archive.
func TestAPackThatFailsLeavesItsOutputAlone(t *testing.T) {
	site := filepath.Join(t.TempDir(), "demo")
	write(t, filepath.Join(site, "run.json"), `{}`)
	notes := filepath.Join(t.TempDir(), "notes.txt")
	write(t, notes, "my notes")
	if _, err := Run(site, notes); err == nil {
		t.Fatal("packed into a .txt")
	}
	if got, _ := os.ReadFile(notes); string(got) != "my notes" {
		t.Fatalf("the file was overwritten: %q", got)
	}

	// Pooled, with a blob the pool doesn't have
	write(t, filepath.Join(site, "system", "filesystem.json"), filesystem)
	archive := filepath.Join(t.TempDir(), "demo.tar.gz")
	if _, err := Run(site, archive); err == nil {
		t.Fatal("packed a site missing its blobs")
	}
	if _, err := os.Stat(archive); err == nil {
		t.Error("a half-written archive was left")
	}
}

// An archive inside the site it packs would be read into itself as it is written: refused.
func TestAPackIntoItsOwnSiteIsRefused(t *testing.T) {
	site := filepath.Join(t.TempDir(), "demo")
	write(t, filepath.Join(site, "run.json"), `{}`)
	write(t, filepath.Join(site, "system", "filesystem", "aaaaaaaaaa.bin.zst"), "A")
	for _, out := range []string{filepath.Join(site, "demo.tar.gz"), filepath.Join(site, "system", "x.tar")} {
		if _, err := Run(site, out); err == nil || !strings.Contains(err.Error(), "inside the site") {
			t.Errorf("%s: got %v", out, err)
		}
		if _, err := os.Stat(out); err == nil {
			t.Errorf("%s was written", out)
		}
	}
	// Next to it is fine
	if _, err := Run(site, site+".tar.gz"); err != nil {
		t.Error(err)
	}
}
