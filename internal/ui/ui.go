// Package ui serves snowglobe's orchestration UI (`snowglobe ui`): the daemon's templates,
// machines, services, snapshots, builds and metrics in a browser, with a terminal on machines.
//
// It listens on 127.0.0.1 only and forwards /api/ to the daemon's API. Since any page the user
// visits could send requests to it, every request must bear the session token (handed over once
// in the URL `snowglobe ui` opens, then kept in an HttpOnly, SameSite=Strict cookie), name
// localhost as its Host (so a DNS-rebound name is refused), and, for anything that changes state
// or opens a WebSocket, come from this origin.
package ui

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"io/fs"
	"net"
	"net/http"
	"strings"
)

//go:embed static
var static embed.FS

// cookie holds the session token.
const cookie = "snowglobe_ui"

// Server is the UI of one daemon.
type Server struct {
	// API is the daemon's API (daemon.Client.Proxy)
	API http.Handler
	// Token is what a browser must present; NewToken makes one
	Token string
}

// NewToken is a fresh random session token.
func NewToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Handler serves the UI and, under /api/, the daemon's API.
func (s *Server) Handler() http.Handler {
	files, _ := fs.Sub(static, "static")
	assets := http.FileServerFS(files)
	mux := http.NewServeMux()
	mux.Handle("/api/", http.StripPrefix("/api", s.API))
	mux.Handle("/", assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "+
			"img-src 'self' data:; font-src 'self'; connect-src 'self' data: ws://"+r.Host+"; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if !localHost(r.Host) {
			http.Error(w, "snowglobe ui answers only on localhost", http.StatusForbidden)
			return
		}
		// The link snowglobe ui opened: its token becomes the session's cookie
		if t := r.URL.Query().Get("token"); t != "" && r.URL.Path == "/" {
			if !s.valid(t) {
				http.Error(w, "this link is not this session's: open the one snowglobe ui printed", http.StatusUnauthorized)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: cookie, Value: s.Token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		c, err := r.Cookie(cookie)
		if err != nil || !s.valid(c.Value) {
			http.Error(w, "open the link snowglobe ui printed (it carries this session's token)", http.StatusUnauthorized)
			return
		}
		if (r.Method != http.MethodGet && r.Method != http.MethodHead || isWebSocket(r)) && !sameOrigin(r) {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) valid(t string) bool {
	return s.Token != "" && subtle.ConstantTimeCompare([]byte(t), []byte(s.Token)) == 1
}

// localHost says whether a Host header names this machine's loopback.
func localHost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

func isWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// sameOrigin says whether a request comes from a page of this server: its Origin (which browsers
// send on these) names this host.
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	return o == "http://"+r.Host
}
