package site

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// AgentDir is the agent page's directory beside the sites: /agent/ on the demo site
const AgentDir = "agent"

// FleetDir is the fleet page's directory beside the sites: /fleet/ on the demo site. It has the
// agent page's machines (the same runtimes.json) and scripts, which its page needs beside it: each
// machine's worker and the service worker are loaded from the page's own directory
const FleetDir = "fleet"

// RuntimesFile is the agent page's list of its machines, written when the site is assembled
const RuntimesFile = "runtimes.json"

// The agent page's scripts: the page itself (site/agent/index.html on the demo site) loads them
// from its own directory, and each machine's worker loads the ones it runs
var (
	//go:embed agent.js
	agentJS []byte
	//go:embed agent-webmcp.js
	agentWebMCPJS []byte
	//go:embed agent-panel.js
	agentPanelJS []byte
	//go:embed machine.js
	machineJS []byte
	//go:embed machine-worker.js
	machineWorkerJS []byte
	//go:embed transfer.js
	transferJS []byte
	//go:embed scheduler.js
	schedulerJS []byte
	//go:embed orchestrator.js
	orchestratorJS []byte
	//go:embed agent-page.js
	agentPageJS []byte
	//go:embed preview.js
	previewJS []byte
	// What an agent sees of the preview and does in it (preview_snapshot, preview_interact), and
	// the hook the service worker puts first in each of the preview's pages
	//go:embed inspect.js
	inspectJS []byte
	//go:embed preview-hook.js
	previewHookJS []byte
	// A WebSocket spoken over a machine's TCP: a guest's to a link's name, and a preview page's to a
	// machine (machine-core.js, orchestrator.js)
	//go:embed ws-client.js
	wsClientJS []byte
	//go:embed builder.js
	builderJS []byte
	//go:embed studio.js
	studioJS []byte
	// The page's service worker: cross-origin isolation (machines on several CPUs) and the preview
	//go:embed agent-sw.js
	agentSW []byte
	// The fleet page: a snowglobe.toml read, planned and run over the same machines
	//go:embed fleet.js
	fleetJS []byte
	//go:embed fleet-page.js
	fleetPageJS []byte
)

// FleetScripts are the files WriteAgentPage puts in the fleet page's directory, by name: the agent
// page's scripts and the fleet page's own
func FleetScripts() map[string][]byte {
	files := AgentScripts()
	files["fleet.js"], files["fleet-page.js"] = fleetJS, fleetPageJS
	return files
}

// AgentScripts are the files WriteAgentPage puts in the agent page's directory, by name
func AgentScripts() map[string][]byte {
	return map[string][]byte{
		"agent.js": agentJS, "agent-webmcp.js": agentWebMCPJS, "agent-panel.js": agentPanelJS, "machine.js": machineJS,
		"machine-worker.js": machineWorkerJS, "transfer.js": transferJS, "scheduler.js": schedulerJS,
		"orchestrator.js": orchestratorJS, "agent-page.js": agentPageJS, "sessions.js": sessionsJS,
		"machine-core.js": machineCoreJS, "machine-host.js": machineHostJS, "memory-debug.js": memoryDebugJS, "preview.js": previewJS, "inspect.js": inspectJS, "preview-hook.js": previewHookJS, "ws-client.js": wsClientJS, "builder.js": builderJS, "studio.js": studioJS, "sw.js": agentSW,
	}
}

// Runtime is one machine of the agent page, as runtimes.json lists it. Its URLs are relative to
// the agent page's directory
type Runtime struct {
	Name     string `json:"name"`
	Title    string `json:"title"`
	Purpose  string `json:"purpose"`
	Sample   string `json:"sample"`
	Watch    string `json:"watch,omitempty"` // a project directory: the page shows what each command changed in it
	Base     string `json:"base"`            // the site's directory: ../<name>/
	BaseURL  string `json:"baseurl"`         // where its files' blobs are: relative to Base, or absolute
	BuildID  string `json:"build_id"`
	MemoryMB int    `json:"memory_mb"`
	CPUs     int    `json:"cpus"` // more than one: the page must be cross-origin isolated (its sw.js)
	Network  string `json:"network"`
}

