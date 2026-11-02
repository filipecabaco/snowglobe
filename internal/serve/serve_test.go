package serve

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlerServesTheSiteAsFiles(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>site</h1>"), 0o644)
	os.MkdirAll(filepath.Join(dir, "system"), 0o755)
	os.WriteFile(filepath.Join(dir, "system", "run.json"), []byte(`{}`), 0o644)
	h, err := Handler(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	for path, want := range map[string]string{"/": "<h1>site</h1>", "/system/run.json": "{}"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || string(body) != want {
			t.Errorf("%s: %s %q", path, resp.Status, body)
		}
	}
	resp, err := http.Get(srv.URL + "/missing")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("a missing file: %s", resp.Status)
	}
}

func TestADirectoryWithoutASiteIsRefused(t *testing.T) {
	dir := t.TempDir()
	if _, err := Handler(dir); err == nil || !strings.Contains(err.Error(), "run snowglobe build first") {
		t.Fatalf("got %v", err)
	}
	if err := Run(dir, 0); err == nil {
		t.Fatal("served a directory with no site")
	}
}
