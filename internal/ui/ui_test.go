package ui

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAPI answers every request with its method and path.
var fakeAPI = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	io.WriteString(w, r.Method+" "+r.URL.Path)
})

func serve(t *testing.T) (*Server, *httptest.Server) {
	s := &Server{API: fakeAPI, Token: NewToken()}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func do(t *testing.T, req *http.Request) (int, string, *http.Response) {
	t.Helper()
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp.StatusCode, string(body), resp
}

func TestTheLinksTokenBecomesACookieAndEveryRequestNeedsIt(t *testing.T) {
	s, ts := serve(t)
	get := func(path string, cookie string) (int, string, *http.Response) {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		if cookie != "" {
			req.Header.Set("Cookie", "snowglobe_ui="+cookie)
		}
		return do(t, req)
	}
	if code, _, _ := get("/", ""); code != 401 {
		t.Errorf("no token: %d", code)
	}
	if code, _, _ := get("/api/v1/stats", ""); code != 401 {
		t.Errorf("the API without a token: %d", code)
	}
	if code, _, _ := get("/?token=nope", ""); code != 401 {
		t.Errorf("a wrong token: %d", code)
	}
	code, _, resp := get("/?token="+s.Token, "")
	if code != 303 || resp.Header.Get("Location") != "/" {
		t.Fatalf("the link: %d %s", code, resp.Header.Get("Location"))
	}
	var set *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "snowglobe_ui" {
			set = c
		}
	}
	if set == nil || set.Value != s.Token || !set.HttpOnly || set.SameSite != http.SameSiteStrictMode {
		t.Fatalf("the cookie: %+v", set)
	}
	if code, body, _ := get("/api/v1/stats", s.Token); code != 200 || body != "GET /v1/stats" {
		t.Errorf("the API with it: %d %q", code, body)
	}
	if code, body, resp := get("/", s.Token); code != 200 || !strings.Contains(body, "<html") {
		t.Errorf("the page: %d %.80q", code, body)
	} else if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") || !strings.Contains(csp, "default-src 'self'") {
		t.Errorf("CSP: %s", csp)
	}
}

func TestOtherHostsAndOriginsAreRefused(t *testing.T) {
	s, ts := serve(t)
	req := func(method, path, host, origin string) int {
		r, _ := http.NewRequest(method, ts.URL+path, strings.NewReader("{}"))
		r.Header.Set("Cookie", "snowglobe_ui="+s.Token)
		if host != "" {
			r.Host = host
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		code, _, _ := do(t, r)
		return code
	}
	self := "http://" + strings.TrimPrefix(ts.URL, "http://")
	// A name rebound to 127.0.0.1 is still not localhost
	if code := req("GET", "/api/v1/stats", "evil.example:80", ""); code != 403 {
		t.Errorf("a rebound host: %d", code)
	}
	if code := req("GET", "/api/v1/stats", "localhost:9", ""); code != 200 {
		t.Errorf("localhost: %d", code)
	}
	if code := req("POST", "/api/v1/machines", "", self); code != 200 {
		t.Errorf("a POST from this page: %d", code)
	}
	if code := req("POST", "/api/v1/machines", "", "https://evil.example"); code != 403 {
		t.Errorf("a POST from another site: %d", code)
	}
	if code := req("DELETE", "/api/v1/machines/m", "", ""); code != 403 {
		t.Errorf("a DELETE with no origin: %d", code)
	}
	r, _ := http.NewRequest("GET", ts.URL+"/api/v1/machines/m/attach", nil)
	r.Header.Set("Cookie", "snowglobe_ui="+s.Token)
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Origin", "https://evil.example")
	if code, _, _ := do(t, r); code != 403 {
		t.Errorf("a WebSocket from another site: %d", code)
	}
}

func TestLocalHost(t *testing.T) {
	for host, want := range map[string]bool{"127.0.0.1:7777": true, "localhost:1": true, "[::1]:8": true, "localhost": true,
		"127.0.0.1.nip.io:7777": false, "evil.example": false, "10.0.0.2:7777": false, "": false} {
		if localHost(host) != want {
			t.Errorf("%q: %v", host, !want)
		}
	}
}

// The vendored libraries are what vendor.json pins (vendor.go took them from npm, checked
// against each tarball's integrity): every file the manifest lists, byte for byte, and nothing
// else under static/vendor
func TestVendoredLibrariesAreTheManifests(t *testing.T) {
	data, err := os.ReadFile("vendor.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Packages []struct {
			Name   string            `json:"name"`
			SHA256 map[string]string `json:"sha256"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{"vendor/preact/index.js": true}
	for _, p := range m.Packages {
		if len(p.SHA256) == 0 {
			t.Errorf("%s: no sha256 in vendor.json (go run vendor.go -update %s)", p.Name, p.Name)
		}
		for name, want := range p.SHA256 {
			listed[name] = true
			data, err := os.ReadFile(filepath.Join("static", name))
			if err != nil {
				t.Error(err)
				continue
			}
			if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != want {
				t.Errorf("static/%s isn't %s's as vendor.json pins it", name, p.Name)
			}
		}
	}
	filepath.WalkDir(filepath.Join("static", "vendor"), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if name := filepath.ToSlash(strings.TrimPrefix(path, "static/")); !listed[name] {
				t.Errorf("static/%s isn't in vendor.json", name)
			}
		}
		return nil
	})
}

// The UI's copies of the site's stylesheet, theme toggle and fonts are the site's own
func TestTheSitesFilesAreTheSame(t *testing.T) {
	for _, name := range []string{"base.css", "theme.js", "fonts/Switzer-Variable.woff2", "fonts/FragmentMono-Regular.woff2"} {
		site, err := os.ReadFile(filepath.Join("..", "..", "site", name))
		if err != nil {
			t.Fatal(err)
		}
		ours, err := os.ReadFile(filepath.Join("static", name))
		if err != nil {
			t.Fatal(err)
		}
		if string(site) != string(ours) {
			t.Errorf("internal/ui/static/%s differs from site/%s: copy it again", name, name)
		}
	}
}
