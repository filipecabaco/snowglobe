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
		"system/filesystem.json": "{}", "system/state.bin.zst": "state-" + name, "armless/armless.js": armless, "armless/armless.wasm": "wasm",
		"system/tls.json": "{}",
		"index.html":      `<a id="agent-link" href="../agent/?runtime=x">For agents</a> filesystem: { json: "system/filesystem.json", baseurl: "../blobs/" },`,
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

func TestWriteAgentPage(t *testing.T) {
	root := t.TempDir()
	fakeSite(t, root, "python", agentRun("Python", 1, "https://chatgpt.com"), "armless")
	fakeSite(t, root, "duckdb", agentRun("DuckDB", 1, "https://chatgpt.com", "https://b.example"), "armless")
	fakeSite(t, root, "java", agentRun("Java", 2), "armless")                                                                 // several CPUs: left out
	fakeSite(t, root, "elixir", map[string]any{"title": "Elixir", "memory_mb": 512, "network": "none", "cpus": 1}, "armless") // no --agent

	runtimes, err := WriteAgentPage(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtimes) != 2 || runtimes[0].Name != "duckdb" || runtimes[1].Name != "python" {
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
	py := man.Runtimes[1]
	if py.Base != "../python/" || py.BaseURL != "../blobs/" || py.Purpose != "Python" || py.Sample != "echo Python" || py.MemoryMB != 512 || py.Network != "none" {
		t.Errorf("python: %+v", py)
	}
	// The build id is the site's own fingerprint, as its page and saves have it
	if want, _ := Fingerprint(filepath.Join(root, "python"), Page{MemoryMB: 512, CPUs: 1, Network: "none"}); py.BuildID != want {
		t.Errorf("build id %s, want %s", py.BuildID, want)
	}
	if man.Armless.JS != "../duckdb/armless/armless.js" || man.Armless.Wasm != "../duckdb/armless/armless.wasm" || man.Xterm != "../duckdb/xterm/" {
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
	for _, left := range []string{"java", "elixir"} {
		if _, err := os.Stat(filepath.Join(root, AgentDir, left)); err == nil {
			t.Errorf("%s is on the agent page", left)
		}
	}

	// Again: the same
	if again, err := WriteAgentPage(root); err != nil || len(again) != 2 {
		t.Errorf("again: %v %v", again, err)
	}

	// A machine taken off the page loses its redirect; a directory that isn't a stub is left alone
	if err := os.WriteFile(filepath.Join(root, AgentDir, "notes.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(root, AgentDir, "keep"), 0o755)
	os.WriteFile(filepath.Join(root, AgentDir, "keep", "index.html"), []byte("<p>someone's own page</p>"), 0o644)
	os.RemoveAll(filepath.Join(root, "duckdb"))
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
	t.Run("a site named agent", func(t *testing.T) {
		root := t.TempDir()
		fakeSite(t, root, AgentDir, agentRun("A", 1), "x")
		if _, err := WriteAgentPage(root); err == nil {
			t.Error("a site named agent is refused")
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

// Every agent-labelled demo is one of /agent/'s machines: in the site's demos, on one CPU, with
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
		m := regexp.MustCompile(`snowglobe\.` + regexp.QuoteMeta(name) + `="([^"]*)"`).FindSubmatch([]byte(df))
		if m == nil {
			return ""
		}
		return string(m[1])
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
		name := filepath.Base(filepath.Dir(f))
		found++
		labelled[name] = true
		if !inDemos[name] {
			t.Errorf("%s is labelled for agents but is not one of the site's demos", name)
		}
		if c := label(df, "cpus"); c != "" && c != "1" {
			t.Errorf("%s: agent machines have one CPU", name)
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
	if found < 3 {
		t.Errorf("%d agent runtimes; python, postgres and duckdb are", found)
	}
}
