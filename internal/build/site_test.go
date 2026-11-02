package build

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveCPUs(t *testing.T) {
	for _, tc := range []struct {
		name            string
		o               Options
		labels          map[string]string
		cpus, buildCPUs int
	}{
		{"defaults", Options{}, nil, 1, DefaultBuildCPUs},
		{"from labels", Options{}, map[string]string{"snowglobe.cpus": "2", "snowglobe.build-cpus": "2"}, 2, 2},
		{"more than the build default", Options{CPUs: 6}, nil, 6, 6},
		{"flags win", Options{CPUs: 3, BuildCPUs: 5}, map[string]string{"snowglobe.cpus": "2"}, 3, 5},
	} {
		s, err := Resolve(tc.o, image(tc.labels, "sh"))
		if err != nil || s.CPUs != tc.cpus || s.BuildCPUs != tc.buildCPUs {
			t.Errorf("%s: got %d and %d, %v", tc.name, s.CPUs, s.BuildCPUs, err)
		}
	}
	for name, tc := range map[string]struct {
		o      Options
		labels map[string]string
	}{
		"too many cpus":              {Options{CPUs: MaxCPUs + 1}, nil},
		"cpus not a number":          {Options{}, map[string]string{"snowglobe.cpus": "two"}},
		"build-cpus not a number":    {Options{}, map[string]string{"snowglobe.build-cpus": "lots"}},
		"fewer build cpus than cpus": {Options{CPUs: 4, BuildCPUs: 2}, nil},
		"too many build cpus":        {Options{BuildCPUs: MaxCPUs + 1}, nil},
	} {
		if _, err := Resolve(tc.o, image(tc.labels, "sh")); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestResolveConsoleAndWarm(t *testing.T) {
	img := image(map[string]string{"snowglobe.warm": `^/usr/lib/`}, "server")
	img.Config.Entrypoint = []string{"/entry"}
	img.Config.Env = []string{"A=1"}
	img.Config.WorkingDir = "/app"
	s, err := Resolve(Options{}, img)
	if err != nil {
		t.Fatal(err)
	}
	if s.Command != "'/entry' 'server'" || s.Console.Command != s.Command || s.Console.Workdir != "/app" || s.Console.Env[0] != "A=1" {
		t.Errorf("%+v", s)
	}
	if s.Warm == nil || !s.Warm.MatchString("/usr/lib/libc.so") {
		t.Errorf("warm pattern from the label: %v", s.Warm)
	}
}

func TestDescribeReady(t *testing.T) {
	if got := describeReady(""); got != "after 5s of quiet" {
		t.Error(got)
	}
	if got := describeReady(`iex(1)> "`); got != `"iex(1)> \""` {
		t.Error(got)
	}
}

func TestFirst(t *testing.T) {
	if first() != "" || first("", "") != "" || first("", "b", "c") != "b" {
		t.Error("first non-empty value")
	}
}

func TestPrepareOutOnlyDeletesItsOwnDirectory(t *testing.T) {
	// A directory that isn't there, or is empty, becomes one
	for _, out := range []string{filepath.Join(t.TempDir(), "new"), t.TempDir()} {
		if err := prepareOut(out); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(out, marker)); err != nil {
			t.Errorf("%s: no marker", out)
		}
	}
	// One snowglobe made is emptied
	ours := t.TempDir()
	prepareOut(ours)
	os.WriteFile(filepath.Join(ours, "index.html"), []byte("old"), 0o644)
	if err := prepareOut(ours); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(ours, "index.html")); err == nil {
		t.Error("an old build was kept")
	}
	// Anything else is left alone
	theirs := t.TempDir()
	os.WriteFile(filepath.Join(theirs, "thesis.tex"), []byte("years of work"), 0o644)
	if err := prepareOut(theirs); err == nil || !strings.Contains(err.Error(), "wasn't created by snowglobe") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(theirs, "thesis.tex")); err != nil {
		t.Fatal("deleted a directory snowglobe didn't make")
	}
}

