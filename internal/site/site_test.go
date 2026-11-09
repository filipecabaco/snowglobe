package site

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

func render(t *testing.T, p Page) (string, string) {
	t.Helper()
	dir := t.TempDir()
	p.BuildID = "test-build"
	if err := Render(dir, p); err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	// html/template pads values in scripts with spaces
	return strings.Join(strings.Fields(string(page)), " "), dir
}

func TestFingerprintBindsMachineAndBaseAssets(t *testing.T) {
	dir := t.TempDir()
	files := []string{"system/filesystem.json", "system/state.bin.zst", "armless/armless.js", "armless/armless.wasm", "armless/armless-smp.wasm", "system/tls.json"}
	for _, name := range files {
		file := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p := Page{MemoryMB: 256, CPUs: 2, Network: "fetch"}
	original, err := Fingerprint(dir, p)
	if err != nil {
		t.Fatal(err)
	}
	repeat, _ := Fingerprint(dir, p)
	if repeat != original || len(original) != 64 {
		t.Fatal("fingerprint must be deterministic SHA-256")
	}
	for _, changed := range []Page{{MemoryMB: 128, CPUs: 2, Network: "fetch"}, {MemoryMB: 256, CPUs: 1, Network: "fetch"}, {MemoryMB: 256, CPUs: 2, Network: "none"}} {
		id, _ := Fingerprint(dir, changed)
		if id == original {
			t.Error("changed machine is compatible")
		}
	}
	for _, name := range files {
		if name == "armless/armless.wasm" {
			continue // the SMP build doesn't use this asset
		}
		file := filepath.Join(dir, name)
		os.WriteFile(file, []byte("changed"), 0o644)
		id, err := Fingerprint(dir, p)
		if err != nil || id == original {
			t.Errorf("changed %s didn't change fingerprint: %v", name, err)
		}
		os.WriteFile(file, []byte(name), 0o644)
	}
	if err := Render(dir, p); err != nil {
		t.Fatal(err)
	}
	page, _ := os.ReadFile(filepath.Join(dir, "index.html"))
	if !strings.Contains(string(page), original) {
		t.Error("page must embed the fingerprint")
	}
	// Builds prune the unused single/SMP runtime; it must not be required for this machine.
	os.Remove(filepath.Join(dir, "armless/armless.wasm"))
	if _, err := Fingerprint(dir, p); err != nil {
		t.Errorf("SMP fingerprint requires unused single-CPU runtime: %v", err)
	}
	os.Remove(filepath.Join(dir, "system/state.bin.zst"))
	if _, err := Fingerprint(dir, p); err == nil {
		t.Error("missing snapshot must fail rather than use an empty identity")
	}
}

func TestOneCPUOffline(t *testing.T) {
	page, dir := render(t, Page{Title: "Demo <1>", MemoryMB: 256, Network: "none", CPUs: 1, ConsoleCols: 90, ConsoleRows: 30})
	for _, want := range []string{`<script src="armless/armless.js?v=`, "memory_mb: 256", "const cpus = 1 ;",
		"Demo &lt;1&gt;", "term.resize( 90 , 30 )"} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	for _, unwanted := range []string{"v86", "https-bridge", "network: {"} {
		if strings.Contains(page, unwanted) {
			t.Errorf("page has %q", unwanted)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "sw.js")); err == nil {
		t.Error("a one-CPU site has no service worker of its own")
	}
}

func TestSessionControlsAndSafeReload(t *testing.T) {
	page, dir := render(t, Page{Title: "Session demo", MemoryMB: 256, Network: "none", CPUs: 1})
	for _, want := range []string{`src="sessions.js?v=`, `src="session-ui.js?v=`, `id="sessions"`, `id="session-save"`, `id="session-export"`, `id="session-import"`, `id="session-folder"`, `id="session-delete"`, `SnowglobeSessionUI`, `await sessions.prepare()`, `sessions.initialState`, `sessions.attach(emulator, term`, `new ResizeObserver(() => resize())`, `sessions.message("Workspace could not start"`} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks persistence integration %q", want)
		}
	}
	for _, name := range []string{"sessions.js", "session-ui.js"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("missing shipped session asset %s: %v", name, err)
		}
	}
	for _, unsafe := range []string{"localStorage.clear()", "sessionStorage.clear()", "caches.keys()", "getRegistrations()"} {
		if strings.Contains(page, unsafe) {
			t.Errorf("runtime reload must not clear origin-wide state: %s", unsafe)
		}
	}
}

