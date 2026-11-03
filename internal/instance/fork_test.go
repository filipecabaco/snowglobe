package instance

import (
	"os"
	"strings"
	"testing"
	"time"
)

// nativeFake makes this test binary snowglobe-vm, listening on whatever socket it is given.
func nativeFake(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_VM", self)
	t.Setenv("SNOWGLOBE_FAKE_VM", "listen")
}

func TestRunAForkInstance(t *testing.T) {
	nativeFake(t)
	if err := Run(Options{Site: builtSite(t, `{"network":"none"}`), Runtime: "native", Name: "tpl", Detach: true, Fork: true}, "dev"); err != nil {
		t.Fatal(err)
	}
	st, _, ok := loadNative("tpl")
	if !ok || !st.Fork || st.StopFile != "" {
		t.Fatalf("not a fork instance: %+v", st)
	}
	out := captureStdout(t, func() {
		if err := List(); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "tpl\t") || !strings.Contains(out, "native, a fork per command (pid ") {
		t.Errorf("ps: %q", out)
	}
	// Nothing lasts from one command to the next to join or type into
	for what, err := range map[string]error{"exec": Exec("tpl", []string{"ls"}), "attach": Attach("tpl")} {
		if err == nil || !strings.Contains(err.Error(), "fresh copy of its machine") {
			t.Errorf("%s: %v", what, err)
		}
	}
	// No stop file to wait on: a signal ends it
	begun := time.Now()
	if err := Stop("tpl"); err != nil {
		t.Fatal(err)
	}
	if !gone(st.Pid, 5*time.Second) || time.Since(begun) > stopGrace {
		t.Fatalf("stopped in %s", time.Since(begun))
	}
}

func TestAForkInstanceIsDetachedNamedAndLastsOneCommand(t *testing.T) {
	nativeFake(t)
	site := builtSite(t, `{"network":"fetch"}`)
	for _, tc := range []struct {
		name string
		o    Options
		want string
	}{
		{"attached", Options{Name: "f"}, "give it --detach and --name"},
		{"unnamed", Options{Detach: true}, "give it --detach and --name"},
		{"with a port", Options{Detach: true, Name: "f", Publish: []string{"80"}}, "--fork takes none of"},
		{"with a time limit", Options{Detach: true, Name: "f", MaxRuntime: time.Minute}, "--fork takes none of"},
		{"with a log dir", Options{Detach: true, Name: "f", LogDir: t.TempDir()}, "--fork takes none of"},
	} {
		tc.o.Site, tc.o.Runtime, tc.o.Fork = site, "native", true
		if err := Run(tc.o, "dev"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestOnlyShRunsOnAForkInstance(t *testing.T) {
	reqs := fakeJobInstance(t, "tpl", func(jobRequest) any { return JobResult{Status: status(0), Output: []byte("ok\n")} })
	st, dir, _ := loadNative("tpl")
	st.Fork = true
	if err := writeState(dir, *st); err != nil {
		t.Fatal(err)
	}
	if out := captureStdout(t, func() {
		if err := Shell("tpl", "true", false, 5); err != nil {
			t.Error(err)
		}
	}); out != "ok\n" {
		t.Errorf("sh: %q", out)
	}
	// cp and mcp build on commands that see each other's files
	if _, err := Job("tpl", JobRequest{Cmd: "true"}); err == nil || !strings.Contains(err.Error(), "snowglobe sh is all it takes") {
		t.Errorf("job: %v", err)
	}
	if err := Copy(t.TempDir(), "tpl:/tmp/x"); err == nil || !strings.Contains(err.Error(), "fresh copy") {
		t.Errorf("cp: %v", err)
	}
	if len(*reqs) != 1 || (*reqs)[0].Mode != "job" {
		t.Errorf("asked: %+v", *reqs)
	}
}
