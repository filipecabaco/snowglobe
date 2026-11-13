package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// fakeProvider answers the routes snowglobe provide uses, as a provider would: a context taken, a
// build that is done once its log has been read, and its artifact.
type fakeProvider struct {
	mu       sync.Mutex
	builds   []daemon.BuildRequest
	contexts int
	artifact []byte
	logRead  bool
}

func (f *fakeProvider) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer 0123456789abcdef" {
				http.Error(w, `{"error":"a token is needed"}`, 401)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("POST /v1/contexts", auth(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.contexts++
		f.mu.Unlock()
		if r.URL.Query().Get("format") != "zst" || len(data) == 0 {
			http.Error(w, `{"error":"bad context"}`, 400)
			return
		}
		json.NewEncoder(w).Encode(daemon.ContextUpload{Context: "ctx-abcdef", Digest: "sha256:00", Files: 2, Bytes: 20})
	}))
	mux.HandleFunc("POST /v1/builds", auth(func(w http.ResponseWriter, r *http.Request) {
		var req daemon.BuildRequest
		json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.builds = append(f.builds, req)
		cached := len(f.builds) > 1
		f.mu.Unlock()
		b := daemon.Build{ID: "build-1", Name: req.Name, Status: "queued"}
		if cached {
			b.Status, b.Cached = "done", true
			b.Ended = &b.Created
		}
		json.NewEncoder(w).Encode(b)
	}))
	mux.HandleFunc("GET /v1/builds/build-1/log", auth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("follow") != "1" {
			t.Error("the log not followed")
		}
		f.mu.Lock()
		f.logRead = true
		f.mu.Unlock()
		io.WriteString(w, "==> building\n==> packed\n")
	}))
	mux.HandleFunc("GET /v1/builds/build-1", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		done := f.logRead
		f.mu.Unlock()
		b := daemon.Build{ID: "build-1", Status: "running"}
		if done {
			b.Status = "done"
		}
		json.NewEncoder(w).Encode(b)
	}))
	mux.HandleFunc("GET /v1/builds/build-1/artifact", auth(func(w http.ResponseWriter, r *http.Request) {
		sum := sha256.Sum256(f.artifact)
		w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
		w.Write(f.artifact)
	}))
	return mux
}

func TestProvideBuildsOnTheDaemonAndDownloadsTheSite(t *testing.T) {
	isolated(t)
	f := &fakeProvider{artifact: []byte("a packed site")}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	t.Setenv("SNOWGLOBE_DAEMON", srv.URL)
	t.Setenv("SNOWGLOBE_DAEMON_TOKEN", "0123456789abcdef")
	dir := filepath.Join(t.TempDir(), "my app")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine\n"), 0o644)
	out := filepath.Join(t.TempDir(), "site.tar.zst")
	code, stdout, stderr := cli(t, "provide", dir, "--kernel", "linux", "--network", "fetch", "--cpus", "2", "-o", out)
	sum := sha256.Sum256(f.artifact)
	if code != 0 || stdout != out+": 0.0 MB, sha256 "+hex.EncodeToString(sum[:])+"\n" || !strings.Contains(stderr, "==> packed") {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	if data, _ := os.ReadFile(out); string(data) != "a packed site" {
		t.Errorf("downloaded %q", data)
	}
	req := f.builds[0]
	if f.contexts != 1 || req.Context != "ctx-abcdef" || !req.Artifact || !req.NoTemplate || req.Kernel != "linux" || req.Network != "fetch" || req.CPUs != 2 || req.Name != "my-app" {
		t.Errorf("asked for %+v", req)
	}
	// Again: built already, no log to wait for; an image as it is, a .tar.gz asked for
	code, _, stderr = cli(t, "provide", "ghcr.io/o/app:1.2", "-o", filepath.Join(t.TempDir(), "s.tar.gz"))
	if code != 0 || !strings.Contains(stderr, "built already") || f.builds[1].Source != "ghcr.io/o/app:1.2" || f.builds[1].Name != "app-1-2" || f.builds[1].Kernel != "" {
		t.Errorf("%d %q %+v", code, stderr, f.builds[1])
	}
	// A Dockerfile is sent as it is
	cli(t, "provide", filepath.Join(dir, "Dockerfile"), "-o", filepath.Join(t.TempDir(), "df.tar.zst"))
	if f.builds[2].Dockerfile != "FROM alpine\n" || f.builds[2].Context != "" {
		t.Errorf("%+v", f.builds[2])
	}
	// A download that isn't what the daemon says it is: refused, and no file
	f.artifact = []byte("x")
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/artifact") {
			w.Header().Set("ETag", `"0000"`)
			w.Write(f.artifact)
			return
		}
		f.handler(t).ServeHTTP(w, r)
	})
	bad := filepath.Join(t.TempDir(), "bad.tar.zst")
	if code, _, stderr := cli(t, "provide", "alpine", "-o", bad); code != 1 || !strings.Contains(stderr, "hashes to") {
		t.Errorf("%d %q", code, stderr)
	}
	if _, err := os.Stat(bad); !os.IsNotExist(err) {
		t.Errorf("a bad download kept: %v", err)
	}
}
