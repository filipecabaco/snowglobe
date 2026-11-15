package oci

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// registry is a fake registry for one repository: blobs and manifests by digest, tags, and a
// token endpoint it asks for anonymous tokens at, as Docker Hub does.
type registry struct {
	srv       *httptest.Server
	blobs     map[string][]byte // digest -> contents
	manifests map[string][]byte // tag or digest -> manifest
	challenge string            // WWW-Authenticate; "" serves without a token
	tokens    int
}

func newRegistry(t *testing.T) *registry {
	r := &registry{blobs: map[string][]byte{}, manifests: map[string][]byte{}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/token" {
			if req.URL.Query().Get("scope") != "repository:library/alpine:pull" {
				http.Error(w, "bad scope", http.StatusBadRequest)
				return
			}
			r.tokens++
			w.Write([]byte(`{"access_token":"t0k"}`))
			return
		}
		if r.challenge != "" && req.Header.Get("Authorization") != "Bearer t0k" {
			w.Header().Set("WWW-Authenticate", r.challenge)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		repo := "/v2/library/alpine/"
		if ref, ok := strings.CutPrefix(req.URL.Path, repo+"manifests/"); ok && r.manifests[ref] != nil {
			w.Write(r.manifests[ref])
			return
		}
		if digest, ok := strings.CutPrefix(req.URL.Path, repo+"blobs/"); ok && r.blobs[digest] != nil {
			w.Write(r.blobs[digest])
			return
		}
		http.NotFound(w, req)
	}))
	t.Cleanup(r.srv.Close)
	r.challenge = `Bearer realm="` + r.srv.URL + `/token",service="registry",scope="repository:library/alpine:pull"`
	return r
}

func (r *registry) add(data []byte) string {
	sum := sha256.Sum256(data)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	r.blobs[digest] = data
	return digest
}

func (r *registry) client() *client {
	return &client{http: r.srv.Client(), base: r.srv.URL + "/v2/library/alpine"}
}

