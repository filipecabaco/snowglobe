package ui

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
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

// The vendored ghostty-web is the release it says it is (ghostty-web 0.4.0 from npm; its
// WebAssembly is inline in ghostty-web.js, loaded from a data: URL)
func TestVendoredGhosttyWebIsPinned(t *testing.T) {
	for name, want := range map[string]string{
		"ghostty-web.js":  "078b3fe37e4ef469d3f3d7772ee263070f8613e5a6f5ff305c85778907f45e72",
		"__vite-browser-external-2447137e.js": "f8c456031e5001c0cda4837cd9ee3a33d79beeba120ec633ec9d990632fb2aa6",
	} {
		data, err := os.ReadFile(filepath.Join("static", "vendor", "ghostty-web", name))
		if err != nil {
			t.Fatal(err)
		}
		if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != want {
			t.Errorf("%s changed: %x", name, sum)
		}
	}
}
