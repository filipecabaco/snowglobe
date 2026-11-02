package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// cli runs snowglobe with args: its exit status, stdout and stderr.
func cli(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	capture := func(f **os.File) func() string {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		old := *f
		*f = w
		done := make(chan string)
		go func() { data, _ := io.ReadAll(r); done <- string(data) }()
		return func() string { w.Close(); *f = old; return <-done }
	}
	stdout, stderr := capture(&os.Stdout), capture(&os.Stderr)
	code := run(args)
	return code, stdout(), stderr()
}

// isolated keeps the run away from this machine's instances, cache and Docker.
func isolated(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
}

func TestVersionAndHelp(t *testing.T) {
	version = "v9.9.9"
	t.Cleanup(func() { version = "" })
	if code, out, _ := cli(t, "version"); code != 0 || out != "snowglobe v9.9.9\n" {
		t.Errorf("version: %d %q", code, out)
	}
	if code, out, _ := cli(t, "--help"); code != 0 || out != usage {
		t.Errorf("help: %d", code)
	}
	if code, _, errOut := cli(t); code != 2 || errOut != usage {
		t.Errorf("no command: %d", code)
	}
	if code, _, errOut := cli(t, "frobnicate"); code != 2 || !strings.HasPrefix(errOut, `unknown command "frobnicate"`) {
		t.Errorf("an unknown command: %d %q", code, errOut)
	}
}

func TestCommandsCheckTheirArguments(t *testing.T) {
	isolated(t)
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"build"}, "build takes exactly one source"},
		{[]string{"build", "--memory", "lots", "alpine"}, "invalid value"},
		{[]string{"serve", t.TempDir()}, "index.html not found"},
		{[]string{"pool"}, "pool takes one directory"},
		{[]string{"pwa"}, "pwa takes one built site directory"},
		{[]string{"pack", "a", "b"}, "pack takes one built site directory"},
		{[]string{"bundle"}, "bundle takes one built site"},
		{[]string{"bundle", "--runtime", "", "--target", "windows", t.TempDir()}, "--target windows: linux or darwin"},
		{[]string{"warm", "site"}, "warm takes a built site"},
		{[]string{"run", "--max-runtime", "soon"}, "a duration"},
		{[]string{"run", t.TempDir()}, "isn't a built snowglobe site"},
		{[]string{"exec", "web"}, "exec takes an instance name and a command"},
		{[]string{"exec", "web", "ls"}, "no instance called web"},
		{[]string{"sh", "web"}, "sh takes an instance name and a command"},
		{[]string{"sh", "web", "ls"}, "no instance called web"},
		// The command's own flags, unquoted: say how to pass them
		{[]string{"sh", "web", "ls", "-l"}, "flag provided but not defined: -l: quote the command, as in snowglobe sh web 'ls -l'"},
		{[]string{"cp", "a"}, "cp takes a source and a destination"},
		{[]string{"cp", "a", "b"}, "one side is name:/path"},
		{[]string{"mcp"}, "mcp takes a built site"},
		{[]string{"attach"}, "attach takes an instance name"},
		{[]string{"attach", "web"}, "no instance called web"},
		{[]string{"stop"}, "stop takes an instance name"},
		{[]string{"stop", "web"}, "no instance called web"},
	} {
		code, _, errOut := cli(t, tc.args...)
		if code != 1 || !strings.Contains(errOut, tc.want) {
			t.Errorf("snowglobe %s: exit %d, %q; want %q", strings.Join(tc.args, " "), code, errOut, tc.want)
		}
	}
}

func TestPsWithNothingRunning(t *testing.T) {
	isolated(t)
	if code, out, _ := cli(t, "ps"); code != 0 || out != "no instances running\n" {
		t.Errorf("%d %q", code, out)
	}
}

