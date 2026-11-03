package instance

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/tools"
)

// fakeDocker puts a docker on the PATH that logs its arguments, one call a line, and then runs
// script (a POSIX sh body, with the arguments in $@). It returns the log's path.
func fakeDocker(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	body := "#!/bin/sh\necho \"$*\" >> '" + log + "'\n" + script + "\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

// lastCall is the last docker command the fake ran, as its arguments.
func lastCall(t *testing.T, log string) string {
	t.Helper()
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	return lines[len(lines)-1]
}

// builtSite is a site as snowglobe build leaves it, with this run.json.
func builtSite(t *testing.T, runJSON string) string {
	t.Helper()
	site := fakeSite(t)
	if err := os.WriteFile(filepath.Join(site, "run.json"), []byte(runJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	return site
}

// noProxy clears the host's proxy settings, which would change a container's network.
func noProxy(t *testing.T) {
	for _, v := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
		"NO_PROXY", "no_proxy", "SSL_CERT_FILE", "ARMLESS_JIT"} {
		t.Setenv(v, "")
	}
}

func TestRunADetachedContainer(t *testing.T) {
	noProxy(t)
	log := fakeDocker(t, "exit 0")
	site := builtSite(t, `{"memory_mb":256,"network":"none"}`)
	if err := Run(Options{Site: site, Name: "web", Detach: true}, "dev"); err != nil {
		t.Fatal(err)
	}
	got := lastCall(t, log)
	// The sandbox: unprivileged, read-only, capped, offline, the site read-only
	for _, want := range []string{
		"run --rm --init --label " + label + "=" + site, "--user 65534:65534 --read-only", "--cap-drop ALL",
		"--security-opt no-new-privileges", "--memory 1024m", "-v " + site + ":/site:ro", "--network none",
		"--name web --detach snowglobe-tools:" + tools.Version() + " " + tools.VM + " run /site --detached",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("%q isn't in docker %s", want, got)
		}
	}
}

func TestRunAContainerWithANetwork(t *testing.T) {
	noProxy(t)
	log := fakeDocker(t, "exit 0")
	site := builtSite(t, `{"memory_mb":512,"network":"fetch","tunnels":[{"port":5432,"url":"wss://gw/db"}]}`)
	reads := filepath.Join(t.TempDir(), "reads.json")
	o := Options{Site: site, Name: "api", Detach: true, Publish: []string{"8080:8000", "0.0.0.0:9090:9000"}, RecordReads: reads}
	if err := Run(o, "dev"); err != nil {
		t.Fatal(err)
	}
	got := lastCall(t, log)
	// Each port through a high one the unprivileged container listens on
	for _, want := range []string{
		"-p 127.0.0.1:8080:20000", "-p 0.0.0.0:9090:20001", "--forward 20000:8000", "--forward 20001:9000",
		"--tunnel 5432=wss://gw/db", "-v " + reads + ":/record/reads.json", "--record-reads /record/reads.json",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("%q isn't in docker %s", want, got)
		}
	}
	if strings.Contains(got, "--network none") {
		t.Error("a guest with a network was run offline")
	}
	// The container (nobody) writes the reads into a file made here, open to it
	st, err := os.Stat(reads)
	if err != nil || st.Mode().Perm() != 0o666 {
		t.Fatalf("reads file: %v %v", st, err)
	}
}

func TestRunAPooledSiteMountsItsBlobs(t *testing.T) {
	noProxy(t)
	log := fakeDocker(t, "exit 0")
	root := t.TempDir()
	site := filepath.Join(root, "demo")
	os.MkdirAll(filepath.Join(root, "blobs"), 0o755)
	os.MkdirAll(site, 0o755)
	os.WriteFile(filepath.Join(site, "run.json"), []byte(`{"network":"none"}`), 0o644)
	if err := Run(Options{Site: site, Name: "p", Detach: true}, "dev"); err != nil {
		t.Fatal(err)
	}
	if got := lastCall(t, log); !strings.Contains(got, "-v "+filepath.Join(root, "blobs")+":/blobs:ro") ||
		!strings.Contains(got, "--blobs /blobs") {
		t.Errorf("docker %s", got)
	}
}

