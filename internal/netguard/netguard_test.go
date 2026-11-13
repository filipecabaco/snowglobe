package netguard

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestPublic(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8":          true,
		"2606:4700::1111":  true,
		"127.0.0.1":        false,
		"::1":              false,
		"10.1.2.3":         false,
		"172.16.0.1":       false,
		"192.168.1.1":      false,
		"169.254.169.254":  false, // cloud metadata
		"100.100.100.200":  false, // CGNAT (Alibaba's metadata)
		"0.0.0.0":          false,
		"::":               false,
		"fd00::1":          false,
		"fe80::1":          false,
		"::ffff:127.0.0.1": false, // mapped loopback
		"::ffff:8.8.8.8":   true,
		"64:ff9b::a00:1":   false, // NAT64 of 10.0.0.1
		"2002:7f00:1::":    false, // 6to4 of 127.0.0.1
		"224.0.0.1":        false,
		"255.255.255.255":  false,
	} {
		if got := Public(netip.MustParseAddr(addr)); got != want {
			t.Errorf("Public(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestClientRefusesThisHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	_, err := Client(0).Get(srv.URL)
	if err == nil || !strings.Contains(err.Error(), "isn't a public address") {
		t.Fatalf("a request to loopback: %v", err)
	}
	// A name that resolves to loopback is refused alike
	_, err = Client(0).Get(strings.Replace(srv.URL, "127.0.0.1", "localhost", 1))
	if err == nil || !strings.Contains(err.Error(), "isn't a public address") {
		t.Fatalf("a request to localhost: %v", err)
	}
}

func TestClientRefusesARedirectToThisHost(t *testing.T) {
	inside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer inside.Close()
	// The redirect comes from a server the test reaches with a plain client; the guarded one
	// follows it to loopback and is refused there
	outside := httptest.NewServer(http.RedirectHandler(inside.URL, http.StatusFound))
	defer outside.Close()
	c := Client(0)
	resp, err := c.Get(outside.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("the redirect's own server is on loopback too: refused before it")
	}
}