// Manifest is runtimes.json: the machines, and the files they share
type Manifest struct {
	Runtimes []Runtime `json:"runtimes"`
	// One armless for all of them (every site has the same copy; WriteAgentPage checks): its
	// one-CPU build from a one-CPU site, its several-CPU build from a site on several
	Armless struct {
		JS      string `json:"js"`
		Wasm    string `json:"wasm,omitempty"`
		WasmSMP string `json:"wasm_smp,omitempty"`
	} `json:"armless"`
	Xterm string `json:"xterm"` // a directory with xterm.js, xterm.css and addon-fit.js
	// The origins the page's tools are shared with: one set of tools reaches every machine, so an
	// origin gets them only if every machine's site shares with it
	ExposedTo []string `json:"exposed_to"`
}

var (
	agentLink = regexp.MustCompile(`id="agent-link" href="[^"]*"`)
	blobBase  = regexp.MustCompile(`baseurl: "([^"]*)"`)
	siteName  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

// WriteAgentPage makes the agent page's directory, root/agent/, from every site directly under
// root built with --agent: runtimes.json (each machine: its site, title, what it is for, a sample
// command, its blobs, its build, its CPUs), the page's scripts and service worker, and at
// root/agent/<site>/ a redirect to the page with that machine preselected. Each site's "For
// agents" link points there. The page itself (index.html) is the demo site's own (site/agent/),
// copied in after. Everything is static: the page needs no server. A site on several CPUs is a
// machine there too: the page's service worker makes the page cross-origin isolated, as such a
// site's own page is.
//
// One machine per source: sites built from the same source (an example built for one CPU and for
// two, say) are one machine, the site named after the source when there is one (examples/supabase:
// the site supabase), else the first by name; the others' "For agents" links point at it.
//
// Run it last, once the pages are final (after pool, the blob store's address and pwa): each
// site's blob location is read from its page. Every site is checked before anything is written,
// so a refusal leaves root as it was. It returns the runtimes.
func WriteAgentPage(root string) ([]Runtime, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	agentRoot := filepath.Join(root, AgentDir)
	fleetRoot := filepath.Join(root, FleetDir)
	for _, dir := range []string{agentRoot, fleetRoot} {
		if err := notALink(dir); err != nil {
			return nil, err
		}
	}

	type found struct {
		Runtime
		dir       string
		source    string
		exposedTo []string
	}
	var all []found
	// The armless files, as the first site with each has them: every site's must be the same
	armless := map[string][]byte{}
	armlessFrom := map[string]string{}
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		if e.Name() == AgentDir || e.Name() == FleetDir {
			if isSite(dir) {
				return nil, fmt.Errorf("%s: a site named %q would be hidden by the agent and fleet pages", dir, e.Name())
			}
			continue
		}
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, "run.json"))
		if err != nil {
			continue
		}
		var run struct {
			Title    string `json:"title"`
			Source   string `json:"source"`
			MemoryMB int    `json:"memory_mb"`
			Network  string `json:"network"`
			CPUs     int    `json:"cpus"`
			Agent    *struct {
				Name      string   `json:"name"`
				Purpose   string   `json:"purpose"`
				Sample    string   `json:"sample"`
				Watch     string   `json:"watch"`
				ExposedTo []string `json:"exposed_to"`
			} `json:"agent"`
		}
		if err := json.Unmarshal(data, &run); err != nil {
			return nil, fmt.Errorf("%s: %w", dir, err)
		}
		if run.Agent == nil || run.CPUs < 1 {
			continue
		}
		if !siteName.MatchString(e.Name()) {
			return nil, fmt.Errorf("%s: an agent site's directory name must be lowercase letters, digits, . _ or -", dir)
		}
		// The machine's name on the page: its site's directory name, unless the site says otherwise
		// (label snowglobe.agent-name: a site built for the agent page, with a network the same
		// image's own page doesn't have, is still "python" there)
		name := e.Name()
		if run.Agent.Name != "" {
			name = run.Agent.Name
			if !siteName.MatchString(name) {
				return nil, fmt.Errorf("%s: an agent name must be lowercase letters, digits, . _ or -", dir)
			}
		}
		for _, other := range all {
			if other.Name == name {
				return nil, fmt.Errorf("%s: another site of the agent page is already called %q", dir, name)
			}
		}
		// Its redirect stub goes at agent/<name>/: never over one of the page's own files
		if pageFile(name) {
			return nil, fmt.Errorf("%s: a machine named %q would collide with the agent page's own %s", dir, name, name)
		}
		page, err := os.ReadFile(filepath.Join(dir, "index.html"))
		if err != nil {
			return nil, err
		}
		m := blobBase.FindSubmatch(page)
		if m == nil {
			return nil, fmt.Errorf("%s/index.html: couldn't find where its blobs are (baseurl)", dir)
		}
		buildID, err := Fingerprint(dir, Page{MemoryMB: run.MemoryMB, CPUs: run.CPUs, Network: run.Network})
		if err != nil {
			return nil, fmt.Errorf("%s: %w", dir, err)
		}
		// One armless for every machine of the page: its script, and the build for these CPUs
		for _, f := range []string{"armless/armless.js", armlessWasm(run.CPUs)} {
			b, err := os.ReadFile(filepath.Join(dir, f))
			if err != nil {
				return nil, err
			}
			if from, ok := armlessFrom[f]; !ok {
				armless[f], armlessFrom[f] = b, e.Name()
			} else if !bytes.Equal(armless[f], b) {
				return nil, fmt.Errorf("%s/%s differs from %s's: the agent page's machines must be built by the same snowglobe", dir, f, from)
			}
		}
		if err := notALink(filepath.Join(agentRoot, name)); err != nil {
			return nil, err
		}
		all = append(all, found{Runtime: Runtime{
			Name: name, Title: run.Title, Purpose: run.Agent.Purpose, Sample: run.Agent.Sample, Watch: run.Agent.Watch,
			Base: "../" + e.Name() + "/", BaseURL: string(m[1]), BuildID: buildID, MemoryMB: run.MemoryMB, CPUs: run.CPUs, Network: run.Network,
		}, dir: dir, source: run.Source, exposedTo: run.Agent.ExposedTo})
	}
	if len(all) == 0 {
		return nil, nil
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })

	// One machine per source; every site, kept or not, links to its source's machine
	keep := map[string]string{} // source: the site that is its machine
	for _, s := range all {
		if s.source == "" {
			continue
		}
		if _, ok := keep[s.source]; !ok || s.Name == sourceName(s.source) {
			keep[s.source] = s.Name
		}
	}
	var sites []found
	machineOf := map[string]string{} // site: the machine its "For agents" link goes to
	for _, s := range all {
		machineOf[s.Name] = s.Name
		if k, ok := keep[s.source]; ok && k != s.Name {
			machineOf[s.Name] = k
			continue
		}
		sites = append(sites, s)
	}

	var man Manifest
	sharing := map[string]int{} // origin: how many sites share their tools with it
	names := map[string]bool{}
	for _, s := range sites {
		man.Runtimes = append(man.Runtimes, s.Runtime)
		names[s.Name] = true
		seen := map[string]bool{}
		for _, o := range s.exposedTo {
			if !seen[o] {
				seen[o] = true
				sharing[o]++
			}
		}
	}
	// armless from the first machine that has each file
	for _, s := range sites {
		if man.Armless.JS == "" {
			man.Armless.JS = s.Base + "armless/armless.js"
			man.Xterm = s.Base + "xterm/"
		}
		if s.CPUs > 1 && man.Armless.WasmSMP == "" {
			man.Armless.WasmSMP = s.Base + armlessWasm(s.CPUs)
		}
		if s.CPUs == 1 && man.Armless.Wasm == "" {
			man.Armless.Wasm = s.Base + armlessWasm(s.CPUs)
		}
	}
	man.ExposedTo = []string{}
	for o, n := range sharing {
		if n == len(sites) {
			man.ExposedTo = append(man.ExposedTo, o)
		}
	}
	sort.Strings(man.ExposedTo)

	if err := os.MkdirAll(agentRoot, 0o755); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return nil, err
	}
	files := AgentScripts()
	files[RuntimesFile] = append(data, '\n')
	for name, b := range files {
		if err := writeFile(filepath.Join(agentRoot, name), b); err != nil {
			return nil, err
		}
	}
	// The fleet page's directory: the same machines and scripts, and its own (its index.html is the
	// demo site's, site/fleet/, copied in after)
	if err := os.MkdirAll(fleetRoot, 0o755); err != nil {
		return nil, err
	}
	fleetFiles := FleetScripts()
	fleetFiles[RuntimesFile] = files[RuntimesFile]
	for name, b := range fleetFiles {
		if err := writeFile(filepath.Join(fleetRoot, name), b); err != nil {
			return nil, err
		}
	}
	for _, s := range all {
		if machineOf[s.Name] != s.Name {
			// Another site of the same source is the machine: its link goes there
			if err := linkTo(s.dir, machineOf[s.Name]); err != nil {
				return nil, err
			}
			continue
		}
		// The old per-runtime address, /agent/<site>/: the page, that machine preselected
		target := "../?runtime=" + url.QueryEscape(s.Name)
		stub := fmt.Sprintf("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>%s · machines for agents</title>\n"+
			"  <meta http-equiv=\"refresh\" content=\"0; url=%s\">\n  <link rel=\"canonical\" href=\"%s\">\n"+
			"  <script>location.replace(%q + location.hash)</script>\n</head>\n<body>\n  <p><a href=\"%s\">%s is on the agent page</a>.</p>\n</body>\n</html>\n",
			html.EscapeString(s.Title), html.EscapeString(target), html.EscapeString(target), target, html.EscapeString(target), html.EscapeString(s.Title))
		out := filepath.Join(agentRoot, s.Name)
		if err := os.MkdirAll(out, 0o755); err != nil {
			return nil, err
		}
		if err := writeFile(filepath.Join(out, "index.html"), []byte(stub)); err != nil {
			return nil, err
		}

		if err := linkTo(s.dir, s.Name); err != nil {
			return nil, err
		}
	}
	if err := removeStaleStubs(agentRoot, names); err != nil {
		return nil, err
	}
	return man.Runtimes, nil
}

