package pwa

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func siteWith(t *testing.T, cpus int) string {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "run.json"), []byte(`{"title":"Go + Bubble Tea in the browser","built_at":"2026-10-09T12:00:00Z","cpus":`+
		strconv.Itoa(cpus)+`}`), 0o644)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html><head><title>x</title></head><body></body></html>"), 0o644)
	os.MkdirAll(filepath.Join(dir, "armless"), 0o755)
	os.WriteFile(filepath.Join(dir, "armless", "armless.js"), nil, 0o644)
	os.WriteFile(filepath.Join(dir, "armless", "armless.wasm"), nil, 0o644)
	return dir
}

func site(t *testing.T) string { return siteWith(t, 1) }

func TestRun(t *testing.T) {
	dir := site(t)
	if err := Run(Options{Site: dir}); err != nil {
		t.Fatal(err)
	}

	var manifest map[string]any
	data, _ := os.ReadFile(filepath.Join(dir, "manifest.webmanifest"))
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["short_name"] != "Go + Bubble Tea" || manifest["display"] != "standalone" {
		t.Errorf("manifest: %v", manifest)
	}

	sw, _ := os.ReadFile(filepath.Join(dir, "sw.js"))
	if !strings.Contains(string(sw), `"snowglobe-20261009T120000"`) || !strings.Contains(string(sw), `"manifest.webmanifest"`) {
		t.Error("sw.js should name the build's cache and precache the shell files that exist")
	}
	// The page asks for the machine, the terminal and its scripts with its build's version (?v=):
	// precaching their bare URLs would download them twice, and only versioned URLs are served
	// cache first
	for _, unwanted := range []string{`"armless/armless.wasm"`, `"armless/armless.js"`, `"machine-core.js"`, `"machine-host.js"`, `"xterm/xterm.js"`} {
		if strings.Contains(string(sw), unwanted) {
			t.Errorf("sw.js precaches %s, which the page versions", unwanted)
		}
	}
	// A versioned file: the cache first, matched with its version (not ignoreSearch)
	if !strings.Contains(string(sw), `if (versioned(url)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(keep)));`) {
		t.Error("sw.js should serve versioned files cache first, matched with their version")
	}
	// Only a build's version (site.Page.Assets: 16 hex digits), not any ?v= on this origin
	if !strings.Contains(string(sw), `url.origin === location.origin && /^[0-9a-f]{16}$/.test(url.searchParams.get("v") ?? "")`) {
		t.Error("sw.js should take only the page's own version for one")
	}
	// What the page fetched before the worker was in control: a versioned URL is kept unless that
	// exact version is cached
	if !strings.Contains(string(sw), `cache.match(url, { ignoreSearch: !exact })`) {
		t.Error("sw.js should keep a versioned file the page hands over unless that version is cached")
	}
	if !strings.Contains(string(sw), "const ISOLATE = false;") {
		t.Error("a one-CPU site needs no cross-origin isolation")
	}
	for _, icon := range []string{"icon-192.png", "icon-512.png"} {
		if _, err := os.Stat(filepath.Join(dir, icon)); err != nil {
			t.Error(err)
		}
	}
}

func TestSessionAssetsAndCacheIsolation(t *testing.T) {
	dir := site(t)
	for _, name := range []string{"sessions.js", "session-ui.js"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := Run(Options{Site: dir}); err != nil {
		t.Fatal(err)
	}
	sw, _ := os.ReadFile(filepath.Join(dir, "sw.js"))
	for _, want := range []string{`self.registration.scope`, `k.endsWith(":" + self.registration.scope)`} {
		if !strings.Contains(string(sw), want) {
			t.Errorf("PWA lacks session asset/cache isolation %q", want)
		}
	}
	// The session scripts are versioned by the page and cached as it fetches them, not precached
	for _, unwanted := range []string{`"sessions.js"`, `"session-ui.js"`} {
		if strings.Contains(string(sw), unwanted) {
			t.Errorf("sw.js precaches %s, which the page versions", unwanted)
		}
	}
}

func TestIsolatesSeveralCPUs(t *testing.T) {
	dir := siteWith(t, 4)
	if err := Run(Options{Site: dir}); err != nil {
		t.Fatal(err)
	}
	sw, _ := os.ReadFile(filepath.Join(dir, "sw.js"))
	if !strings.Contains(string(sw), "const ISOLATE = true;") {
		t.Error("a site with several CPUs must stay cross-origin isolated under the PWA worker")
	}
}

func TestRunTwiceKeepsOneBlock(t *testing.T) {
	dir := site(t)
	Run(Options{Site: dir})
	if err := Run(Options{Site: dir, ShortName: "Life"}); err != nil {
		t.Fatal(err)
	}
	page, _ := os.ReadFile(filepath.Join(dir, "index.html"))
	if n := strings.Count(string(page), "<!-- snowglobe:pwa -->"); n != 1 {
		t.Errorf("want one pwa block, got %d", n)
	}
	if !strings.Contains(string(page), `content="Life"`) {
		t.Error("the second run's short name should win")
	}
}

func TestBlobsElsewhereAreCached(t *testing.T) {
	dir := site(t)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte(`<html><head></head><body><script>filesystem: { json: "system/filesystem.json", baseurl: "https://raw.githubusercontent.com/o/r/abc/" }</script></body></html>`), 0o644)
	if err := Run(Options{Site: dir}); err != nil {
		t.Fatal(err)
	}
	sw, _ := os.ReadFile(filepath.Join(dir, "sw.js"))
	if !strings.Contains(string(sw), `const BLOBS = "https://raw.githubusercontent.com/o/r/abc/";`) {
		t.Error("sw.js should cache the blob store on GitHub")
	}

	same := site(t)
	Run(Options{Site: same})
	sw, _ = os.ReadFile(filepath.Join(same, "sw.js"))
	if !strings.Contains(string(sw), `const BLOBS = "";`) {
		t.Error("a site with its own blobs caches nothing from other origins")
	}
}
