package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// buildDaemon is a daemon whose builds run this test binary playing snowglobe build.
func buildDaemon(t *testing.T, docker bool) *daemonUnderTest {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	t.Setenv("SNOWGLOBE_FAKE_BUILD", "1")
	self, _ := os.Executable()
	return startDaemon(t, shortTemp(t), Options{Snowglobe: self, dockerThere: func() bool { return docker }})
}

func waitBuild(t *testing.T, d *daemonUnderTest, id string) *Build {
	t.Helper()
	var b *Build
	waitFor(t, func() bool {
		var err error
		b, err = d.c.Build(id)
		return err == nil && b.finished()
	})
	return b
}

func TestABuildBecomesATemplateWithItsLog(t *testing.T) {
	d := buildDaemon(t, true)
	defer d.stop(t)
	dir := t.TempDir()
	b, err := d.c.StartBuild(BuildRequest{Name: "app", Source: dir, Network: "fetch", Memory: 256})
	if err != nil {
		t.Fatal(err)
	}
	if b.Kind != "dir" || b.Builder != "docker" || b.Status != "queued" {
		t.Errorf("as started: %+v", b)
	}
	b = waitBuild(t, d, b.ID)
	if b.Status != "done" || b.Template != "app" || b.Started == nil || b.Ended == nil {
		t.Fatalf("built: %+v", b)
	}
	ts, _ := d.c.Templates()
	if len(ts) != 1 || ts[0].Name != "app" || ts[0].Site != b.Site {
		t.Errorf("its template: %+v", ts)
	}
	defer d.c.RemoveTemplate("app")
	log, err := d.c.BuildLog(b.ID, 0)
	if err != nil || !strings.Contains(log, "snowglobe build "+dir+" --out "+b.Site+" --sandbox --builder docker --network fetch --memory 256") || !strings.Contains(log, "==> done") {
		t.Errorf("log: %q %v", log, err)
	}
	if rest, _ := d.c.BuildLog(b.ID, int64(len(log)-7)); rest != "> done\n" {
		t.Errorf("from an offset: %q", rest)
	}
	// The template runs from it: the build stays
	if err := d.c.RemoveBuild(b.ID); statusOf(err) != 409 {
		t.Errorf("removed under its template: %v", err)
	}
	d.c.RemoveTemplate("app")
	if err := d.c.RemoveBuild(b.ID); err != nil {
		t.Error(err)
	}
	if _, err := os.Stat(b.Site); !os.IsNotExist(err) {
		t.Errorf("its site is still there: %v", err)
	}
	evs := strings.Join(kinds(d.s.Recent()), " ")
	for _, k := range []string{"build.queued", "build.started", "build.done", "template.added"} {
		if !strings.Contains(evs, k) {
			t.Errorf("no %s in %s", k, evs)
		}
	}
}

func TestADockerfileWrittenHereBuilds(t *testing.T) {
	d := buildDaemon(t, true)
	defer d.stop(t)
	b, err := d.c.StartBuild(BuildRequest{Name: "df", Dockerfile: "FROM alpine:3.24.2\nCMD [\"sh\"]\n", NoTemplate: true})
	if err != nil {
		t.Fatal(err)
	}
	b = waitBuild(t, d, b.ID)
	data, _ := os.ReadFile(filepath.Join(b.Source, "Dockerfile"))
	if b.Kind != "dockerfile" || b.Status != "done" || b.Template != "" || !strings.HasPrefix(string(data), "FROM alpine") {
		t.Errorf("%+v %q", b, data)
	}
	if ts, _ := d.c.Templates(); len(ts) != 0 {
		t.Errorf("a template though asked for none: %+v", ts)
	}
}

func TestAnImageBuildsNativelyWithoutDocker(t *testing.T) {
	d := buildDaemon(t, false)
	defer d.stop(t)
	b, err := d.c.StartBuild(BuildRequest{Name: "img", Source: "alpine:3.24.2", NoTemplate: true})
	if err != nil {
		t.Fatal(err)
	}
	if b.Kind != "image" || b.Builder != "native" {
		t.Errorf("%+v", b)
	}
	waitBuild(t, d, b.ID)
	// A Dockerfile needs Docker
	if _, err := d.c.StartBuild(BuildRequest{Dockerfile: "FROM alpine"}); statusOf(err) != 400 || !strings.Contains(err.Error(), "needs Docker") {
		t.Errorf("a Dockerfile without Docker: %v", err)
	}
}

func TestAFailedBuildSaysWhy(t *testing.T) {
	d := buildDaemon(t, true)
	defer d.stop(t)
	b, _ := d.c.StartBuild(BuildRequest{Name: "bad", Source: "example.com/fail:1"})
	b = waitBuild(t, d, b.ID)
	if b.Status != "failed" || !strings.Contains(b.Error, "exited 3") || !strings.Contains(b.Error, "no such image") {
		t.Errorf("%+v", b)
	}
	if ts, _ := d.c.Templates(); len(ts) != 0 {
		t.Errorf("a template of a failed build: %+v", ts)
	}
}

