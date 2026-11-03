package fleet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// fake is a daemon in memory: what it has, and the calls it got.
type fake struct {
	templates map[string]daemon.Template
	snapshots map[string]daemon.Snapshot
	services  map[string]daemon.ServiceStatus
	machines  map[string]daemon.Machine
	calls     []string
	// A job's exit status by command (0 if not here); readyAfter makes a command fail that many
	// times first
	status     map[string]int
	readyAfter map[string]int
}

func newFake() *fake {
	return &fake{templates: map[string]daemon.Template{}, snapshots: map[string]daemon.Snapshot{},
		services: map[string]daemon.ServiceStatus{}, machines: map[string]daemon.Machine{},
		status: map[string]int{}, readyAfter: map[string]int{}}
}

func notFound(what string) error { return daemon.ErrNotFound(what) }

func (f *fake) Templates() ([]daemon.Template, error) {
	var out []daemon.Template
	for _, t := range f.templates {
		out = append(out, t)
	}
	return out, nil
}
func (f *fake) Snapshots() ([]daemon.Snapshot, error) {
	var out []daemon.Snapshot
	for _, s := range f.snapshots {
		out = append(out, s)
	}
	return out, nil
}
func (f *fake) Services() ([]daemon.ServiceStatus, error) {
	var out []daemon.ServiceStatus
	for _, s := range f.services {
		out = append(out, s)
	}
	return out, nil
}
func (f *fake) Machines(map[string]string) ([]daemon.Machine, error) {
	var out []daemon.Machine
	for _, m := range f.machines {
		out = append(out, m)
	}
	return out, nil
}
func (f *fake) AddTemplate(r daemon.AddTemplate) (*daemon.Template, error) {
	f.calls = append(f.calls, "add template "+r.Name+" "+r.Site+" "+r.Snapshot)
	t := daemon.Template{Name: r.Name, Site: r.Site, Snapshot: r.Snapshot, Labels: r.Labels, Idle: r.Idle}
	f.templates[r.Name] = t
	return &t, nil
}
func (f *fake) RemoveTemplate(n string) error {
	f.calls = append(f.calls, "rm template "+n)
	if _, ok := f.templates[n]; !ok {
		return notFound(n)
	}
	delete(f.templates, n)
	return nil
}
func (f *fake) SnapshotWith(m, n string, l map[string]string) (*daemon.Snapshot, error) {
	f.calls = append(f.calls, "snapshot "+m+" as "+n)
	s := daemon.Snapshot{Name: n, Machine: m, Labels: l}
	f.snapshots[n] = s
	return &s, nil
}
func (f *fake) RemoveSnapshot(n string) error {
	f.calls = append(f.calls, "rm snapshot "+n)
	delete(f.snapshots, n)
	return nil
}
func (f *fake) AddService(s daemon.Service) (*daemon.ServiceStatus, error) {
	f.calls = append(f.calls, "add service "+s.Name)
	st := daemon.ServiceStatus{Service: s}
	f.services[s.Name] = st
	return &st, nil
}
func (f *fake) RemoveService(n string) error {
	f.calls = append(f.calls, "rm service "+n)
	delete(f.services, n)
	return nil
}
func (f *fake) Up(u daemon.Up) (*daemon.Machine, error) {
	f.calls = append(f.calls, "up "+u.Name+" of "+u.Template)
	m := daemon.Machine{Name: u.Name, Template: u.Template, Labels: u.Labels}
	f.machines[u.Name] = m
	return &m, nil
}
func (f *fake) RemoveMachine(n string) error {
	f.calls = append(f.calls, "rm machine "+n)
	delete(f.machines, n)
	return nil
}
func (f *fake) Job(n string, r control.JobRequest) (*control.JobResult, error) {
	f.calls = append(f.calls, "job "+n+": "+r.Cmd)
	s := f.status[r.Cmd]
	if f.readyAfter[r.Cmd] > 0 {
		f.readyAfter[r.Cmd]--
		s = 1
	}
	return &control.JobResult{Status: &s, Output: []byte("out of " + r.Cmd)}, nil
}

const example = `
name = "demo"

[templates.py]
build = "py"
network = "fetch"
idle = "30m"

[snapshots.ready]
template = "py"
run = ["pip install httpx", "python3 -m http.server 8000 &"]
ready = "wget -q -O- localhost:8000"

[templates.py-ready]
snapshot = "ready"

[services.web]
template = "py-ready"
ports = ["8080:8000"]
min = 0
max = 3
idle = "5m"

[machines.worker]
template = "py"
count = 2
ttl = "1h"
labels = { role = "worker" }
`

