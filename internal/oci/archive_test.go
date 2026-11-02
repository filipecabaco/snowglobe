package oci

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tarOf is a tar holding these files, in order.
func tarOf(t *testing.T, files ...File) []byte {
	t.Helper()
	r, err := FilesLayer(files)()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func gzipped(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func jsonOf(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// flattened is the image's filesystem: each regular file's contents by path.
func flattened(t *testing.T, img *Image) map[string]string {
	t.Helper()
	var out bytes.Buffer
	if err := Flatten(img.Layers, t.TempDir(), &out); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	tr := tar.NewReader(&out)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return files
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			data, _ := io.ReadAll(tr)
			files[h.Name] = string(data)
		}
	}
}

const config = `{"architecture": "arm64", "config": {"Env": ["A=1"], "WorkingDir": "/app", "Cmd": ["sh"],
	"Labels": {"snowglobe.ready": "$ "}}}`

// `docker save`, streamed as the Docker builder reads it: layers plain or compressed, the newer
// one winning
func TestFromTarReadsADockerSave(t *testing.T) {
	archive := tarOf(t,
		File{Name: "manifest.json", Mode: 0o644, Data: []byte(`[{"Config": "cfg.json", "Layers": ["a/layer.tar", "b/layer.tar"]}]`)},
		File{Name: "cfg.json", Mode: 0o644, Data: []byte(config)},
		File{Name: "a/layer.tar", Mode: 0o644, Data: tarOf(t,
			File{Name: "etc/hostname", Mode: 0o644, Data: []byte("old")},
			File{Name: "bin/app", Mode: 0o755, Data: []byte("app")})},
		File{Name: "b/layer.tar", Mode: 0o644, Data: gzipped(t, tarOf(t,
			File{Name: "etc/hostname", Mode: 0o644, Data: []byte("new")}))},
	)
	img, err := FromTar(bytes.NewReader(archive), "saved", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := img.Config
	if c.Architecture != "arm64" || c.Config.WorkingDir != "/app" || c.Config.Env[0] != "A=1" ||
		c.Config.Cmd[0] != "sh" || c.Config.Labels["snowglobe.ready"] != "$ " {
		t.Fatalf("config: %+v", c)
	}
	files := flattened(t, img)
	if files["etc/hostname"] != "new" || files["bin/app"] != "app" {
		t.Fatalf("files: %v", files)
	}
}

// An OCI layout in a .tar.gz, its index listing an image per platform: the arm64 one is taken
func TestFromArchiveReadsAnOCILayoutAndPicksArm64(t *testing.T) {
	var files []File
	blob := func(data []byte) string {
		sum := sha256.Sum256(data)
		digest := "sha256:" + hex.EncodeToString(sum[:])
		files = append(files, File{Name: "blobs/sha256/" + hex.EncodeToString(sum[:]), Mode: 0o644, Data: data})
		return digest
	}
	image := func(arch, content string) string {
		layer := gzipped(t, tarOf(t, File{Name: "which", Mode: 0o644, Data: []byte(content)}))
		cfg := strings.Replace(config, "arm64", arch, 1)
		return blob(jsonOf(t, map[string]any{
			"config": map[string]any{"digest": blob([]byte(cfg))},
			"layers": []any{map[string]any{"digest": blob(layer), "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip"}},
		}))
	}
	amd, arm := image("amd64", "amd64"), image("arm64", "arm64")
	platform := func(digest, arch string) map[string]any {
		return map[string]any{"digest": digest, "platform": map[string]string{"os": "linux", "architecture": arch}}
	}
	index := blob(jsonOf(t, map[string]any{"manifests": []any{platform(amd, "amd64"), platform(arm, "arm64")}}))
	files = append(files, File{Name: "index.json", Mode: 0o644, Data: jsonOf(t, map[string]any{
		"manifests": []any{map[string]any{"digest": index}},
	})})

	path := filepath.Join(t.TempDir(), "layout.tar.gz")
	if err := os.WriteFile(path, gzipped(t, tarOf(t, files...)), 0o644); err != nil {
		t.Fatal(err)
	}
	img, err := FromArchive(path, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if img.Config.Architecture != "arm64" || flattened(t, img)["which"] != "arm64" {
		t.Fatalf("took %s, which=%q", img.Config.Architecture, flattened(t, img)["which"])
	}
}

func TestFromTarRejectsWhatIsNoImage(t *testing.T) {
	for name, archive := range map[string][]byte{
		"no manifest or index": tarOf(t, File{Name: "readme", Mode: 0o644, Data: []byte("hi")}),
		"an empty manifest":    tarOf(t, File{Name: "manifest.json", Mode: 0o644, Data: []byte(`[]`)}),
	} {
		if _, err := FromTar(bytes.NewReader(archive), name, t.TempDir()); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