func TestABuildIsCancelledAndOthersWaitTheirTurn(t *testing.T) {
	old := maxBuilds
	maxBuilds = 1
	t.Cleanup(func() { maxBuilds = old })
	d := buildDaemon(t, true)
	defer d.stop(t)
	slow, _ := d.c.StartBuild(BuildRequest{Name: "slow", Source: "example.com/slow:1"})
	next, _ := d.c.StartBuild(BuildRequest{Name: "next", Source: "example.com/next:1"})
	waitFor(t, func() bool { b, _ := d.c.Build(slow.ID); return b.Status == "running" })
	if b, _ := d.c.Build(next.ID); b.Status != "queued" {
		t.Errorf("the second, with one slot: %s", b.Status)
	}
	begun := time.Now()
	if err := d.c.RemoveBuild(slow.ID); err != nil {
		t.Fatal(err)
	}
	if b := waitBuild(t, d, slow.ID); b.Status != "cancelled" {
		t.Errorf("cancelled: %+v", b)
	}
	if b := waitBuild(t, d, next.ID); b.Status != "done" || time.Since(begun) > 20*time.Second {
		t.Errorf("the next, once the slot was free: %+v", b)
	}
	d.c.RemoveTemplate("next")
}

func TestBuildRequestsThatCantBeBuiltAreRefused(t *testing.T) {
	d := buildDaemon(t, true)
	defer d.stop(t)
	file := filepath.Join(t.TempDir(), "f")
	os.WriteFile(file, nil, 0o644)
	for name, req := range map[string]BuildRequest{
		"nothing":       {},
		"both":          {Source: "alpine", Dockerfile: "FROM alpine"},
		"a bad name":    {Name: "no spaces", Source: "alpine"},
		"a bad network": {Source: "alpine", Network: "lan"},
		"a file":        {Source: file},
		"a builder":     {Source: "alpine", Builder: "podman"},
		"relative":      {Source: "."},
	} {
		if _, err := d.c.StartBuild(req); statusOf(err) != 400 {
			t.Errorf("%s: %v", name, err)
		}
	}
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "taken"})
	defer d.c.RemoveTemplate("taken")
	if _, err := d.c.StartBuild(BuildRequest{Name: "taken", Source: "alpine"}); statusOf(err) != 409 {
		t.Errorf("a template's name: %v", err)
	}
	if bs, _ := d.c.Builds(); len(bs) != 0 {
		t.Errorf("refused builds kept: %+v", bs)
	}
}

func TestABuildRunningWhenTheDaemonStoppedIsInterrupted(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	t.Setenv("SNOWGLOBE_FAKE_BUILD", "1")
	self, _ := os.Executable()
	dir := shortTemp(t)
	o := Options{Snowglobe: self, dockerThere: func() bool { return true }}
	d := startDaemon(t, dir, o)
	done, _ := d.c.StartBuild(BuildRequest{Name: "kept", Source: "example.com/a:1", NoTemplate: true})
	waitBuild(t, d, done.ID)
	slow, _ := d.c.StartBuild(BuildRequest{Name: "cut", Source: "example.com/slow:1"})
	waitFor(t, func() bool { b, _ := d.c.Build(slow.ID); return b.Status == "running" })
	d.stop(t)
	d = startDaemon(t, dir, o)
	defer d.stop(t)
	defer d.c.RemoveBuild(slow.ID)
	if b, _ := d.c.Build(done.ID); b == nil || b.Status != "done" {
		t.Errorf("a finished build, after a restart: %+v", b)
	}
	if b, _ := d.c.Build(slow.ID); b == nil || b.Status != "interrupted" {
		t.Errorf("a running one: %+v", b)
	}
}

// A build cancelled while its template restores ends cancelled, with no template
func TestABuildCancelledAsItsTemplateRestoresLeavesNone(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_RESTORE_DELAY", "1s")
	d := buildDaemon(t, true)
	defer d.stop(t)
	b, err := d.c.StartBuild(BuildRequest{Name: "app", Source: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	// Built: its template restoring
	waitFor(t, func() bool { log, _ := d.c.BuildLog(b.ID, 0); return strings.Contains(log, "==> done") })
	time.Sleep(200 * time.Millisecond)
	if err := d.c.RemoveBuild(b.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { cur, _ := d.c.Build(b.ID); return cur != nil && cur.Ended != nil })
	time.Sleep(1500 * time.Millisecond)
	if cur, _ := d.c.Build(b.ID); cur.Status != "cancelled" || cur.Template != "" {
		t.Errorf("build: %+v", cur)
	}
	if ts, _ := d.c.Templates(); len(ts) != 0 {
		t.Errorf("templates: %+v", ts)
	}
}
