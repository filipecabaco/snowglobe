package rootfs

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Two warms of one site at once (two `snowglobe warm` runs) both succeed and leave a whole pack.
func TestExtendsOfOnePackAtOnceLeaveAWholeOne(t *testing.T) {
	system := t.TempDir()
	blobs := filepath.Join(system, "filesystem")
	os.MkdirAll(blobs, 0o755)
	fs := `{"version":3,"size":3,"fsroot":[["a",3,0,33188,0,0,"aaaaaaaaaa.bin.zst"]]}`
	os.WriteFile(filepath.Join(system, "filesystem.json"), []byte(fs), 0o644)
	os.WriteFile(filepath.Join(blobs, "aaaaaaaaaa.bin.zst"), make([]byte, 1<<20), 0o644)

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _, err := ExtendWarmPack(system, blobs, []string{"aaaaaaaaaa.bin.zst"})
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
	entries, data, err := ReadWarmPack(filepath.Join(system, "warm.pack"))
	if err != nil || len(entries) != 1 || len(data[0]) != 1<<20 {
		t.Fatalf("%d entries, %v", len(entries), err)
	}
	if left, _ := filepath.Glob(filepath.Join(system, "warm.pack.tmp*")); len(left) != 0 {
		t.Errorf("left %v", left)
	}
}
