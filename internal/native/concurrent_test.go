package native

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// Two snowglobe processes starting at once on a fresh machine both fetch the runtime into the one
// cache path: each lands whole, never one's half-written copy kept as the runtime.
func TestExtractsOfOneRuntimeAtOnceEachLandWhole(t *testing.T) {
	body := bytes.Repeat([]byte("snowglobe-vm "), 1<<17)
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "x/snowglobe-vm", Mode: 0o755, Size: int64(len(body))})
	tw.Write(body)
	tw.Close()
	gz.Close()
	dest := filepath.Join(t.TempDir(), "rt", "snowglobe-vm")
	for round := 0; round < 5; round++ {
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs <- Extract(bytes.NewReader(archive.Bytes()), "x/snowglobe-vm", dest)
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		if got, _ := os.ReadFile(dest); !bytes.Equal(got, body) {
			t.Fatalf("round %d: %d bytes, not the runtime", round, len(got))
		}
	}
}

// So for the tools image's runtime, copied out by Docker into the cache.
func TestToolsImageCopiesAtOnceEachLandWhole(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SNOWGLOBE_VM", "")
	body := bytes.Repeat([]byte("vm"), 1<<18)
	img := &Image{Key: "k", Extract: func(dest string) error {
		f, err := os.Create(dest)
		if err != nil {
			return err
		}
		defer f.Close()
		for i := 0; i < len(body); i += 1 << 12 {
			if _, err := f.Write(body[i : i+1<<12]); err != nil {
				return err
			}
		}
		return nil
	}}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	paths := make(chan string, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, err := For("dev", "linux", runtime.GOARCH, img)
			errs <- err
			paths <- p
		}()
	}
	wg.Wait()
	close(errs)
	close(paths)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	p := <-paths
	if got, _ := os.ReadFile(p); !bytes.Equal(got, body) {
		t.Fatalf("%d bytes, not the runtime", len(got))
	}
}