func zstded(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w, _ := zstd.NewWriter(&b)
	w.Write(data)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// image publishes an arm64 image (and an amd64 one) under tag "3": layers gzipped, zstd and
// plain.
func (r *registry) image(t *testing.T) {
	desc := func(mediaType string, data []byte) map[string]any {
		return map[string]any{"mediaType": mediaType, "digest": r.add(data), "size": len(data)}
	}
	manifest := func(arch string) string {
		cfg := strings.Replace(config, "arm64", arch, 1)
		m := jsonOf(t, map[string]any{
			"config": desc("application/vnd.oci.image.config.v1+json", []byte(cfg)),
			"layers": []any{
				desc("application/vnd.oci.image.layer.v1.tar+gzip", gzipped(t, tarOf(t, File{Name: "etc/os", Mode: 0o644, Data: []byte(arch)}))),
				desc("application/vnd.oci.image.layer.v1.tar+zstd", zstded(t, tarOf(t, File{Name: "bin/app", Mode: 0o755, Data: []byte("app")}))),
				desc("application/vnd.oci.image.layer.v1.tar", tarOf(t, File{Name: "etc/motd", Mode: 0o644, Data: []byte("hi")})),
			},
		})
		digest := r.add(m)
		r.manifests[digest] = m
		return digest
	}
	platform := func(digest, arch string) map[string]any {
		return map[string]any{"digest": digest, "platform": map[string]string{"os": "linux", "architecture": arch}}
	}
	r.manifests["3"] = jsonOf(t, map[string]any{"manifests": []any{
		platform(manifest("amd64"), "amd64"), platform(manifest("arm64"), "arm64")}})
}

func TestPullTakesTheArm64ImageWithAnAnonymousToken(t *testing.T) {
	r := newRegistry(t)
	r.image(t)
	img, err := r.client().pull("alpine:3", "3")
	if err != nil {
		t.Fatal(err)
	}
	if img.Config.Architecture != "arm64" || img.Config.Config.WorkingDir != "/app" {
		t.Fatalf("config %+v", img.Config)
	}
	files := flattened(t, img)
	if files["etc/os"] != "arm64" || files["bin/app"] != "app" || files["etc/motd"] != "hi" {
		t.Fatalf("files %v", files)
	}
	if r.tokens != 1 {
		t.Errorf("asked for %d tokens: one does for the repository", r.tokens)
	}
}

func TestDigestIsWhatATagNamesNow(t *testing.T) {
	r := newRegistry(t)
	r.image(t)
	// No Docker-Content-Digest: the manifest's own hash
	sum := sha256.Sum256(r.manifests["3"])
	want := "sha256:" + hex.EncodeToString(sum[:])
	if d, err := r.client().digest("3"); err != nil || d != want {
		t.Errorf("digest %q %v, want %q", d, err, want)
	}
	// The tag moved: another digest
	r.manifests["3"] = append(r.manifests["3"], ' ')
	if d, _ := r.client().digest("3"); d == want {
		t.Errorf("the same digest for another manifest: %s", d)
	}
	if _, err := r.client().digest("nope"); err == nil {
		t.Error("a digest of no manifest")
	}
	// By digest: no registry asked
	if d, err := Digest("alpine@sha256:abc", nil); err != nil || d != "sha256:abc" {
		t.Errorf("%q %v", d, err)
	}
}

func TestPullFails(t *testing.T) {
	t.Run("no arm64 image", func(t *testing.T) {
		r := newRegistry(t)
		r.image(t)
		r.manifests["3"] = []byte(`{"manifests":[{"digest":"sha256:00","platform":{"os":"linux","architecture":"amd64"}}]}`)
		if _, err := r.client().pull("alpine:3", "3"); err == nil || !strings.Contains(err.Error(), "no linux/arm64 image") {
			t.Errorf("got %v", err)
		}
	})
	t.Run("no such tag", func(t *testing.T) {
		r := newRegistry(t)
		if _, err := r.client().pull("alpine:9", "9"); err == nil || !strings.Contains(err.Error(), "404") {
			t.Errorf("got %v", err)
		}
	})
	t.Run("credentials it can't give", func(t *testing.T) {
		r := newRegistry(t)
		r.challenge = `Basic realm="private"`
		if _, err := r.client().pull("alpine:3", "3"); err == nil || !strings.Contains(err.Error(), "public images only") {
			t.Errorf("got %v", err)
		}
	})
	t.Run("a challenge with no realm", func(t *testing.T) {
		r := newRegistry(t)
		r.challenge = `Bearer service="registry"`
		if _, err := r.client().pull("alpine:3", "3"); err == nil || !strings.Contains(err.Error(), "bad auth challenge") {
			t.Errorf("got %v", err)
		}
	})
	t.Run("a token it isn't given", func(t *testing.T) {
		r := newRegistry(t)
		r.challenge = `Bearer realm="` + r.srv.URL + `/token",scope="repository:other:pull"`
		if _, err := r.client().pull("alpine:3", "3"); err == nil || !strings.Contains(err.Error(), "400") {
			t.Errorf("got %v", err)
		}
	})
	// A layer is checked against its digest once read, compressed or not, even though its tar
	// ends before the blob does
	for _, kind := range []string{"gzip", "plain"} {
		t.Run("a "+kind+" layer that isn't what its digest says", func(t *testing.T) {
			r := newRegistry(t)
			r.challenge = ""
			r.image(t)
			img, err := r.client().pull("alpine:3", "3")
			if err != nil {
				t.Fatal(err)
			}
			evil := tarOf(t, File{Name: "etc/motd", Mode: 0o644, Data: []byte("evil")})
			for digest, data := range r.blobs {
				switch {
				case kind == "gzip" && data[0] == 0x1f && data[1] == 0x8b:
					r.blobs[digest] = gzipped(t, evil)
				case kind == "plain" && bytes.Contains(data, []byte("etc/motd")):
					r.blobs[digest] = evil
				}
			}
			if err := Flatten(img.Layers, t.TempDir(), io.Discard); err == nil || !strings.Contains(err.Error(), "doesn't match its digest") {
				t.Errorf("got %v", err)
			}
		})
	}
}

func TestVerifiedTakesOnlySha256(t *testing.T) {
	if _, err := verified(io.NopCloser(strings.NewReader("x")), "sha512:abc"); err == nil {
		t.Error("a sha512 digest")
	}
	sum := sha256.Sum256([]byte("x"))
	r, err := verified(io.NopCloser(strings.NewReader("x")), "sha256:"+hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	if data, err := io.ReadAll(r); err != nil || string(data) != "x" {
		t.Errorf("got %q, %v", data, err)
	}
}

func TestTarGzLayer(t *testing.T) {
	file := filepath.Join(t.TempDir(), "kernel.tar.gz")
	os.WriteFile(file, gzipped(t, tarOf(t, File{Name: "boot/vmlinuz-virt", Mode: 0o644, Data: []byte("k")})), 0o644)
	files := flattened(t, &Image{Layers: []Layer{TarGzLayer(file)}})
	if files["boot/vmlinuz-virt"] != "k" {
		t.Errorf("got %v", files)
	}
	if _, err := TarGzLayer(filepath.Join(t.TempDir(), "missing.tar.gz"))(); err == nil {
		t.Error("a missing archive")
	}
	notGzip := filepath.Join(t.TempDir(), "x.tar.gz")
	os.WriteFile(notGzip, []byte("plain text, not gzip"), 0o644)
	if _, err := TarGzLayer(notGzip)(); err == nil {
		t.Error("not gzip")
	}
}
