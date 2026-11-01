package oci

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"testing"
)

func TestParseRef(t *testing.T) {
	for in, want := range map[string]Ref{
		"alpine":                       {"registry-1.docker.io", "library/alpine", "latest"},
		"alpine:3.24.2":                {"registry-1.docker.io", "library/alpine", "3.24.2"},
		"user/app:v1":                  {"registry-1.docker.io", "user/app", "v1"},
		"docker.io/library/alpine":     {"registry-1.docker.io", "library/alpine", "latest"},
		"ghcr.io/o/r:tag":              {"ghcr.io", "o/r", "tag"},
		"localhost:5000/app":           {"localhost:5000", "app", "latest"},
		"ghcr.io/o/r@sha256:abc":       {"ghcr.io", "o/r", "sha256:abc"},
		"registry.example.com:443/a/b": {"registry.example.com:443", "a/b", "latest"},
	} {
		got, err := ParseRef(in)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v; want %+v", in, got, err, want)
		}
	}
}

func layer(entries ...File) Layer { return FilesLayer(entries) }

func TestFlattenAppliesWhiteoutsAndOpaqueDirs(t *testing.T) {
	base := layer(
		File{Name: "etc", Dir: true, Mode: 0o755},
		File{Name: "etc/keep", Data: []byte("kept"), Mode: 0o644},
		File{Name: "etc/gone", Data: []byte("x"), Mode: 0o644},
		File{Name: "opt/old/a", Data: []byte("a"), Mode: 0o644},
		File{Name: "opt/old/b", Data: []byte("b"), Mode: 0o644},
		File{Name: "bin/sh", Linkname: "busybox"},
	)
	top := layer(
		File{Name: "etc/.wh.gone"},
		File{Name: "opt/old/.wh..wh..opq"},
		File{Name: "opt/old/new", Data: []byte("new"), Mode: 0o644},
		File{Name: "etc/keep", Data: []byte("replaced"), Mode: 0o600},
	)
	var out bytes.Buffer
	if err := Flatten([]Layer{base, top}, t.TempDir(), &out); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	tr := tar.NewReader(&out)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(tr)
		got[h.Name] = string(data) + h.Linkname
	}
	want := map[string]string{
		"etc/": "", "etc/keep": "replaced", "opt/": "", "opt/old/": "", "opt/old/new": "new",
		"bin/": "", "bin/sh": "busybox",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: got %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

// SNOWGLOBE_LIVE_PULL=alpine:3.24.2 pulls and flattens a real image and writes it to $SNOWGLOBE_LIVE_OUT.
func TestPullLive(t *testing.T) {
	ref := os.Getenv("SNOWGLOBE_LIVE_PULL")
	if ref == "" {
		t.Skip("set SNOWGLOBE_LIVE_PULL to pull a real image")
	}
	img, err := Pull(ref)
	if err != nil {
		t.Fatal(err)
	}
	if img.Config.Architecture != "arm64" {
		t.Fatalf("architecture %s", img.Config.Architecture)
	}
	out, err := os.Create(os.Getenv("SNOWGLOBE_LIVE_OUT"))
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	if err := Flatten(img.Layers, t.TempDir(), out); err != nil {
		t.Fatal(err)
	}
	t.Logf("%s: %d layers, cmd %v", ref, len(img.Layers), img.Config.Config.Cmd)
}