func TestPackPoolAndWarm(t *testing.T) {
	isolated(t)
	root := t.TempDir()
	site := filepath.Join(root, "demo")
	write := func(p, data string) {
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(data), 0o644)
	}
	write(filepath.Join(site, ".snowglobe"), "")
	write(filepath.Join(site, "run.json"), `{"title":"demo"}`)
	write(filepath.Join(site, "index.html"), `<head></head><script>armless({ baseurl: "system/filesystem/", })</script>`)
	write(filepath.Join(site, "system", "filesystem.json"),
		`{"version":3,"size":3,"fsroot":[["a",3,0,33188,0,0,"aaaaaaaaaa.bin.zst"]]}`)
	write(filepath.Join(site, "system", "filesystem", "aaaaaaaaaa.bin.zst"), "AAA")

	// Flags after the site, the name of the tarball given
	archive := filepath.Join(t.TempDir(), "demo.tar.zst")
	if code, out, errOut := cli(t, "pack", site, "-o", archive); code != 0 || !strings.HasPrefix(out, archive+": ") {
		t.Fatalf("pack: %d %q %q", code, out, errOut)
	}
	if _, err := os.Stat(archive); err != nil {
		t.Fatal(err)
	}
	// One executable: a runtime and the site
	vm := filepath.Join(t.TempDir(), "snowglobe-vm")
	write(vm, "#!vm")
	bundled := filepath.Join(t.TempDir(), "demo-bin")
	if code, out, errOut := cli(t, "bundle", site, "--runtime", vm, "-o", bundled); code != 0 || !strings.HasPrefix(out, bundled+": ") {
		t.Fatalf("bundle: %d %q %q", code, out, errOut)
	}
	// An installable app
	if code, out, errOut := cli(t, "pwa", site, "--name", "Demo"); code != 0 || !strings.Contains(out, "installable app") {
		t.Fatalf("pwa: %d %q %q", code, out, errOut)
	}

	// It runs as a site: unpacked, then refused for want of a runtime here
	if code, _, errOut := cli(t, "run", "--runtime", "vmware", archive); code != 1 || !strings.Contains(errOut, "--runtime vmware") {
		t.Errorf("run a tarball: %d %q", code, errOut)
	}

	if code, out, errOut := cli(t, "pool", root); code != 0 || !strings.HasPrefix(out, "Pooled 1 sites: 1 files, 1 unique") {
		t.Fatalf("pool: %d %q %q", code, out, errOut)
	}
	if _, err := os.Stat(filepath.Join(root, "blobs", "aaaaaaaaaa.bin.zst")); err != nil {
		t.Error("not pooled")
	}

	// What a run read goes into the warm pack, from the pool
	reads := filepath.Join(t.TempDir(), "reads.json")
	write(reads, `{"boot":["aaaaaaaaaa.bin.zst"],"exercise":{}}`)
	if code, out, errOut := cli(t, "warm", site, reads); code != 0 || out != "Recorded 1 files: 1 new in the warm pack, now 1 files, 0.0 MB\n" {
		t.Fatalf("warm: %d %q %q", code, out, errOut)
	}
}

func TestParseTakesFlagsAnywhere(t *testing.T) {
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	n := fs.Int("n", 0, "")
	v := fs.Bool("v", false, "")
	got, err := parse(fs, []string{"a", "-n", "3", "b", "-v", "c"})
	if err != nil || !slices.Equal(got, []string{"a", "b", "c"}) || *n != 3 || !*v {
		t.Errorf("got %q, n=%d v=%v, %v", got, *n, *v, err)
	}
	fs.SetOutput(io.Discard)
	if _, err := parse(fs, []string{"a", "-nope"}); err == nil {
		t.Error("an unknown flag")
	}
}

func TestToolsPrintsTheImagesTag(t *testing.T) {
	isolated(t)
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nexit 0\n"), 0o755)
	t.Setenv("PATH", bin)
	if code, out, _ := cli(t, "tools"); code != 0 || !strings.HasPrefix(out, "snowglobe-tools:") {
		t.Errorf("%d %q", code, out)
	}
}

// mcp starts the site natively when no instance of it runs: here there is no snowglobe-vm to
func TestMCPNeedsARuntimeToStartTheSite(t *testing.T) {
	isolated(t)
	t.Setenv("SNOWGLOBE_VM", "")
	site := t.TempDir()
	os.WriteFile(filepath.Join(site, "run.json"), []byte(`{"title":"demo","network":"none"}`), 0o644)
	os.MkdirAll(filepath.Join(site, "system", "filesystem"), 0o755)
	code, _, errOut := cli(t, "mcp", site)
	if code != 1 || !strings.Contains(errOut, "no snowglobe-vm for this system") {
		t.Errorf("%d %q", code, errOut)
	}
}
