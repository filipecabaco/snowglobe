// Package site renders the page that boots the snapshot in the browser.
package site

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"html/template"
	"io"
	"os"
	"path/filepath"

	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

//go:embed index.html.tmpl
var page string

//go:embed isolate.js
var isolateWorker []byte

//go:embed sessions.js
var sessionsJS []byte

//go:embed session-ui.js
var sessionUIJS []byte

// The machine itself, in a page or a worker (createMachine): every site's page uses it
//
//go:embed machine-core.js
var machineCoreJS []byte

//go:embed machine-host.js
var machineHostJS []byte

var tmpl = template.Must(template.New("index").Parse(page))

// Page holds what varies between sites.
type Page struct {
	Title string
	// Name is the site's directory name (default: the output directory's): the agent page (/agent/)
	// knows the site's machine by it
	Name     string
	BuildID  string // fingerprint of runtime, base filesystem and initial snapshot
	MemoryMB int    // must match the snapshot
	Network  string // "none" or "fetch"; must match the snapshot
	CPUs     int    // must match the snapshot; more than one needs cross-origin isolation
	// Guest TCP destinations the page carries over WebSockets (armless's network.tunnels)
	Tunnels []tunnel.Tunnel
	// Where the page gets a fresh access token for each tunnel connection whose URL has {token}
	TunnelToken string
	// The console size the snapshot was taken at: its screen is replayed at this size
	ConsoleCols, ConsoleRows int
	// Agent: the site is one of the agent page's machines (snowglobe agent-pages puts every
	// one-CPU --agent site of a directory on DIR/agent/). Its page links there ("For agents",
	// ../agent/?runtime=<name>), and an address ending #agent goes there as it loads
	Agent bool
	// AgentExposedTo is the origins, other than the page's own, its WebMCP tools are shared with
	AgentExposedTo []string
	// Version is snowglobe's
	Version string
}

// Fingerprint binds checkpoints to the exact machine and base assets. It is unchanged by pooling.
func Fingerprint(out string, p Page) (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "snowglobe-session-v1:%d:%d:%s\n", p.MemoryMB, p.CPUs, p.Network)
	files := []string{"system/filesystem.json", "system/state.bin.zst", "armless/armless.js"}
	wasm := "armless/armless.wasm"
	if p.CPUs > 1 {
		wasm = "armless/armless-smp.wasm"
	}
	files = append(files, wasm)
	if p.Network == "fetch" {
		files = append(files, "system/tls.json")
	}
	for _, name := range files {
		f, err := os.Open(filepath.Join(out, name))
		if err != nil {
			return "", err
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return "", err
		}
		fmt.Fprintf(h, "%s:%d\n", name, info.Size())
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Render writes the page and its scripts and marks the site for GitHub Pages.
func Render(out string, p Page) error {
	if p.BuildID == "" {
		var err error
		p.BuildID, err = Fingerprint(out, p)
		if err != nil {
			return err
		}
	}
	if p.Name == "" {
		p.Name = filepath.Base(out)
	}
	scripts := map[string][]byte{"sessions.js": sessionsJS, "session-ui.js": sessionUIJS,
		"machine-core.js": machineCoreJS, "machine-host.js": machineHostJS}
	for name, source := range scripts {
		if err := os.WriteFile(filepath.Join(out, name), source, 0o644); err != nil {
			return err
		}
	}
	var b bytes.Buffer
	if err := tmpl.Execute(&b, p); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, "index.html"), b.Bytes(), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, ".nojekyll"), nil, 0o644); err != nil {
		return err
	}
	// Several CPUs need a cross-origin isolated page: sw.js makes it one
	if p.CPUs > 1 {
		if err := os.WriteFile(filepath.Join(out, "sw.js"), isolateWorker, 0o644); err != nil {
			return err
		}
	}
	return nil
}
