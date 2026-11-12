package site

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// fakeSite writes what a built (and pooled) site has that the agent page reads
func fakeSite(t *testing.T, root, name string, run map[string]any, armless string) {
	t.Helper()
	dir := filepath.Join(root, name)
	files := map[string]string{
		"system/filesystem.json": "{}", "system/state.bin.zst": "state-" + name, "armless/armless.js": armless,
		"system/tls.json": "{}",
		"index.html":      `<a id="agent-link" href="../agent/?runtime=x">For agents</a> filesystem: { json: "system/filesystem.json", baseurl: "../blobs/" },`,
	}
	// A site has the armless build for its CPUs
	if cpus, _ := run["cpus"].(int); cpus > 1 {
		files["armless/armless-smp.wasm"] = "wasm-smp"
	} else {
		files["armless/armless.wasm"] = "wasm"
	}
	data, _ := json.Marshal(run)
	files["run.json"] = string(data)
	for f, s := range files {
		p := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func agentRun(purpose string, cpus int, exposed ...string) map[string]any {
	return map[string]any{"title": purpose + " in the browser", "memory_mb": 512, "network": "none", "cpus": cpus,
		"agent": map[string]any{"purpose": purpose, "sample": "echo " + purpose, "exposed_to": exposed}}
}

// A site built for the agent page alone (a network its image's own page lacks) is listed under the
// name its agent-name says, with its own site's files
func TestWriteAgentPageNamedMachine(t *testing.T) {
	root := t.TempDir()
	run := agentRun("Python", 1)
	run["network"] = "fetch"
	run["agent"].(map[string]any)["name"] = "python"
	fakeSite(t, root, "python-agent", run, "armless")
	fakeSite(t, root, "python", map[string]any{"title": "Python", "memory_mb": 512, "network": "none", "cpus": 1}, "armless") // the page for people: no agent
	runtimes, err := WriteAgentPage(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtimes) != 1 || runtimes[0].Name != "python" || runtimes[0].Base != "../python-agent/" || runtimes[0].Network != "fetch" {
		t.Fatalf("runtimes: %+v", runtimes)
	}
	if _, err := os.Stat(filepath.Join(root, AgentDir, "python", "index.html")); err != nil {
		t.Errorf("no stub at agent/python/: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, AgentDir, "python-agent")); err == nil {
		t.Errorf("a stub under the directory name")
	}
	page, _ := os.ReadFile(filepath.Join(root, "python-agent", "index.html"))
	if !strings.Contains(string(page), "runtime=python\"") {
		t.Errorf("its link doesn't preselect python: %s", page)
	}
	// Two sites with the same name on the page, or a name that isn't one, are refused
	run2 := agentRun("Other", 1)
	run2["agent"].(map[string]any)["name"] = "python"
	fakeSite(t, root, "other", run2, "armless")
	if _, err := WriteAgentPage(root); err == nil || !strings.Contains(err.Error(), `"python"`) {
		t.Errorf("a duplicate name: %v", err)
	}
	os.RemoveAll(filepath.Join(root, "other"))
	run["agent"].(map[string]any)["name"] = "Py/x"
	data, _ := json.Marshal(run)
	os.WriteFile(filepath.Join(root, "python-agent", "run.json"), data, 0o644)
	if _, err := WriteAgentPage(root); err == nil {
		t.Errorf("a bad agent name accepted")
	}
}

func TestWriteAgentPage(t *testing.T) {
	root := t.TempDir()
	pyRun := agentRun("Python", 1, "https://chatgpt.com")
	pyRun["agent"].(map[string]any)["watch"] = "/root/app"
	fakeSite(t, root, "python", pyRun, "armless")
	fakeSite(t, root, "duckdb", agentRun("DuckDB", 1, "https://chatgpt.com", "https://b.example"), "armless")
	fakeSite(t, root, "java", agentRun("Java", 2, "https://chatgpt.com"), "armless")                                          // several CPUs: a machine too
	fakeSite(t, root, "elixir", map[string]any{"title": "Elixir", "memory_mb": 512, "network": "none", "cpus": 1}, "armless") // no --agent

	runtimes, err := WriteAgentPage(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtimes) != 3 || runtimes[0].Name != "duckdb" || runtimes[1].Name != "java" || runtimes[2].Name != "python" {
		t.Fatalf("runtimes: %+v", runtimes)
	}

	var man Manifest
	data, err := os.ReadFile(filepath.Join(root, AgentDir, RuntimesFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &man); err != nil {
		t.Fatal(err)
	}
	// Each machine's CPUs, as its site has them: the page needs cross-origin isolation for java's
	if man.Runtimes[1].CPUs != 2 || man.Runtimes[2].CPUs != 1 {
		t.Errorf("cpus: java %d, python %d", man.Runtimes[1].CPUs, man.Runtimes[2].CPUs)
	}
	if !strings.Contains(string(data), `"cpus": 2`) {
		t.Errorf("runtimes.json lacks java's cpus: %s", data)
	}
	if want, _ := Fingerprint(filepath.Join(root, "java"), Page{MemoryMB: 512, CPUs: 2, Network: "none"}); man.Runtimes[1].BuildID != want {
		t.Errorf("java's build id %s, want %s (its several-CPU armless)", man.Runtimes[1].BuildID, want)
	}
	py := man.Runtimes[2]
	// Its watched project, for the page's changes; none for the others
	if py.Watch != "/root/app" || man.Runtimes[0].Watch != "" || strings.Count(string(data), `"watch"`) != 1 {
		t.Errorf("watch: python %q, duckdb %q", py.Watch, man.Runtimes[0].Watch)
	}
	if py.Base != "../python/" || py.BaseURL != "../blobs/" || py.Purpose != "Python" || py.Sample != "echo Python" || py.MemoryMB != 512 || py.Network != "none" {
		t.Errorf("python: %+v", py)
	}
	// The build id is the site's own fingerprint, as its page and saves have it
	if want, _ := Fingerprint(filepath.Join(root, "python"), Page{MemoryMB: 512, CPUs: 1, Network: "none"}); py.BuildID != want {
		t.Errorf("build id %s, want %s", py.BuildID, want)
	}
	if man.Armless.JS != "../duckdb/armless/armless.js" || man.Armless.Wasm != "../duckdb/armless/armless.wasm" || man.Xterm != "../duckdb/xterm/" ||
		man.Armless.WasmSMP != "../java/armless/armless-smp.wasm" {
		t.Errorf("shared files: %+v %s", man.Armless, man.Xterm)
	}
	// One set of tools reaches every machine: shared only with the origins every site shares with
	if strings.Join(man.ExposedTo, ",") != "https://chatgpt.com" {
		t.Errorf("exposed to: %v", man.ExposedTo)
	}

	// The page's scripts, from snowglobe itself
	for name, want := range AgentScripts() {
		got, err := os.ReadFile(filepath.Join(root, AgentDir, name))
		if err != nil || string(got) != string(want) {
			t.Errorf("%s not written as embedded: %v", name, err)
		}
	}
	// The fleet page has the same machines and scripts beside it, and its own
	for name, want := range FleetScripts() {
		got, err := os.ReadFile(filepath.Join(root, FleetDir, name))
		if err != nil || string(got) != string(want) {
			t.Errorf("fleet/%s not written as embedded: %v", name, err)
		}
	}
	for _, own := range []string{"fleet.js", "fleet-page.js"} {
		if _, ok := AgentScripts()[own]; ok {
			t.Errorf("%s is the fleet page's own, not the agent page's", own)
		}
	}
	fleetRuntimes, _ := os.ReadFile(filepath.Join(root, FleetDir, RuntimesFile))
	if string(fleetRuntimes) != string(data) {
		t.Errorf("fleet/runtimes.json differs from agent/runtimes.json")
	}
	for name, want := range AppHostScripts() {
		got, err := os.ReadFile(filepath.Join(root, AppHostDir, name))
		if err != nil || string(got) != string(want) {
			t.Errorf("apphost/%s not written as embedded: %v", name, err)
		}
	}
	appHostRuntimes, _ := os.ReadFile(filepath.Join(root, AppHostDir, RuntimesFile))
	if string(appHostRuntimes) != string(data) {
		t.Errorf("apphost/runtimes.json differs from agent/runtimes.json")
	}
	// The old addresses go to the page, preselecting
	stub, _ := os.ReadFile(filepath.Join(root, AgentDir, "python", "index.html"))
	if !strings.Contains(string(stub), `url=../?runtime=python`) || !strings.Contains(string(stub), `location.replace("../?runtime=python" + location.hash)`) {
		t.Errorf("redirect: %s", stub)
	}
	// Each agent site links to the page, its machine preselected; the others are untouched
	page, _ := os.ReadFile(filepath.Join(root, "python", "index.html"))
	if !strings.Contains(string(page), `id="agent-link" href="../agent/?runtime=python"`) {
		t.Errorf("link: %s", page)
	}
	for _, left := range []string{"elixir"} {
		if _, err := os.Stat(filepath.Join(root, AgentDir, left)); err == nil {
			t.Errorf("%s is on the agent page", left)
		}
	}

	// The page's service worker and the preview's shared part are among its files
	for _, f := range []string{"sw.js", "preview.js", "preview-hook.js", "inspect.js", "ws-client.js"} {
		if _, err := os.Stat(filepath.Join(root, AgentDir, f)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}

	// Again: the same
	if again, err := WriteAgentPage(root); err != nil || len(again) != 3 {
		t.Errorf("again: %v %v", again, err)
	}

	// A machine taken off the page loses its redirect; a directory that isn't a stub is left alone
	if err := os.WriteFile(filepath.Join(root, AgentDir, "notes.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(root, AgentDir, "keep"), 0o755)
	os.WriteFile(filepath.Join(root, AgentDir, "keep", "index.html"), []byte("<p>someone's own page</p>"), 0o644)
	os.RemoveAll(filepath.Join(root, "duckdb"))
	os.RemoveAll(filepath.Join(root, "java"))
	if again, err := WriteAgentPage(root); err != nil || len(again) != 1 {
		t.Fatalf("without duckdb: %v %v", again, err)
	}
	if _, err := os.Stat(filepath.Join(root, AgentDir, "duckdb")); err == nil {
		t.Error("duckdb's redirect outlived it")
	}
	for _, kept := range []string{"python/index.html", "keep/index.html", "notes.txt"} {
		if _, err := os.Stat(filepath.Join(root, AgentDir, kept)); err != nil {
			t.Errorf("%s was removed: %v", kept, err)
		}
	}
	data, _ = os.ReadFile(filepath.Join(root, AgentDir, RuntimesFile))
	json.Unmarshal(data, &man)
	if strings.Join(man.ExposedTo, ",") != "https://chatgpt.com" {
		t.Errorf("exposed to, python alone: %v", man.ExposedTo)
	}
}

// An example built twice (for one CPU, for the X card, and for two) is one machine: the site named
// after its source, and the other's "For agents" link goes to it
func TestWriteAgentPageOneMachinePerSource(t *testing.T) {
	root := t.TempDir()
	two := agentRun("Supabase", 2)
	two["source"] = "examples/supabase"
	one := agentRun("Supabase", 1)
	one["source"] = "examples/supabase"
	fakeSite(t, root, "supabase", two, "armless")
	fakeSite(t, root, "supabase-1cpu", one, "armless")
	fakeSite(t, root, "web", agentRun("Web", 1), "armless")
	runtimes, err := WriteAgentPage(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtimes) != 2 || runtimes[0].Name != "supabase" || runtimes[0].CPUs != 2 || runtimes[1].Name != "web" {
		t.Fatalf("runtimes: %+v", runtimes)
	}
	if _, err := os.Stat(filepath.Join(root, AgentDir, "supabase-1cpu")); err == nil {
		t.Error("the one-CPU build has a redirect of its own")
	}
	page, _ := os.ReadFile(filepath.Join(root, "supabase-1cpu", "index.html"))
	if !strings.Contains(string(page), `href="../agent/?runtime=supabase"`) {
		t.Errorf("supabase-1cpu's link: %s", page)
	}
	for source, want := range map[string]string{"examples/supabase": "supabase", "examples/supabase/": "supabase", "./supabase.tar": "supabase",
		"ghcr.io/me/web:1.2": "web", "localhost:5000/web": "web", "x.tar.zst": "x"} {
		if got := sourceName(source); got != want {
			t.Errorf("sourceName(%q) = %q, want %q", source, got, want)
		}
	}
}

func TestWriteAgentPageRefuses(t *testing.T) {
	t.Run("different armless", func(t *testing.T) {
		root := t.TempDir()
		fakeSite(t, root, "a", agentRun("A", 1), "one")
		fakeSite(t, root, "b", agentRun("B", 1), "two")
		if _, err := WriteAgentPage(root); err == nil || !strings.Contains(err.Error(), "same snowglobe") {
			t.Errorf("err %v", err)
		}
		if _, err := os.Stat(filepath.Join(root, AgentDir)); err == nil {
			t.Error("a refusal wrote something")
		}
	})
	for _, dir := range []string{AgentDir, FleetDir, AppHostDir} {
		t.Run("a site named "+dir, func(t *testing.T) {
			root := t.TempDir()
			fakeSite(t, root, dir, agentRun("A", 1), "x")
			if _, err := WriteAgentPage(root); err == nil {
				t.Errorf("a site named %s is refused", dir)
			}
		})
	}
	t.Run("a symlinked fleet directory", func(t *testing.T) {
		root := t.TempDir()
		fakeSite(t, root, "a", agentRun("A", 1), "x")
		os.Symlink(t.TempDir(), filepath.Join(root, FleetDir))
		if _, err := WriteAgentPage(root); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Errorf("err %v", err)
		}
		if _, err := os.Stat(filepath.Join(root, AgentDir)); err == nil {
			t.Error("a refusal wrote something")
		}
	})
	for _, name := range []string{"agent.js", "runtimes.json", "index.html", "machine-worker.js"} {
		t.Run("a site named "+name, func(t *testing.T) {
			root := t.TempDir()
			fakeSite(t, root, name, agentRun("A", 1), "x")
			if _, err := WriteAgentPage(root); err == nil || !strings.Contains(err.Error(), "collide") {
				t.Errorf("err %v", err)
			}
			if _, err := os.Stat(filepath.Join(root, AgentDir)); err == nil {
				t.Error("a refusal wrote something")
			}
		})
	}
	t.Run("a symlink", func(t *testing.T) {
		root := t.TempDir()
		fakeSite(t, root, "a", agentRun("A", 1), "x")
		os.Symlink(t.TempDir(), filepath.Join(root, AgentDir))
		if _, err := WriteAgentPage(root); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Errorf("err %v", err)
		}
	})
	t.Run("no blob location", func(t *testing.T) {
		root := t.TempDir()
		fakeSite(t, root, "a", agentRun("A", 1), "x")
		os.WriteFile(filepath.Join(root, "a", "index.html"), []byte("<html>"), 0o644)
		if _, err := WriteAgentPage(root); err == nil || !strings.Contains(err.Error(), "baseurl") {
			t.Errorf("err %v", err)
		}
	})
}

// The agent page's script, where it registers its service worker
var agentPageSource = string(agentPageJS)

// Every agent-labelled demo is one of /agent/'s machines: in the site's demos, with
// what it is for and a sample command (the page lists them from these labels), and in llms.txt
func TestTheDemoSiteHasEveryAgentRuntimeOnTheAgentPage(t *testing.T) {
	repo := filepath.Join("..", "..")
	mise, err := os.ReadFile(filepath.Join(repo, "mise.toml"))
	if err != nil {
		t.Fatal(err)
	}
	demos := regexp.MustCompile(`(?m)^DEMOS = "([^"]*)"`).FindSubmatch(mise)
	if demos == nil {
		t.Fatal("no DEMOS in mise.toml")
	}
	inDemos := map[string]bool{}
	for _, d := range strings.Fields(string(demos[1])) {
		inDemos[d] = true
	}
	llms, err := os.ReadFile(filepath.Join(repo, "site", "llms.txt"))
	if err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(repo, "site", "agent", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{`src="agent-page.js"`, `src="orchestrator.js"`, `aria-label="Command output"`, `>Run<`, `>Cancel<`, `>Copy<`, "Shell command", "Runtime<select", "Earlier runs", `role="status"`} {
		if !strings.Contains(string(page), s) {
			t.Errorf("site/agent/index.html lacks %s", s)
		}
	}
	if strings.Count(string(page), `role="status"`) != 1 {
		t.Error("the agent page has one status line that announces")
	}
	dockerfiles, _ := filepath.Glob(filepath.Join(repo, "examples", "*", "Dockerfile"))
	label := func(df, name string) string {
		m := regexp.MustCompile(`snowglobe\.` + regexp.QuoteMeta(name) + `=(?:"([^"]*)"|'([^']*)')`).FindSubmatch([]byte(df))
		if m == nil {
			return ""
		}
		return string(m[1]) + string(m[2])
	}
	// The runtimes llms.txt lists for the page: exactly the agent-labelled demos
	listed := map[string]bool{}
	if sec := regexp.MustCompile(`(?s)### The runtimes on this site\n(.*?)\n\n`).FindSubmatch(llms); sec != nil {
		for _, m := range regexp.MustCompile("(?m)^- runtime `([a-z0-9._-]+)`").FindAllSubmatch(sec[1], -1) {
			listed[string(m[1])] = true
		}
	}
	found := 0
	labelled := map[string]bool{}
	for _, f := range dockerfiles {
		data, _ := os.ReadFile(f)
		df := string(data)
		if label(df, "agent") != "true" {
			continue
		}
		dir := filepath.Base(filepath.Dir(f))
		// The machine's name on the page: its directory's, or snowglobe.agent-name
		name := dir
		if n := label(df, "agent-name"); n != "" {
			name = n
		}
		found++
		labelled[name] = true
		if !inDemos[dir] {
			t.Errorf("%s is labelled for agents but is not one of the site's demos", dir)
		}
		// Several CPUs: the page is made cross-origin isolated for it (its service worker)
		if c := label(df, "cpus"); c != "" && c != "1" && !strings.Contains(string(page), `register("sw.js"`) && !strings.Contains(agentPageSource, `register("sw.js"`) {
			t.Errorf("%s: on %s CPUs, and the agent page registers no service worker to isolate it", name, c)
		}
		for _, l := range []string{"agent-purpose", "agent-sample"} {
			if label(df, l) == "" {
				t.Errorf("%s lacks the label snowglobe.%s the agent page lists it with", name, l)
			}
		}
		if !listed[name] {
			t.Errorf("llms.txt's \"The runtimes on this site\" doesn't list the runtime %s", name)
		}
		if !strings.Contains(string(page), ">"+label(df, "agent-purpose")+"<") {
			t.Errorf("site/agent/index.html's static list lacks %s's purpose line", name)
		}
	}
	for name := range listed {
		if !labelled[name] {
			t.Errorf("llms.txt lists the runtime %s, which isn't labelled for agents", name)
		}
	}
	// The machines for agent work that needs compute; the others are runs for people, on the landing page
	for _, name := range []string{"python", "postgres", "duckdb"} {
		if !labelled[name] {
			t.Errorf("%s is one of the agent page's machines, and isn't labelled for agents", name)
		}
	}
	// Python: the page for people has no network and isn't an agent site; the agent page's python is its
	// own site (python-agent) with a network, for pip install, and the name python
	for dir, want := range map[string]struct{ network, agent string }{"python": {"", ""}, "python-agent": {"fetch", "true"}} {
		data, err := os.ReadFile(filepath.Join(repo, "examples", dir, "Dockerfile"))
		if err != nil {
			t.Fatal(err)
		}
		if got := label(string(data), "network"); got != want.network {
			t.Errorf("examples/%s: network %q, want %q", dir, got, want.network)
		}
		if got := label(string(data), "agent"); got != want.agent {
			t.Errorf("examples/%s: agent %q, want %q", dir, got, want.agent)
		}
		if n := label(string(data), "agent-name"); (dir == "python-agent") != (n == "python") {
			t.Errorf("examples/%s: agent-name %q", dir, n)
		}
	}
	// The web app machines: a preview connects to their servers, so they have a network device;
	// supabase runs on 2 CPUs (the agent page is isolated for it)
	for name, cpus := range map[string]string{"supabase": "2", "web": ""} {
		data, err := os.ReadFile(filepath.Join(repo, "examples", name, "Dockerfile"))
		if err != nil {
			t.Fatal(err)
		}
		df := string(data)
		if !labelled[name] {
			t.Errorf("%s is one of the agent page's machines, and isn't labelled for agents", name)
		}
		if label(df, "network") != "fetch" {
			t.Errorf("%s: a preview needs its machine's network device (snowglobe.network=\"fetch\")", name)
		}
		if label(df, "cpus") != cpus {
			t.Errorf("%s: cpus %q, want %q", name, label(df, "cpus"), cpus)
		}
		if !strings.Contains(label(df, "agent-exposed-to"), "https://chatgpt.com") {
			t.Errorf("%s: its tools are shared with chatgpt.com, as the page's other machines'", name)
		}
	}
	if found < 3 {
		t.Errorf("%d agent runtimes; python, postgres and duckdb are", found)
	}
}
