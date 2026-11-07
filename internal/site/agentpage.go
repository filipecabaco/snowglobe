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
)

// AgentDir is the agent page's directory beside the sites: /agent/ on the demo site
const AgentDir = "agent"

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
)

// AgentScripts are the files WriteAgentPage puts in the agent page's directory, by name
func AgentScripts() map[string][]byte {
	return map[string][]byte{
		"agent.js": agentJS, "agent-webmcp.js": agentWebMCPJS, "agent-panel.js": agentPanelJS, "machine.js": machineJS,
		"machine-worker.js": machineWorkerJS, "transfer.js": transferJS, "scheduler.js": schedulerJS,
		"orchestrator.js": orchestratorJS, "agent-page.js": agentPageJS, "sessions.js": sessionsJS,
		"machine-core.js": machineCoreJS, "machine-host.js": machineHostJS,
	}
}

// Runtime is one machine of the agent page, as runtimes.json lists it. Its URLs are relative to
// the agent page's directory
type Runtime struct {
	Name     string `json:"name"`
	Title    string `json:"title"`
	Purpose  string `json:"purpose"`
	Sample   string `json:"sample"`
	Base     string `json:"base"`    // the site's directory: ../<name>/
	BaseURL  string `json:"baseurl"` // where its files' blobs are: relative to Base, or absolute
	BuildID  string `json:"build_id"`
	MemoryMB int    `json:"memory_mb"`
	CPUs     int    `json:"cpus"` // 1 today: a site on several CPUs needs the page cross-origin isolated
	Network  string `json:"network"`
}

// Manifest is runtimes.json: the machines, and the files they share
type Manifest struct {
	Runtimes []Runtime `json:"runtimes"`
	// One armless for all of them (every site has the same copy; WriteAgentPage checks)
	Armless struct {
		JS   string `json:"js"`
		Wasm string `json:"wasm"`
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
// root built with --agent on one CPU: runtimes.json (each machine: its site, title, what it is
// for, a sample command, its blobs, its build), the page's scripts, and at root/agent/<site>/ a
// redirect to the page with that machine preselected. Each site's "For agents" link points
// there. The page itself (index.html) is the demo site's own (site/agent/), copied in after.
// Everything is static: the page needs no server.
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
	if err := notALink(agentRoot); err != nil {
		return nil, err
	}

	type found struct {
		Runtime
		dir       string
		exposedTo []string
	}
	var sites []found
	var armless [2][]byte // the first site's armless.js and armless.wasm
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		if e.Name() == AgentDir {
			if isSite(dir) {
				return nil, fmt.Errorf("%s: a site named %q would be hidden by the agent page", dir, AgentDir)
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
			MemoryMB int    `json:"memory_mb"`
			Network  string `json:"network"`
			CPUs     int    `json:"cpus"`
			Agent    *struct {
				Purpose   string   `json:"purpose"`
				Sample    string   `json:"sample"`
				ExposedTo []string `json:"exposed_to"`
			} `json:"agent"`
		}
		if err := json.Unmarshal(data, &run); err != nil {
			return nil, fmt.Errorf("%s: %w", dir, err)
		}
		// A site on several CPUs needs a cross-origin isolated page of its own: never a machine here
		if run.Agent == nil || run.CPUs != 1 {
			continue
		}
		if !siteName.MatchString(e.Name()) {
			return nil, fmt.Errorf("%s: an agent site's directory name must be lowercase letters, digits, . _ or -", dir)
		}
		// Its redirect stub goes at agent/<name>/: never over one of the page's own files
		if pageFile(e.Name()) {
			return nil, fmt.Errorf("%s: a site named %q would collide with the agent page's own %s", dir, e.Name(), e.Name())
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
		// One armless for every machine of the page
		for i, f := range []string{"armless/armless.js", "armless/armless.wasm"} {
			b, err := os.ReadFile(filepath.Join(dir, f))
			if err != nil {
				return nil, err
			}
			if len(sites) == 0 {
				armless[i] = b
			} else if !bytes.Equal(armless[i], b) {
				return nil, fmt.Errorf("%s/%s differs from %s's: the agent page's machines must be built by the same snowglobe", dir, f, sites[0].Name)
			}
		}
		if err := notALink(filepath.Join(agentRoot, e.Name())); err != nil {
			return nil, err
		}
		sites = append(sites, found{Runtime: Runtime{
			Name: e.Name(), Title: run.Title, Purpose: run.Agent.Purpose, Sample: run.Agent.Sample,
			Base: "../" + e.Name() + "/", BaseURL: string(m[1]), BuildID: buildID, MemoryMB: run.MemoryMB, CPUs: run.CPUs, Network: run.Network,
		}, dir: dir, exposedTo: run.Agent.ExposedTo})
	}
	if len(sites) == 0 {
		return nil, nil
	}
	sort.Slice(sites, func(i, j int) bool { return sites[i].Name < sites[j].Name })

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
	first := sites[0].Base
	man.Armless.JS, man.Armless.Wasm = first+"armless/armless.js", first+"armless/armless.wasm"
	man.Xterm = first + "xterm/"
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
	for _, s := range sites {
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

		// The terminal page's "For agents" link
		index := filepath.Join(s.dir, "index.html")
		page, err := os.ReadFile(index)
		if err != nil {
			return nil, err
		}
		link := fmt.Sprintf(`id="agent-link" href="../%s/?runtime=%s"`, AgentDir, html.EscapeString(url.QueryEscape(s.Name)))
		if linked := agentLink.ReplaceAllLiteral(page, []byte(link)); !bytes.Equal(linked, page) {
			if err := os.WriteFile(index, linked, 0o644); err != nil {
				return nil, err
			}
		}
	}
	if err := removeStaleStubs(agentRoot, names); err != nil {
		return nil, err
	}
	return man.Runtimes, nil
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