func TestWorkspaceShowsSaveControlsAndExplicitMethods(t *testing.T) {
	page, _ := render(t, Page{Title: "Workspace demo", MemoryMB: 256, Network: "none", CPUs: 1})
	for _, want := range []string{`id="workspace-bar"`, `>Save / restore</summary>`, `id="session-method"`,
		`value="browser"`, `value="backup"`, `value="folder"`, `id="session-filename"`,
		`id="session-autosave"`, `value="60000"`, `value="300000"`, `value="900000"`, `value="off"`,
		`id="session-hint"`, `id="session-last-save"`, `id="session-changes"`, `id="session-paused"`,
		`>Saved workspaces</summary>`, `>Recovery</summary>`, `id="session-open"`} {
		if !strings.Contains(page, want) {
			t.Errorf("simple save UI lacks %q", want)
		}
	}
	for _, unwanted := range []string{`>More options</summary>`, `>Local session`, `>Capturing checkpoint`} {
		if strings.Contains(page, unwanted) {
			t.Errorf("save UI exposes a vague or technical control %q", unwanted)
		}
	}
	menu := strings.Index(page, `id="sessions"`)
	for _, id := range []string{"session-status", "session-location", "session-save", "session-last-save", "session-hint"} {
		if at := strings.Index(page, `id="`+id+`"`); at < 0 || at > menu {
			t.Errorf("%s must remain visible with the save menu closed", id)
		}
	}
}

func TestSeveralCPUsWithNetwork(t *testing.T) {
	page, dir := render(t, Page{Title: "Demo", MemoryMB: 512, Network: "fetch", CPUs: 4})
	for _, want := range []string{"const cpus = 4 ;", `network: { tls: versioned("system/tls.json") }`, `register("sw.js")`} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if strings.Contains(page, "term.resize( 0 , 0 )") || !strings.Contains(page, "fit.fit();") {
		t.Error("without a console size the screen is replayed at the window's size")
	}
	sw, err := os.ReadFile(filepath.Join(dir, "sw.js"))
	if err != nil {
		t.Fatal("a site with several CPUs needs sw.js for cross-origin isolation")
	}
	for _, want := range []string{"Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy"} {
		if !strings.Contains(string(sw), want) {
			t.Errorf("sw.js lacks %q", want)
		}
	}
}

func TestTunnels(t *testing.T) {
	page, _ := render(t, Page{Title: "Demo", MemoryMB: 512, Network: "fetch", CPUs: 1, Tunnels: []tunnel.Tunnel{
		{Host: "db.internal", Port: 5432, URL: "wss://proxy.example.com/db?a=1&b=</script>"},
		{Port: 6379, URL: "ws://127.0.0.1:7000"},
	}})
	// A JSON array in the script: the URL escaped so it can't end the script
	want := `network: { tls: versioned("system/tls.json"), tunnels: [{"host":"db.internal","port":5432,"url":"wss://proxy.example.com/db?a=1\u0026b=\u003c/script\u003e"},{"port":6379,"url":"ws://127.0.0.1:7000"}] }`
	if !strings.Contains(page, want) {
		i := strings.Index(page, "network:")
		t.Errorf("page lacks %s\ngot: %s", want, page[i:min(i+300, len(page))])
	}
}

func TestTunnelToken(t *testing.T) {
	page, _ := render(t, Page{Title: "Demo", MemoryMB: 512, Network: "fetch", CPUs: 1, TunnelToken: "https://gw.example.com/token",
		Tunnels: []tunnel.Tunnel{{Host: "db.internal", Port: 5432, URL: "wss://gw.example.com/db?token={token}"}}})
	for _, want := range []string{`const tunnelToken = "https://gw.example.com/token";`,
		`tunnels: withTokens([{"host":"db.internal","port":5432,"url":"wss://gw.example.com/db?token={token}"}])`} {
		if !strings.Contains(page, want) {
			i := strings.Index(page, "const tunnelToken")
			t.Errorf("page lacks %s\ngot: %s", want, page[i:min(i+700, len(page))])
		}
	}
	plain, _ := render(t, Page{Title: "Demo", MemoryMB: 512, Network: "fetch", CPUs: 1,
		Tunnels: []tunnel.Tunnel{{Port: 5432, URL: "ws://127.0.0.1:6543"}}})
	if strings.Contains(plain, "withTokens") || strings.Contains(plain, "tunnelToken") {
		t.Error("without a token endpoint the tunnels go in as they are")
	}
}

func flat(t *testing.T, file string) string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(strings.Fields(string(data)), " ")
}

func lacks(t *testing.T, what, page string, wants ...string) {
	t.Helper()
	for _, s := range wants {
		if !strings.Contains(page, s) {
			t.Errorf("%s lacks %s", what, s)
		}
	}
}

// The machine is made by the same factory the agent page uses (machine-host.js), in the page
func TestThePageMakesItsMachineWithTheFactory(t *testing.T) {
	page, dir := render(t, Page{Title: "t", MemoryMB: 256, CPUs: 1, Network: "none"})
	lacks(t, "the page", page, `<script src="machine-core.js?v=`, `<script src="machine-host.js?v=`,
		`SnowglobeHost.createMachine({ base: document.baseURI, transport: "inline"`, `baseurl: "system/filesystem/"`,
		`warm: versioned("system/warm.pack")`, `host.boot(sessions.initialState ?? versioned("system/state.bin.zst"))`, `await host.run()`)
	for _, f := range []string{"machine-core.js", "machine-host.js"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("the site lacks %s", f)
		}
	}
}

