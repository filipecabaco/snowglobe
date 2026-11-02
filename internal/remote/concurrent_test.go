package remote

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Two snowglobe processes fetching one site share its cache directory: writing the same file at
// once, neither fails nor leaves the other's half-written copy.
func TestWritesOfOneFileAtOnceEachLandWhole(t *testing.T) {
	target := filepath.Join(t.TempDir(), "blob.bin.zst")
	payloads := make([][]byte, 16)
	for i := range payloads {
		payloads[i] = bytes.Repeat([]byte{byte('a' + i)}, 1<<20)
	}
	for round := 0; round < 5; round++ {
		var wg sync.WaitGroup
		errs := make(chan error, len(payloads))
		for _, p := range payloads {
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs <- writeBytes(target, p)
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		got, _ := os.ReadFile(target)
		if len(got) != 1<<20 || !bytes.Equal(got, bytes.Repeat(got[:1], 1<<20)) {
			t.Fatalf("round %d: a mix of writes (%d bytes)", round, len(got))
		}
	}
}
