package bundle

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Two bundles of one site to one path at once (two CI jobs, say) each land whole and executable.
func TestBundlesToOnePathAtOnceEachLandWhole(t *testing.T) {
	dir := t.TempDir()
	site := filepath.Join(dir, "site")
	os.MkdirAll(filepath.Join(site, "system", "filesystem"), 0o755)
	os.WriteFile(filepath.Join(site, "run.json"), []byte(`{}`), 0o644)
	os.WriteFile(filepath.Join(site, "system", "state.bin.zst"), bytes.Repeat([]byte("s"), 1<<20), 0o644)
	os.WriteFile(filepath.Join(site, "system", "filesystem.json"), []byte(`{"fsroot":[]}`), 0o644)
	runtime := filepath.Join(dir, "vm")
	os.WriteFile(runtime, []byte("#!runtime"), 0o755)
	out := filepath.Join(dir, "app")

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := Write(site, runtime, out)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(out)
	if _, err := Read(data); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(out); st.Mode().Perm() != 0o755 {
		t.Errorf("mode %v", st.Mode())
	}
	if left, _ := filepath.Glob(out + ".tmp*"); len(left) != 0 {
		t.Errorf("left %v", left)
	}
}
