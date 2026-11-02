package pool

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// Blobs are named by a short hash: two sites with a blob of one name but different contents (a
// collision, rare but not impossible across many sites) must not share one, or one site reads
// the other's file.
func TestBlobsOfOneNameButOtherContentsAreNotPooled(t *testing.T) {
	root := t.TempDir()
	site(t, root, "a")
	site(t, root, "b")
	os.WriteFile(filepath.Join(root, "a", "system", "filesystem", "0a1b2c3d4e.bin.zst"), []byte("a's file"), 0o644)
	os.WriteFile(filepath.Join(root, "b", "system", "filesystem", "0a1b2c3d4e.bin.zst"), []byte("b's file"), 0o644)
	if _, err := Run(root); err == nil {
		got, _ := os.ReadFile(filepath.Join(root, "blobs", "0a1b2c3d4e.bin.zst"))
		t.Fatalf("pooled both as %q", got)
	}
}

// The same file compressed differently (by another snowglobe) is still the same blob.
func TestTheSameFileCompressedDifferentlyIsPooled(t *testing.T) {
	root := t.TempDir()
	site(t, root, "a")
	site(t, root, "b")
	content := bytes.Repeat([]byte("the same file "), 100)
	for name, level := range map[string]zstd.EncoderLevel{"a": zstd.SpeedFastest, "b": zstd.SpeedBestCompression} {
		enc, _ := zstd.NewWriter(nil, zstd.WithEncoderLevel(level))
		os.WriteFile(filepath.Join(root, name, "system", "filesystem", "0a1b2c3d4e.bin.zst"), enc.EncodeAll(content, nil), 0o644)
		enc.Close()
	}
	if stats, err := Run(root); err != nil || stats.Unique != 1 || stats.Files != 2 {
		t.Fatalf("%+v %v", stats, err)
	}
}
