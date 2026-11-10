package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

func TestTunnelArgs(t *testing.T) {
	got := TunnelArgs([]tunnel.Tunnel{
		{Host: "db.internal", Port: 5432, URL: "wss://gw/db?token=abc"},
		{Port: 6379, URL: "ws://127.0.0.1:7000"},
	}, true)
	want := []string{"--tunnel", "db.internal:5432=wss://gw/db?token=abc", "--tunnel", "6379=ws://127.0.0.1:7000", "--allow-private"}
	if !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := TunnelArgs(nil, false); len(got) != 0 {
		t.Errorf("nothing to pass: got %q", got)
	}
}

func TestFetchSiteKnowsWhatTheDockerfileFetches(t *testing.T) {
	df, err := context.ReadFile("Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.ReplaceAll(string(df), "\\\n", " ")
	for _, want := range []string{"armless-web.tar.gz", "xterm-6.0.0.tgz", "addon-fit-0.11.0.tgz"} {
		if !strings.Contains(joined, "/"+want+" ") {
			t.Errorf("the tools Dockerfile doesn't ADD %s: FetchSite's member map needs updating", want)
		}
	}
}

// The build retries a boot on snowglobe-vm's stall status: the two must agree.
func TestExitBootStalledMatchesRuntime(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("runtime", "src", "snapshot.rs"))
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("const BOOT_STALLED: u8 = %d;", ExitBootStalled)
	if !strings.Contains(string(src), want) {
		t.Fatalf("snapshot.rs has no %q: ExitBootStalled and BOOT_STALLED differ", want)
	}
}