func TestAgentOnlyWhenBuiltWithIt(t *testing.T) {
	page, dir := render(t, Page{Title: "t", MemoryMB: 256, CPUs: 1, Network: "none"})
	for _, s := range []string{"agent-link", "snowglobeAgent", "SnowglobeWebMCP", "agent.js"} {
		if strings.Contains(page, s) {
			t.Errorf("a site built without --agent has %q", s)
		}
	}
	// The agent page's own files are not the site's: snowglobe agent-pages writes them, once
	for _, f := range []string{"agent.js", "agent-webmcp.js", "agent-panel.js", "machine.js", "agent.html"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			t.Errorf("a site has %s", f)
		}
	}
}

// Built with --agent: the page links to the agent page with its machine preselected, and an
// address ending #agent goes there as it loads; the page itself runs no agent
func TestAgentSiteLinksToTheAgentPage(t *testing.T) {
	page, dir := render(t, Page{Title: "t", MemoryMB: 256, CPUs: 1, Network: "fetch", Agent: true, Version: "v9.9.9"})
	name := filepath.Base(dir)
	lacks(t, "the terminal page", page,
		`<a id="agent-link" href="../agent/?runtime=`+name+`">For agents</a>`,
		`if (location.hash === "#agent") { location.replace(agentLink.href); return; }`)
	for _, s := range []string{"snowglobeAgent", "SnowglobeWebMCP", "SnowglobeAgentPanel", "agent.js"} {
		if strings.Contains(page, s) {
			t.Errorf("the terminal page has %q", s)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "agent.html")); err == nil {
		t.Error("there is no per-site agent page any more: /agent/ is the one")
	}
}

// A build's own files carry its asset version, so the PWA's service worker can serve them from its
// cache first (internal/pwa/sw.js): a newer page asks for other URLs, never an older build's copy
func TestBuildFilesCarryTheAssetVersion(t *testing.T) {
	page, dir := render(t, Page{MemoryMB: 256, CPUs: 2, Network: "fetch"})
	version, err := assetVersion(dir, "test-build")
	if err != nil {
		t.Fatal(err)
	}
	lacks(t, "the page", page, `const assets = "`+version+`";`)
	// The PWA's service worker takes only this form for a version (internal/pwa/sw.js)
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(version) {
		t.Errorf("asset version %q isn't 16 hex digits", version)
	}
	// Every script and stylesheet the page loads
	tags := regexp.MustCompile(`(?:src|href)="([^"]+)"`).FindAllStringSubmatch(page, -1)
	for _, m := range tags {
		if strings.HasPrefix(m[1], "../agent/") {
			continue // another page
		}
		if !strings.HasSuffix(m[1], "?v="+version) {
			t.Errorf("%s isn't versioned", m[1])
		}
	}
	if len(tags) < 8 {
		t.Errorf("want the stylesheet and seven scripts, got %d", len(tags))
	}
	// Every file the machine and the page fetch
	for _, url := range []string{`versioned("armless/armless.wasm")`, `versioned("armless/armless-smp.wasm")`,
		`versioned("system/filesystem.json")`, `initial_state: versioned("system/state.bin.zst")`,
		`versioned("system/warm.pack")`, `versioned("system/tls.json")`, `fetch(versioned("system/console.bin"))`,
		`host.boot(sessions.initialState ?? versioned("system/state.bin.zst"))`} {
		lacks(t, "the page", page, url)
	}
	for _, bare := range []string{`"armless/armless.wasm"`, `"system/state.bin.zst"`, `"system/filesystem.json"`, `"system/warm.pack"`,
		`"system/console.bin"`, `"system/tls.json"`} {
		if strings.Count(page, bare) != strings.Count(page, "versioned("+bare+")") {
			t.Errorf("the page asks for %s without its version", bare)
		}
	}
	// The blobs are named by their content, and snowglobe pool repoints them by this exact text
	lacks(t, "the page", page, `baseurl: "system/filesystem/"`)

	// The warm pack, the replayed screen and the terminal change the version; BuildID (saved
	// workspaces are bound to it) is not computed from them
	for _, name := range []string{"system/warm.pack", "system/console.bin", "xterm/xterm.js", "xterm/xterm.css", "xterm/addon-fit.js"} {
		file := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(file), 0o755)
		os.WriteFile(file, []byte(name), 0o644)
		changed, err := assetVersion(dir, "test-build")
		if err != nil {
			t.Fatal(err)
		}
		if changed == version {
			t.Errorf("%s doesn't change the asset version", name)
		}
		version = changed
	}
	if other, _ := assetVersion(dir, "other-build"); other == version {
		t.Error("BuildID doesn't change the asset version")
	}
	// Render computes it unless given
	given, _ := render(t, Page{MemoryMB: 256, CPUs: 1, Network: "none", Assets: "fixed"})
	lacks(t, "the page", given, `const assets = "fixed";`, `<script src="sessions.js?v=fixed">`)
}