func TestPruneRuntimeKeepsTheMachineTheSiteLoads(t *testing.T) {
	for cpus, keep := range map[int]string{1: "armless.wasm", 4: "armless-smp.wasm"} {
		out := t.TempDir()
		os.MkdirAll(filepath.Join(out, "armless"), 0o755)
		for _, f := range []string{"armless.wasm", "armless-smp.wasm", "armless.js"} {
			os.WriteFile(filepath.Join(out, "armless", f), nil, 0o644)
		}
		if err := pruneRuntime(out, cpus); err != nil {
			t.Fatal(err)
		}
		for _, f := range []string{"armless.wasm", "armless-smp.wasm", "armless.js"} {
			_, err := os.Stat(filepath.Join(out, "armless", f))
			if kept := err == nil; kept != (f == keep || f == "armless.js") {
				t.Errorf("%d cpus: %s kept %v", cpus, f, kept)
			}
		}
	}
}

// warmSite is a built site with three blobs and a warm pack holding a: its directory and a
// reads.json that read b and c.
func warmSite(t *testing.T, pooled bool) (string, string) {
	t.Helper()
	root := t.TempDir()
	site := filepath.Join(root, "demo")
	system := filepath.Join(site, "system")
	blobs := filepath.Join(system, "filesystem")
	if pooled {
		blobs = filepath.Join(root, "blobs")
	}
	os.MkdirAll(system, 0o755)
	os.MkdirAll(blobs, 0o755)
	fs := `{"version":3,"size":15,"fsroot":[["bin",0,0,16877,0,0,[
		["a",3,0,33188,0,0,"aaaaaaaaaa.bin.zst"],["b",5,0,33188,0,0,"bbbbbbbbbb.bin.zst"],["c",7,0,33188,0,0,"cccccccccc.bin.zst"]]]]}`
	os.WriteFile(filepath.Join(system, "filesystem.json"), []byte(fs), 0o644)
	for _, b := range []string{"aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"} {
		os.WriteFile(filepath.Join(blobs, b+".bin.zst"), []byte("zstd:"+b), 0o644)
	}
	info, _ := json.Marshal(RunInfo{Title: "demo", MemoryMB: 256, WarmPackFiles: 0})
	os.WriteFile(filepath.Join(site, "run.json"), info, 0o644)
	reads := filepath.Join(root, "reads.json")
	os.WriteFile(reads, []byte(`{"boot":["bbbbbbbbbb.bin.zst"],"exercise":{"ls":["cccccccccc.bin.zst","unknown.bin.zst"]}}`), 0o644)
	return site, reads
}

func TestWarmAddsWhatRunsRead(t *testing.T) {
	for _, pooled := range []bool{false, true} {
		site, reads := warmSite(t, pooled)
		stats, err := Warm(site, []string{reads})
		if err != nil {
			t.Fatalf("pooled %v: %v", pooled, err)
		}
		// unknown isn't in the site's filesystem
		if stats != (WarmStats{Recorded: 3, Added: 2, Files: 2, Bytes: 30}) {
			t.Errorf("pooled %v: %+v", pooled, stats)
		}
		// run.json counts the warm pack, and keeps the rest
		var info RunInfo
		data, _ := os.ReadFile(filepath.Join(site, "run.json"))
		if json.Unmarshal(data, &info) != nil || info.WarmPackFiles != 2 || info.WarmPackBytes != 30 || info.Title != "demo" {
			t.Errorf("pooled %v: run.json %s", pooled, data)
		}
		// Again: nothing new
		if stats, err := Warm(site, []string{reads}); err != nil || stats.Added != 0 || stats.Files != 2 {
			t.Errorf("pooled %v: again %+v, %v", pooled, stats, err)
		}
	}
}

func TestWarmFails(t *testing.T) {
	site, reads := warmSite(t, false)
	if _, err := Warm(site, []string{filepath.Join(t.TempDir(), "missing.json")}); err == nil {
		t.Error("a reads file that isn't there")
	}
	bad := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(bad, []byte("{"), 0o644)
	if _, err := Warm(site, []string{bad}); err == nil {
		t.Error("a reads file that isn't JSON")
	}
	os.WriteFile(filepath.Join(site, "run.json"), []byte("{"), 0o644)
	if _, err := Warm(site, []string{reads}); err == nil || !strings.Contains(err.Error(), "run.json") {
		t.Errorf("a broken run.json: %v", err)
	}
	os.Remove(filepath.Join(site, "run.json"))
	os.Remove(filepath.Join(site, "system", "warm.pack"))
	if _, err := Warm(site, []string{reads}); err == nil || !strings.Contains(err.Error(), "isn't a built snowglobe site") {
		t.Errorf("no run.json: %v", err)
	}
}