func TestRunAttachedEndsWithTheRunsExitStatus(t *testing.T) {
	noProxy(t)
	log := fakeDocker(t, `[ "$1" = run ] && exit 124; exit 0`)
	err := Run(Options{Site: builtSite(t, `{"network":"none"}`), MaxRuntime: 90 * time.Second}, "dev")
	if (err != ExitError{Code: 124}) {
		t.Fatalf("got %v", err)
	}
	if got := lastCall(t, log); !strings.Contains(got, "--interactive") || !strings.Contains(got, "--max-runtime 90") {
		t.Errorf("docker %s", got)
	}
}

func TestRunRefuses(t *testing.T) {
	noProxy(t)
	fakeDocker(t, "exit 0")
	pooled := filepath.Join(t.TempDir(), "demo")
	os.MkdirAll(pooled, 0o755)
	os.WriteFile(filepath.Join(pooled, "run.json"), []byte(`{"network":"none"}`), 0o644)
	offline := builtSite(t, `{"network":"none"}`)
	online := builtSite(t, `{"network":"fetch"}`)
	for _, tc := range []struct {
		name string
		o    Options
		want string
	}{
		{"not a site", Options{Site: t.TempDir()}, "isn't a built snowglobe site"},
		{"a broken run.json", Options{Site: builtSite(t, `{`)}, "unexpected end"},
		{"tunnels without a network", Options{Site: offline, Tunnels: []string{"5432=wss://gw"}}, "need a guest with a network"},
		{"a bad tunnel", Options{Site: online, Tunnels: []string{"nope"}}, "nope"},
		{"an unknown runtime", Options{Site: offline, Runtime: "vmware"}, "--runtime vmware"},
		{"ports without a network", Options{Site: offline, Publish: []string{"80"}}, "-p needs a guest with a network"},
		{"a bad port", Options{Site: online, Publish: []string{"http"}}, "-p http"},
		{"a negative time limit", Options{Site: offline, MaxRuntime: -time.Second}, "--max-runtime"},
		{"no blobs", Options{Site: pooled}, "neither system/filesystem nor a pooled ../blobs"},
		{"detached without a name", Options{Site: offline, Detach: true}, "needs --name"},
		{"a fork in a container", Options{Site: offline, Runtime: "docker", Fork: true, Detach: true, Name: "f"}, "--fork needs --runtime native"},
	} {
		if err := Run(tc.o, "dev"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestRunWithoutDockerIsNative(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir()) // no docker
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_VM", self)
	t.Setenv("SNOWGLOBE_FAKE_VM", "listen")
	if err := Run(Options{Site: builtSite(t, `{"network":"none"}`), Name: "native-run", Detach: true, LogDir: t.TempDir()}, "dev"); err != nil {
		t.Fatal(err)
	}
	st, _, ok := loadNative("native-run")
	if !ok || st.VM != self {
		t.Fatalf("not running natively: %+v", st)
	}
	out := captureStdout(t, func() {
		if err := List(); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "native-run\t") || !strings.Contains(out, "native (pid ") {
		t.Errorf("ps: %q", out)
	}
	if err := Stop("native-run"); err != nil {
		t.Fatal(err)
	}
	if !gone(st.Pid, 5*time.Second) {
		t.Fatal("still running")
	}
}

func TestContainerInstances(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	log := fakeDocker(t, `[ "$1" = ps ] && case "$*" in *Names*RunningFor*) printf 'box\t/sites/a\t2 minutes ago\n' ;; *) echo box ;; esac; exit 0`)
	if err := Exec("box", []string{"ls", "-l"}); err != nil {
		t.Fatal(err)
	}
	if got := lastCall(t, log); got != "exec --interactive box "+tools.VM+" exec ls -l" {
		t.Errorf("exec: docker %s", got)
	}
	if err := Attach("box"); err != nil {
		t.Fatal(err)
	}
	if got := lastCall(t, log); !strings.HasSuffix(got, "box "+tools.VM+" attach") {
		t.Errorf("attach: docker %s", got)
	}
	out := captureStdout(t, func() {
		if err := List(); err != nil {
			t.Error(err)
		}
	})
	if out != "NAME\tSITE\tSTARTED\tRUNTIME\nbox\t/sites/a\t2 minutes ago\tcontainer\n" {
		t.Errorf("ps: %q", out)
	}
	if err := Stop("box"); err != nil {
		t.Fatal(err)
	}
	if got := lastCall(t, log); got != "rm --force box" {
		t.Errorf("stop: docker %s", got)
	}
	// Another name isn't one of them
	for name, fn := range map[string]func() error{
		"exec":   func() error { return Exec("other", []string{"ls"}) },
		"attach": func() error { return Attach("other") },
		"stop":   func() error { return Stop("other") },
	} {
		if err := fn(); err == nil || !strings.Contains(err.Error(), "no instance called other") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestNoInstancesRunning(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	out := captureStdout(t, func() {
		if err := List(); err != nil {
			t.Error(err)
		}
	})
	if out != "no instances running\n" {
		t.Errorf("got %q", out)
	}
}

func TestExecAndAttachANativeInstance(t *testing.T) {
	fakeJobInstance(t, "web", func(jobRequest) any { return nil })
	st, dir, ok := loadNative("web")
	if !ok {
		t.Fatal("not running")
	}
	// snowglobe-vm: what it was asked, and exit 3
	args := filepath.Join(t.TempDir(), "args")
	st.VM = filepath.Join(t.TempDir(), "snowglobe-vm")
	os.WriteFile(st.VM, []byte("#!/bin/sh\necho \"$*\" >> '"+args+"'\nexit 3\n"), 0o755)
	if err := writeState(dir, *st); err != nil {
		t.Fatal(err)
	}
	if err := Exec("web", []string{"uname", "-a"}); (err != ExitError{Code: 3}) {
		t.Errorf("exec: %v", err)
	}
	if err := Attach("web"); (err != ExitError{Code: 3}) {
		t.Errorf("attach: %v", err)
	}
	data, _ := os.ReadFile(args)
	want := []string{"exec --socket " + st.Socket + " uname -a", "attach --socket " + st.Socket}
	if got := strings.Split(strings.TrimSpace(string(data)), "\n"); !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExitStatus(t *testing.T) {
	err := exitStatus(start(t, "sh", "-c", "exit 7").Wait())
	if (err != ExitError{Code: 7}) || err.Error() != "exit status 7" {
		t.Errorf("got %v", err)
	}
	if exitStatus(nil) != nil {
		t.Error("success")
	}
	other := os.ErrNotExist
	if exitStatus(other) != other {
		t.Error("other errors pass through")
	}
}

func TestLogsDir(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	base, _ := os.UserCacheDir()
	if got, err := LogsDir("web"); err != nil || got != filepath.Join(base, "snowglobe", "logs", "web") {
		t.Errorf("got %s, %v", got, err)
	}
}

// start starts a command.
func start(t *testing.T, name string, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	return cmd
}

func TestAnAttachedNativeRunEndsWithItsExitStatus(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_FAKE_VM", "fail")
	for _, name := range []string{"", "named"} {
		o := Options{Name: name, LogDir: t.TempDir(), Publish: []string{"8080:80"}}
		if err := runNative(o, fakeSite(t), self, "fetch", nil); (err != ExitError{Code: 1}) {
			t.Errorf("%q: got %v", name, err)
		}
	}
	// A named run is forgotten once it ends
	if _, dir, ok := loadNative("named"); ok {
		t.Error("still counts as running")
	} else if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("its directory was kept: %v", err)
	}
	if err := runNative(Options{Publish: []string{"80"}}, fakeSite(t), self, "none", nil); err == nil {
		t.Error("ports without a network")
	}
}
