// Package tunnel reads the guest TCP destinations a site carries elsewhere: each connection the
// guest opens to one becomes a WebSocket to its ws:// or wss:// URL, the stream's bytes sent as
// binary messages (what websockify, websocat and Neon's wsproxy speak), or, natively only, a TCP
// connection to its tcp://HOST:PORT (another machine's forwarded port, say; a page can't open
// one). armless does the carrying, in the page and in snowglobe-vm alike; this is the same
// [HOST:]PORT=URL spec its Tunnel::parse reads.
package tunnel

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/netguard"
)

// Tunnel is one destination: Host empty for any name on Port. The JSON is what armless.js
// takes as network.tunnels.
type Tunnel struct {
	Host string `json:"host,omitempty"`
	Port int    `json:"port"`
	URL  string `json:"url"`
}

// Parse reads "[HOST:]PORT=URL", e.g. "db.internal:5432=wss://proxy.example.com/db".
func Parse(spec string) (Tunnel, error) {
	bad := fmt.Errorf("tunnel %q: use [HOST:]PORT=ws://..., wss://... or tcp://HOST:PORT", spec)
	dest, url, ok := strings.Cut(spec, "=")
	if !ok || !(strings.HasPrefix(url, "ws://") || strings.HasPrefix(url, "wss://") || tcpAddress(url)) {
		return Tunnel{}, bad
	}
	t := Tunnel{URL: url}
	port := dest
	if i := strings.LastIndex(dest, ":"); i >= 0 {
		if i == 0 {
			return Tunnel{}, bad
		}
		t.Host, port = strings.ToLower(dest[:i]), dest[i+1:]
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return Tunnel{}, bad
	}
	t.Port = n
	return t, nil
}

// tcpAddress says whether url is tcp://HOST:PORT.
func tcpAddress(url string) bool {
	addr, ok := strings.CutPrefix(url, "tcp://")
	if !ok {
		return false
	}
	i := strings.LastIndex(addr, ":")
	if i <= 0 {
		return false
	}
	n, err := strconv.Atoi(addr[i+1:])
	return err == nil && n >= 1 && n <= 65535
}

// ParseAll reads several specs.
func ParseAll(specs []string) ([]Tunnel, error) {
	out := make([]Tunnel, 0, len(specs))
	for _, s := range specs {
		t, err := Parse(s)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// Placeholder is replaced, in a tunnel's URL, by an access token from the site's token
// endpoint: a fresh one per connection in the page, one per run natively. The endpoint
// belongs to a gateway that holds the real credentials, so none is in the page or the guest.
const Placeholder = "{token}"

// NeedsToken says whether any of the tunnels wants a token.
func NeedsToken(tunnels []Tunnel) bool {
	for _, t := range tunnels {
		if strings.Contains(t.URL, Placeholder) {
			return true
		}
	}
	return false
}

// Fill replaces the placeholder with one token from tokenURL (a GET answering with the token
// as plain text), for hosts that open tunnels without a page: the build's snapshot and
// `snowglobe run`. public: the endpoint is the site's own (one downloaded, say), not one the user
// gave, so it may only be on a public address.
func Fill(tunnels []Tunnel, tokenURL string, public bool) ([]Tunnel, error) {
	if !NeedsToken(tunnels) {
		return tunnels, nil
	}
	if tokenURL == "" {
		return nil, fmt.Errorf("a tunnel URL has %s but there's no token endpoint: pass --tunnel-token", Placeholder)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	if public {
		client = netguard.Client(15 * time.Second)
	}
	resp, err := client.Get(tokenURL)
	if err != nil {
		return nil, fmt.Errorf("tunnel token: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tunnel token from %s: %s", tokenURL, resp.Status)
	}
	token := url.QueryEscape(strings.TrimSpace(string(body)))
	out := make([]Tunnel, len(tunnels))
	for i, t := range tunnels {
		t.URL = strings.ReplaceAll(t.URL, Placeholder, token)
		out[i] = t
	}
	return out, nil
}
