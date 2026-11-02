package oci

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// An archive names its own config and layers: a name that climbs out of the directory it was
// unpacked in must not pull a file from elsewhere on this machine into the image.
func TestAnArchiveCantNameFilesOutsideItself(t *testing.T) {
	root := t.TempDir()
	secret := tarOf(t, File{Name: "home/me/.ssh/id_ed25519", Mode: 0o600, Data: []byte("private key")})
	os.WriteFile(filepath.Join(root, "secret.tar"), secret, 0o600)
	os.WriteFile(filepath.Join(root, "secret.json"), []byte(config), 0o600)
	dir := filepath.Join(root, "archive")

	saved := tarOf(t,
		File{Name: "manifest.json", Mode: 0o644, Data: []byte(`[{"Config": "../secret.json", "Layers": ["../secret.tar"]}]`)},
	)
	img, err := FromTar(bytes.NewReader(saved), "evil.tar", dir)
	if err == nil {
		if files := flattened(t, img); files["home/me/.ssh/id_ed25519"] != "" {
			t.Fatal("a file outside the archive became a layer")
		}
	}

	layout := tarOf(t,
		File{Name: "index.json", Mode: 0o644, Data: []byte(`{"manifests":[{"digest":"sha256:../../../secret.json"}]}`)},
	)
	if _, err := FromTar(bytes.NewReader(layout), "evil.tar", filepath.Join(root, "layout")); err == nil {
		t.Fatal("an index pointing outside the archive was read")
	}
}

// An index that lists itself (or a longer cycle) is an error, not a build that never ends.
func TestAnIndexThatListsItselfEnds(t *testing.T) {
	self := []byte(`{"manifests":[{"digest":"sha256:loop"}]}`)
	layout := tarOf(t,
		File{Name: "index.json", Mode: 0o644, Data: self},
		File{Name: "blobs/sha256/loop", Mode: 0o644, Data: self},
	)
	done := make(chan error, 1)
	go func() {
		_, err := FromTar(bytes.NewReader(layout), "loop.tar", t.TempDir())
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "loop.tar") {
			t.Errorf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("still following the index")
	}
}
