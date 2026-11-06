package ui

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// packed/ is static/ as pack.go writes it: nothing missing, nothing stale, nothing extra
func TestPackedIsStaticPacked(t *testing.T) {
	want := map[string]bool{}
	filepath.WalkDir("static", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		name := filepath.ToSlash(strings.TrimPrefix(path, "static"+string(filepath.Separator)))
		src, _ := os.ReadFile(path)
		packedName := name + ".gz"
		if strings.HasSuffix(name, ".woff2") {
			packedName = name
		}
		want[packedName] = true
		data, err := fs.ReadFile(packed, "packed/"+packedName)
		if err != nil {
			t.Errorf("%s isn't packed: run go generate ./internal/ui", name)
			return nil
		}
		if strings.HasSuffix(packedName, ".gz") {
			zr, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			data, _ = io.ReadAll(zr)
		}
		if !bytes.Equal(data, src) {
			t.Errorf("packed/%s is stale: run go generate ./internal/ui", packedName)
		}
		return nil
	})
	fs.WalkDir(packed, "packed", func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !want[strings.TrimPrefix(path, "packed/")] {
			t.Errorf("%s is in packed/ but not static/: run go generate ./internal/ui", path)
		}
		return nil
	})
}

func TestAssetsGoGzippedToBrowsersAndUnpackedToOthers(t *testing.T) {
	s, ts := serve(t)
	get := func(path, enc string) (*http.Response, string) {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		req.Header.Set("Cookie", "snowglobe_ui="+s.Token)
		req.Header.Set("Accept-Encoding", enc)
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp, string(body)
	}
	resp, body := get("/vendor/preact/index.js", "gzip, br")
	if resp.Header.Get("Content-Encoding") != "gzip" || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/javascript") || !strings.HasPrefix(body, "\x1f\x8b") {
		t.Errorf("gzip: %v %.10q", resp.Header, body)
	}
	resp, body = get("/", "identity")
	if resp.Header.Get("Content-Encoding") != "" || !strings.Contains(body, "<html") || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Errorf("unpacked: %v %.40q", resp.Header, body)
	}
	if resp, _ := get("/fonts/Switzer-Variable.woff2", "gzip"); resp.Header.Get("Content-Encoding") != "" || resp.Header.Get("Content-Type") != "font/woff2" {
		t.Errorf("a font: %v", resp.Header)
	}
	if resp, _ := get("/nope.js", "gzip"); resp.StatusCode != 404 {
		t.Errorf("missing: %d", resp.StatusCode)
	}
}