// linkTo points a site's "For agents" link (its terminal page's) at the agent page, with machine
// preselected
func linkTo(dir, machine string) error {
	index := filepath.Join(dir, "index.html")
	page, err := os.ReadFile(index)
	if err != nil {
		return err
	}
	link := fmt.Sprintf(`id="agent-link" href="../%s/?runtime=%s"`, AgentDir, html.EscapeString(url.QueryEscape(machine)))
	if linked := agentLink.ReplaceAllLiteral(page, []byte(link)); !bytes.Equal(linked, page) {
		return os.WriteFile(index, linked, 0o644)
	}
	return nil
}

// armlessWasm is the armless build a site on cpus CPUs runs
func armlessWasm(cpus int) string {
	if cpus > 1 {
		return "armless/armless-smp.wasm"
	}
	return "armless/armless.wasm"
}

// sourceName is the site name a source would have by default: its directory's or image's name
// (examples/supabase, ./supabase.tar and ghcr.io/me/supabase:1 are all "supabase")
func sourceName(source string) string {
	name := filepath.Base(strings.TrimRight(source, "/"))
	if i := strings.LastIndex(name, ":"); i > 0 && !strings.Contains(name[i:], "/") {
		name = name[:i]
	}
	for _, ext := range []string{".tar.gz", ".tar.zst", ".tgz", ".tar"} {
		name = strings.TrimSuffix(name, ext)
	}
	return name
}

