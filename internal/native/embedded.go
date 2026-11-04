package native

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"
)

// embeddedVM is this build's own snowglobe-vm (zstd), for the system it was built for: release
// builds carry it (go build -tags embedvm, with embedded/snowglobe-vm.zst in place), so that one
// file is all snowglobe needs. Other builds have none and find one as before.
var embeddedVM []byte

// Embedded says whether this snowglobe carries its own snowglobe-vm.
func Embedded() bool { return len(embeddedVM) > 0 }

// fromEmbedded writes the carried snowglobe-vm into the user cache, once (named by its hash, so a
// new snowglobe never runs an old one), and returns its path.
func fromEmbedded() (string, error) {
	sum := sha256.Sum256(embeddedVM)
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dest := filepath.Join(cache, "snowglobe", "runtime", "embedded-"+hex.EncodeToString(sum[:8]), "snowglobe-vm")
	if fi, err := os.Stat(dest); err == nil && fi.Mode()&0o111 != 0 {
		return dest, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	dec, err := zstd.NewReader(bytes.NewReader(embeddedVM))
	if err != nil {
		return "", err
	}
	defer dec.Close()
	return dest, writeAtomically(dest, 0o755, dec)
}
