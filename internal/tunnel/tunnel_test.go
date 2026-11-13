package tunnel

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	got, err := Parse("DB.internal:5432=wss://proxy.example.com/db?x=1")
	want := Tunnel{Host: "db.internal", Port: 5432, URL: "wss://proxy.example.com/db?x=1"}
	if err != nil || got != want {
		t.Fatalf("got %+v, %v; want %+v", got, err, want)
	}
	if got, err := Parse("6379=ws://127.0.0.1:7000"); err != nil || got != (Tunnel{Port: 6379, URL: "ws://127.0.0.1:7000"}) {
		t.Fatalf("any host: got %+v, %v", got, err)
	}
	// Natively, another machine's forwarded port
	if got, err := Parse("db.internal:5432=tcp://127.0.0.1:15432"); err != nil || got != (Tunnel{Host: "db.internal", Port: 5432, URL: "tcp://127.0.0.1:15432"}) {
		t.Fatalf("tcp: got %+v, %v", got, err)
	}
	for _, bad := range []string{"5432", "db:5432=tcp://x", "db:5432=tcp://x:0", "db:5432=tcp://:5432", "db:5432=udp://x:1", ":5432=ws://x", "db:0=ws://x", "db:nope=ws://x", "=ws://x"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

func TestFill(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, " a b&c \n") }))
	defer srv.Close()
	in := []Tunnel{{Port: 5432, URL: "wss://gw/db?token={token}"}, {Port: 9000, URL: "wss://gw/s3"}}
	out, err := Fill(in, srv.URL, false)
	if err != nil || out[0].URL != "wss://gw/db?token=a+b%26c" || out[1].URL != "wss://gw/s3" {
		t.Fatalf("got %+v, %v", out, err)
	}
	if in[0].URL != "wss://gw/db?token={token}" {
		t.Error("Fill changed its input")
	}
	if _, err := Fill(in, "", false); err == nil {
		t.Error("a {token} URL without an endpoint is an error")
	}
	if out, err := Fill(in[1:], "", false); err != nil || len(out) != 1 {
		t.Error("no placeholder, no endpoint needed")
	}
	// The site's own endpoint, on this host: refused
	if _, err := Fill(in, srv.URL, true); err == nil || !strings.Contains(err.Error(), "isn't a public address") {
		t.Errorf("a site's token endpoint on loopback: %v", err)
	}
}