// stubMark is in every redirect stub WriteAgentPage writes
var stubMark = regexp.MustCompile(`<meta http-equiv="refresh" content="0; url=\.\./\?runtime=[^"]*">`)

// pageFile: a name the agent page's directory uses for one of its own files
func pageFile(name string) bool {
	if _, ok := AgentScripts()[name]; ok {
		return true
	}
	return name == RuntimesFile || name == "index.html"
}

// removeStaleStubs removes the redirect stubs of machines no longer on the page: directories of
// agentRoot, not named in keep, that hold nothing but an index.html WriteAgentPage wrote. Anything
// else is left alone.
func removeStaleStubs(agentRoot string, keep map[string]bool) error {
	entries, err := os.ReadDir(agentRoot)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() || keep[e.Name()] || e.Type()&fs.ModeSymlink != 0 {
			continue
		}
		dir := filepath.Join(agentRoot, e.Name())
		inside, err := os.ReadDir(dir)
		if err != nil || len(inside) != 1 || inside[0].Name() != "index.html" || !inside[0].Type().IsRegular() {
			continue
		}
		page, err := os.ReadFile(filepath.Join(dir, "index.html"))
		if err != nil || !stubMark.Match(page) {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	return nil
}

// writeFile writes a file of the agent page, never through a symlink (it would write outside root)
func writeFile(path string, b []byte) error {
	if err := notALink(path); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// notALink refuses a symlink at path (nothing there is fine).
func notALink(path string) error {
	st, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if st.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symlink: the agent page is written only into a directory of its own", path)
	}
	return nil
}

// isSite: a built site (its run.json), not the agent page's directory
func isSite(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, "run.json"))
	return err == nil
}