func write(t *testing.T, text string) string {
	t.Helper()
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "py"), 0o755)
	os.WriteFile(filepath.Join(dir, "py", "Dockerfile"), []byte("FROM alpine"), 0o644)
	path := filepath.Join(dir, "snowglobe.toml")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func load(t *testing.T, text string) *File {
	t.Helper()
	f, err := Load(write(t, text))
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func steps(p *Plan) []string {
	var out []string
	for _, s := range p.Steps {
		out = append(out, s.String())
	}
	return out
}

func quiet(string, ...any) {}

// builds records what was built, and makes the output a site
type builds struct{ done []string }

func (b *builds) build(dir, out, network string) error {
	b.done = append(b.done, filepath.Base(dir)+" "+network)
	os.MkdirAll(out, 0o755)
	return nil
}

func TestAFileIsLoadedAndChecked(t *testing.T) {
	f := load(t, example)
	if f.Name != "demo" || f.Templates["py"].Build != "py" || f.Machines["worker"].Count != 2 {
		t.Fatalf("loaded: %+v", f)
	}
	// Named after its directory when it says nothing
	if g := load(t, "[templates.a]\nsite = \"dist/a\"\n"); g.Name != filepath.Base(g.Dir) {
		t.Errorf("name: %q", g.Name)
	}
	for text, want := range map[string]string{
		"[templates.a]\nsite = \"x\"\nbuild = \"y\"\n": "one of site, build or snapshot",
		"[templates.a]\n":                                                                           "one of site, build or snapshot",
		"[services.s]\ntemplate = \"nope\"\n":                                                       "no template nope",
		"[templates.a]\nsite = \"x\"\nidle = \"soon\"\n":                                            "not a duration",
		"[templates.a]\nsite = \"x\"\nflavour = \"mint\"\n":                                         "unknown keys: templates.a.flavour",
		"[templates.\"a/b\"]\nsite = \"x\"\n":                                                       "letters, digits",
		"[templates.a]\nsnapshot = \"s\"\n[snapshots.s]\ntemplate = \"a\"\n":                        "from itself",
		"[templates.a]\nsite = \"x\"\n[services.n]\ntemplate=\"a\"\n[machines.n]\ntemplate=\"a\"\n": "a service has that name",
		"[templates.a]\nsite = \"x\"\nnetwork = \"fetch\"\n":                                        "network is for build",
	} {
		if _, err := Load(write(t, text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", text, err, want)
		}
	}
}

func TestApplyMakesTheFleetInOrderAndThenHasNothingToDo(t *testing.T) {
	f := load(t, example)
	api := newFake()
	api.readyAfter["wget -q -O- localhost:8000"] = 2
	p, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"template py", "snapshot ready", "template py-ready", "service web", "machine worker"}
	got := steps(p)
	if len(got) != len(want) {
		t.Fatalf("steps: %v", got)
	}
	for i, w := range want {
		if !strings.HasPrefix(got[i], "+ "+w) {
			t.Errorf("step %d: %q, want + %s", i, got[i], w)
		}
	}
	var b builds
	if err := p.Apply(api, b.build, quiet); err != nil {
		t.Fatal(err)
	}
	if strings.Join(b.done, ",") != "py fetch" {
		t.Errorf("built: %v", b.done)
	}
	calls := strings.Join(api.calls, "\n")
	for _, c := range []string{
		"add template py " + f.BuildDir("py"),
		"up ready-setup of py\njob ready-setup: pip install httpx\njob ready-setup: python3 -m http.server 8000 &",
		"snapshot ready-setup as ready\nrm machine ready-setup",
		"add template py-ready  ready",
		"add service web",
		"up worker-1 of py\nup worker-2 of py",
	} {
		if !strings.Contains(calls, c) {
			t.Errorf("no %q in:\n%s", c, calls)
		}
	}
	// Ready was asked until it answered
	if n := strings.Count(calls, "job ready-setup: wget"); n != 3 {
		t.Errorf("ready asked %d times", n)
	}
	// Everything labelled, with its hash
	if l := api.services["web"].Labels; l[FleetLabel] != "demo" || l[SpecLabel] == "" {
		t.Errorf("labels: %v", l)
	}
	if l := api.machines["worker-1"].Labels; l["role"] != "worker" || l[EntryLabel] != "worker" {
		t.Errorf("a machine's labels: %v", l)
	}

	again, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	if !again.Empty() || again.Unchanged != 5 {
		t.Errorf("a second plan: %v (%d unchanged)", steps(again), again.Unchanged)
	}
}

func TestAChangeReplacesWhatChangedAndWhatIsMadeFromIt(t *testing.T) {
	path := write(t, example)
	api := newFake()
	f, _ := Load(path)
	p, _ := f.Plan(api)
	var b builds
	p.Apply(api, b.build, quiet)

	// A service changed: only it
	os.WriteFile(path, []byte(strings.Replace(example, "max = 3", "max = 5", 1)), 0o644)
	f, _ = Load(path)
	p, _ = f.Plan(api)
	if got := steps(p); len(got) != 1 || got[0] != "~ service web (changed)" {
		t.Errorf("max changed: %v", got)
	}
	api.calls = nil
	p.Apply(api, b.build, quiet)
	if strings.Join(api.calls, "|") != "rm service web|add service web" {
		t.Errorf("calls: %v", api.calls)
	}

	// The base template changed: everything made from it, in order, gone first in reverse
	os.WriteFile(path, []byte(strings.Replace(strings.Replace(example, "max = 3", "max = 5", 1), `idle = "30m"`, `idle = "10m"`, 1)), 0o644)
	f, _ = Load(path)
	p, _ = f.Plan(api)
	if got := steps(p); len(got) != 5 {
		t.Errorf("base changed: %v", got)
	}
	api.calls = nil
	if err := p.Apply(api, b.build, quiet); err != nil {
		t.Fatal(err)
	}
	removes := []string{}
	for _, c := range api.calls {
		if strings.HasPrefix(c, "rm ") && !strings.Contains(c, "-setup") {
			removes = append(removes, c)
		}
	}
	last := func(prefix string) int {
		for i := len(removes) - 1; i >= 0; i-- {
			if strings.HasPrefix(removes[i], prefix) {
				return i
			}
		}
		return -1
	}
	if !(last("rm service") < last("rm template py-ready") && last("rm template py-ready") < last("rm snapshot") && last("rm snapshot") < last("rm template py")) {
		t.Errorf("removed out of order: %v", removes)
	}

	// An entry gone from the file: removed; a count changed: replaced
	os.WriteFile(path, []byte(strings.Replace(strings.Split(example, "[services.web]")[0]+"[machines.worker]\ntemplate = \"py\"\ncount = 3\n", `idle = "30m"`, `idle = "10m"`, 1)), 0o644)
	f, _ = Load(path)
	p, _ = f.Plan(api)
	got := strings.Join(steps(p), "|")
	if !strings.Contains(got, "- service web (not in the file)") || !strings.Contains(got, "~ machine worker") {
		t.Errorf("entry gone and count changed: %v", got)
	}
	p.Apply(api, b.build, quiet)
	if len(api.machines) != 3 {
		t.Errorf("machines: %v", api.machines)
	}
}

func TestNamesInUseElsewhereAreRefused(t *testing.T) {
	f := load(t, example)
	api := newFake()
	api.templates["py"] = daemon.Template{Name: "py"}
	api.services["web"] = daemon.ServiceStatus{Service: daemon.Service{Name: "web", Labels: map[string]string{FleetLabel: "other"}}}
	_, err := f.Plan(api)
	if err == nil || !strings.Contains(err.Error(), "template py exists outside any fleet") || !strings.Contains(err.Error(), "service web exists of fleet other") {
		t.Errorf("conflicts: %v", err)
	}
}

func TestASnapshotWhoseSetupFailsSaysWhyAndLeavesNoMachine(t *testing.T) {
	f := load(t, example)
	api := newFake()
	api.status["pip install httpx"] = 1
	p, _ := f.Plan(api)
	var b builds
	err := p.Apply(api, b.build, quiet)
	if err == nil || !strings.Contains(err.Error(), `snapshot ready: "pip install httpx" failed (exit 1): out of pip install httpx`) {
		t.Errorf("failed setup: %v", err)
	}
	if _, ok := api.machines["ready-setup"]; ok {
		t.Error("the setup machine stays")
	}
	// Never ready
	api = newFake()
	api.status["wget -q -O- localhost:8000"] = 1
	g := load(t, strings.Replace(example, `ready = "wget -q -O- localhost:8000"`, "ready = \"wget -q -O- localhost:8000\"\ntimeout = \"1s\"", 1))
	p, _ = g.Plan(api)
	if err := p.Apply(api, b.build, quiet); err == nil || !strings.Contains(err.Error(), "not ready within 1s") {
		t.Errorf("never ready: %v", err)
	}
}

func TestDownRemovesTheFleetAndNothingElse(t *testing.T) {
	f := load(t, example)
	api := newFake()
	p, _ := f.Plan(api)
	var b builds
	p.Apply(api, b.build, quiet)
	api.templates["other"] = daemon.Template{Name: "other"}
	api.calls = nil
	n, err := Down(api, "demo", quiet)
	if err != nil || n != 6 {
		t.Fatalf("down: %d %v", n, err)
	}
	if len(api.templates) != 1 || len(api.snapshots)+len(api.services)+len(api.machines) != 0 {
		t.Errorf("left: %v %v %v %v", api.templates, api.snapshots, api.services, api.machines)
	}
	if first := api.calls[0]; !strings.HasPrefix(first, "rm service") && !strings.HasPrefix(first, "rm machine") {
		t.Errorf("first removed: %s", first)
	}
}

// The example in the repository stays a valid fleet
func TestTheExampleFleetLoads(t *testing.T) {
	f, err := Load("../../examples/fleet/snowglobe.toml")
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.Plan(newFake())
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(steps(p), "|"); !strings.Contains(got, "+ template py (build "+filepath.Join(f.Dir, "..", "python")) ||
		!strings.Contains(got, "+ service web") || len(p.Steps) != 5 {
		t.Errorf("the example's plan: %v", got)
	}
}
