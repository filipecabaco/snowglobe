package fleet

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// fake is a daemon in memory: what it has, and the calls it got.
type fake struct {
	templates map[string]daemon.Template
	snapshots map[string]daemon.Snapshot
	services  map[string]daemon.ServiceStatus
	machines  map[string]daemon.Machine
	links     map[string]daemon.Link
	sups      map[string]daemon.SupervisorStatus
	// Shown each template asked for
	onAddTemplate func(daemon.AddTemplate)
	calls         []string
	// A job's exit status by command (0 if not here); readyAfter makes a command fail that many
	// times first
	status     map[string]int
	readyAfter map[string]int
	// The time limit each command was given, and commands that run out of it
	limits   map[string]float64
	timesOut map[string]bool
	// What the guest's process list says, each time it is asked (then "out of ..." as any job)
	procs []string
}

func newFake() *fake {
	return &fake{templates: map[string]daemon.Template{}, snapshots: map[string]daemon.Snapshot{},
		services: map[string]daemon.ServiceStatus{}, machines: map[string]daemon.Machine{}, links: map[string]daemon.Link{}, sups: map[string]daemon.SupervisorStatus{},
		status: map[string]int{}, readyAfter: map[string]int{}, limits: map[string]float64{}, timesOut: map[string]bool{}}
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
func (f *fake) Links() ([]daemon.Link, error) {
	var out []daemon.Link
	for _, l := range f.links {
		out = append(out, l)
	}
	return out, nil
}
func (f *fake) AddLink(l daemon.Link) (*daemon.Link, error) {
	f.calls = append(f.calls, "add link "+l.Name+" "+l.FromKind+":"+l.From+" "+l.ToKind+":"+l.To)
	f.links[l.Name] = l
	return &l, nil
}
func (f *fake) RemoveLink(n string) error {
	f.calls = append(f.calls, "rm link "+n)
	if _, ok := f.links[n]; !ok {
		return notFound(n)
	}
	delete(f.links, n)
	return nil
}
func (f *fake) AddTemplate(r daemon.AddTemplate) (*daemon.Template, error) {
	f.calls = append(f.calls, "add template "+r.Name+" "+r.Site+" "+r.Snapshot)
	if f.onAddTemplate != nil {
		f.onAddTemplate(r)
	}
	h, err := daemon.NormalHealth(daemon.KindTemplate, r.Health)
	if err != nil {
		return nil, err
	}
	t := daemon.Template{Name: r.Name, Site: r.Site, Snapshot: r.Snapshot, Labels: r.Labels, Idle: r.Idle, Health: h}
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
	h, err := daemon.NormalHealth(daemon.KindService, s.Health)
	if err != nil {
		return nil, err
	}
	s.Health = h
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
	if _, taken := f.machines[u.Name]; taken {
		return nil, fmt.Errorf("a machine called %s exists", u.Name)
	}
	h, err := daemon.NormalHealth(daemon.KindMachine, u.Health)
	if err != nil {
		return nil, err
	}
	m := daemon.Machine{Name: u.Name, Template: u.Template, Labels: u.Labels, Health: h}
	f.machines[u.Name] = m
	return &m, nil
}
func (f *fake) Supervisors() ([]daemon.SupervisorStatus, error) {
	var out []daemon.SupervisorStatus
	for _, s := range f.sups {
		out = append(out, s)
	}
	return out, nil
}
func (f *fake) AddSupervisor(s daemon.Supervisor) (*daemon.SupervisorStatus, error) {
	var kids []string
	for _, c := range s.Children {
		k := c.Kind + "/" + c.Name
		if c.Restart != "" {
			k += ":" + c.Restart
		}
		kids = append(kids, k)
	}
	f.calls = append(f.calls, "add supervisor "+s.Name+" "+s.Strategy+" "+strings.Join(kids, ","))
	st := daemon.SupervisorStatus{Supervisor: s}
	f.sups[s.Name] = st
	return &st, nil
}
func (f *fake) RemoveSupervisor(n string) error {
	f.calls = append(f.calls, "rm supervisor "+n)
	delete(f.sups, n)
	return nil
}
func (f *fake) SetHealth(kind, name string, h *daemon.Health, labels map[string]string) error {
	what := "none"
	if h != nil {
		what = h.Cmd
	}
	f.calls = append(f.calls, "health "+kind+" "+name+" "+what)
	h, err := daemon.NormalHealth(kind, h)
	if err != nil {
		return err
	}
	set := func(l map[string]string) {
		for k, v := range labels {
			l[k] = v
		}
	}
	switch kind {
	case daemon.KindService:
		s := f.services[name]
		s.Health = h
		set(s.Labels)
		f.services[name] = s
	case daemon.KindMachine:
		m := f.machines[name]
		m.Health = h
		set(m.Labels)
		f.machines[name] = m
	case daemon.KindTemplate:
		t := f.templates[name]
		t.Health = h
		set(t.Labels)
		f.templates[name] = t
	}
	return nil
}
func (f *fake) RemoveMachine(n string) error {
	f.calls = append(f.calls, "rm machine "+n)
	delete(f.machines, n)
	return nil
}
func (f *fake) Job(n string, r control.JobRequest) (*control.JobResult, error) {
	f.calls = append(f.calls, "job "+n+": "+r.Cmd)
	f.limits[r.Cmd] = r.Timeout
	if r.Cmd == processList && len(f.procs) > 0 {
		out := f.procs[0]
		f.procs = f.procs[1:]
		return &control.JobResult{Status: new(int), Output: []byte(out)}, nil
	}
	if f.timesOut[r.Cmd] {
		return &control.JobResult{TimedOut: true, Output: []byte("still going")}, nil
	}
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

// loadAt writes text as the fleet file in dir (the same file, changed) and loads it.
func loadAt(t *testing.T, dir, text string) *File {
	t.Helper()
	path := filepath.Join(dir, "snowglobe.toml")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := Load(path)
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
		"up ready-setup of py\njob ready-setup: " + processList + "\njob ready-setup: pip install httpx\njob ready-setup: python3 -m http.server 8000 &",
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
	if !strings.Contains(got, "- service web (not in the file)") || !strings.Contains(got, "~ machine worker (changed)") {
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

// A setup machine left by an apply that failed or was interrupted doesn't block the next
func TestALeftoverSetupMachineOfTheFleetIsRemovedFirst(t *testing.T) {
	f := load(t, example)
	api := newFake()
	api.machines["ready-setup"] = daemon.Machine{Name: "ready-setup", Template: "py", Labels: map[string]string{FleetLabel: "demo"}}
	p, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	var b builds
	if err := p.Apply(api, b.build, quiet); err != nil {
		t.Fatal(err)
	}
	if calls := strings.Join(api.calls, "\n"); !strings.Contains(calls, "rm machine ready-setup\nup ready-setup of py") {
		t.Errorf("not removed first:\n%s", calls)
	}
	if _, ok := api.snapshots["ready"]; !ok {
		t.Error("no snapshot")
	}
	// Another fleet's stays: the name is taken
	api = newFake()
	api.machines["ready-setup"] = daemon.Machine{Name: "ready-setup", Template: "py", Labels: map[string]string{FleetLabel: "other"}}
	p, _ = f.Plan(api)
	if err := p.Apply(api, b.build, quiet); err == nil || !strings.Contains(err.Error(), "exists") {
		t.Errorf("another fleet's: %v", err)
	}
	if m := api.machines["ready-setup"]; m.Labels[FleetLabel] != "other" {
		t.Errorf("another fleet's removed: %+v", m)
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
	if got := strings.Join(steps(p), "|"); !strings.Contains(got, "+ template supabase (build "+filepath.Join(f.Dir, "..", "supabase")) ||
		!strings.Contains(got, "+ template bun (build "+filepath.Join(f.Dir, "..", "bun")) ||
		!strings.Contains(got, "+ service viewer (viewer, 8080:8080") || !strings.Contains(got, "+ link viewer-db") || len(p.Steps) != 9 {
		t.Errorf("the example's plan: %v", got)
	}
}

func TestLinksJoinTheFleetsMachinesAndAStepAppliesOnItsOwn(t *testing.T) {
	f := load(t, "name = \"todo\"\n[templates.db]\nsite = \"/sites/db\"\n[templates.app]\nsite = \"/sites/app\"\n"+
		"[services.db]\ntemplate = \"db\"\nports = [\"15432:5432\"]\n[links.app-db]\nfrom = \"app\"\nto = \"db\"\nport = 5432\nas = \"db.internal\"\n")
	api := newFake()
	p, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	ready := map[string]bool{}
	for _, s := range p.Steps {
		ready[s.Key] = s.Ready
	}
	// Templates can go now; the service and the link wait for what they are made from
	if !ready["template/db"] || !ready["template/app"] || ready["service/db"] || ready["link/app-db"] {
		t.Fatalf("ready: %v", ready)
	}
	if err := p.ApplyStep(api, nil, "link/app-db", quiet); err == nil || !strings.Contains(err.Error(), "apply that first") {
		t.Errorf("a link before its ends: %v", err)
	}
	// One step at a time, planning again after each
	for _, key := range []string{"template/db", "template/app", "service/db", "link/app-db"} {
		p, err := f.Plan(api)
		if err != nil {
			t.Fatal(err)
		}
		if err := p.ApplyStep(api, nil, key, quiet); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
	}
	if !strings.Contains(strings.Join(api.calls, "\n"), "add link app-db template:app service:db") {
		t.Errorf("calls: %v", api.calls)
	}
	if l := api.links["app-db"]; l.As != "db.internal" || l.Port != 5432 || l.Labels[FleetLabel] != "todo" {
		t.Errorf("link: %+v", l)
	}
	if p, _ := f.Plan(api); !p.Empty() {
		t.Errorf("after every step: %v", steps(p))
	}
	// Down takes the link first
	api.calls = nil
	if _, err := Down(api, "todo", quiet); err != nil {
		t.Fatal(err)
	}
	if len(api.calls) == 0 || api.calls[0] != "rm link app-db" {
		t.Errorf("down: %v", api.calls)
	}
	for text, want := range map[string]string{
		"[templates.a]\nsite = \"x\"\n[links.l]\nfrom = \"a\"\nto = \"nope\"\nport = 1\n":                              "to a service",
		"[templates.a]\nsite = \"x\"\n[services.s]\ntemplate = \"a\"\n[links.l]\nfrom = \"s\"\nto = \"s\"\nport = 1\n": "from a template",
		"[templates.a]\nsite = \"x\"\n[services.s]\ntemplate = \"a\"\n[links.l]\nfrom = \"a\"\nto = \"s\"\n":           "port",
	} {
		if _, err := Load(write(t, text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", text, err, want)
		}
	}
}

func TestLoadCRLFCommandsGetLF(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "snowglobe.toml")
	text := "name = \"x\"\r\n[templates.t]\r\nsite = \"/sites/t\"\r\n[snapshots.s]\r\ntemplate = \"t\"\r\nrun = [\r\n'''\r\nmkdir -p /a\r\ncat <<EOF\r\nhi\r\nEOF\r\n''',\r\n]\r\nready = '''\r\ntrue\r\n'''\r\n"
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := Load(file)
	if err != nil {
		t.Fatal(err)
	}
	got := f.Snapshots["s"]
	if len(got.Run) != 1 || strings.Contains(got.Run[0].Cmd+got.Ready, "\r") {
		t.Fatalf("a command kept its CR: %q %q", got.Run, got.Ready)
	}
	if want := "mkdir -p /a\ncat <<EOF\nhi\nEOF\n"; got.Run[0].Cmd != want {
		t.Fatalf("run = %q, want %q", got.Run, want)
	}
}

func TestASnapshotCommandIsAStringOrATableWithATimeoutOfItsOwn(t *testing.T) {
	text := strings.Replace(example, `run = ["pip install httpx", "python3 -m http.server 8000 &"]`,
		"run = [\n  { cmd = '''\npip install httpx\n''', timeout = \"90s\" },\n  \"python3 -m http.server 8000 &\",\n]\ntimeout = \"3m\"", 1)
	f := load(t, text)
	s := f.Snapshots["ready"]
	if len(s.Run) != 2 || s.Run[0] != (Command{Cmd: "pip install httpx\n", Timeout: "90s"}) || s.Run[1] != (Command{Cmd: "python3 -m http.server 8000 &"}) {
		t.Fatalf("run = %+v", s.Run)
	}
	// Its own timeout, else the snapshot's, else 10m
	if s.Limit(s.Run[0]) != 90*time.Second || s.Limit(s.Run[1]) != 3*time.Minute || (SnapshotSpec{}).Limit(Command{Cmd: "x"}) != CommandTimeout {
		t.Errorf("limits: %s %s", s.Limit(s.Run[0]), s.Limit(s.Run[1]))
	}
	api := newFake()
	p, _ := f.Plan(api)
	var b builds
	if err := p.Apply(api, b.build, quiet); err != nil {
		t.Fatal(err)
	}
	if api.limits["pip install httpx\n"] != 90 || api.limits["python3 -m http.server 8000 &"] != 180 {
		t.Errorf("the jobs' limits: %v", api.limits)
	}
	// A command that runs out of its time says so, with its limit
	api = newFake()
	api.timesOut["pip install httpx\n"] = true
	p, _ = f.Plan(api)
	if err := p.Apply(api, b.build, quiet); err == nil || !strings.Contains(err.Error(), `command 1 of 2 timed out (its limit 1m30s): "pip install httpx`) {
		t.Errorf("timed out: %v", err)
	}
}

func TestACommandWithNoTimeoutOfItsOwnHashesAsBefore(t *testing.T) {
	got, _ := json.Marshal(SnapshotSpec{Template: "t", Run: []Command{{Cmd: "a"}, {Cmd: "b", Timeout: "9s"}}})
	if want := `{"template":"t","run":["a",{"cmd":"b","timeout":"9s"}]}`; string(got) != want {
		t.Errorf("json = %s, want %s", got, want)
	}
	var back SnapshotSpec
	if err := json.Unmarshal(got, &back); err != nil || len(back.Run) != 2 || back.Run[0].Cmd != "a" || back.Run[1].Timeout != "9s" {
		t.Errorf("back = %+v %v", back, err)
	}
}

func TestABadCommandTableIsRefused(t *testing.T) {
	for bad, want := range map[string]string{
		`{ cmd = "x", timeout = "soon" }`: `run[0]: timeout: "soon" is not a duration`,
		`{ cmd = "x", retries = "2" }`:    "unknown key retries",
		`{ timeout = "9s" }`:              "needs cmd",
		`{ cmd = "x", timeout = 9 }`:      "timeout: a string",
	} {
		text := strings.Replace(example, `run = ["pip install httpx", "python3 -m http.server 8000 &"]`, "run = ["+bad+"]", 1)
		_, err := Load(write(t, text))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", bad, err, want)
		}
	}
}

// withHealth is the example with a health check on its service.
func withHealth(health string) string {
	return strings.Replace(example, "idle = \"5m\"\n", "idle = \"5m\"\n\n"+health, 1)
}

func TestAServiceHealthCheckIsCheckedAndApplied(t *testing.T) {
	f := load(t, withHealth(`[services.web.health]
interval = "15s"
failures = 2
heal = "hook"
heal_cmd = "pkill -HUP python3"
wait_ready = true

[services.web.health.http]
port = 8000
path = "/healthz"
status = "200,204"
`))
	api := newFake()
	p, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(api, (&builds{}).build, quiet); err != nil {
		t.Fatal(err)
	}
	h := api.services["web"].Health
	if h == nil || h.HTTP == nil || h.HTTP.Port != 8000 || h.HTTP.Path != "/healthz" || h.HTTP.Status != "200,204" ||
		h.Interval != daemon.Duration(15*time.Second) || h.Failures != 2 || h.Heal != daemon.HealHook || h.HealCmd != "pkill -HUP python3" || !h.WaitReady {
		t.Fatalf("health: %+v", h)
	}
	// A change to the check is made in place: the service (and its replicas) stay
	changed := loadAt(t, f.Dir, withHealth("[services.web.health]\ncmd = \"curl -sf localhost:8000/\"\n"))
	p, err = changed.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(steps(p), "\n"); got != "* service web (health check, in place)" {
		t.Errorf("steps: %s", got)
	}
	api.calls = nil
	if err := p.Apply(api, (&builds{}).build, quiet); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(api.calls, "; "); got != "health service web curl -sf localhost:8000/" {
		t.Errorf("calls: %s", got)
	}
	if p, _ := changed.Plan(api); !p.Empty() {
		t.Errorf("after: %v", steps(p))
	}
	// And so is taking it away
	p, _ = loadAt(t, f.Dir, example).Plan(api)
	if got := strings.Join(steps(p), "\n"); got != "* service web (health check, in place)" {
		t.Errorf("steps: %s", got)
	}
	// Without one, a service hashes as it did before health checks
	got, _ := json.Marshal(ServiceSpec{Template: "t"})
	if want := `{"template":"t","min":0}`; string(got) != want {
		t.Errorf("json = %s, want %s", got, want)
	}
}

func TestABadHealthCheckIsRefused(t *testing.T) {
	for bad, want := range map[string]string{
		"[services.web.health]\nheal = \"replace\"\n":                                        "one of http or cmd",
		"[services.web.health]\ncmd = \"true\"\ninterval = \"often\"\n":                      `health: interval: "often" is not a duration`,
		"[services.web.health]\ncmd = \"true\"\nheal = \"hook\"\n":                           "needs heal_cmd",
		"[services.web.health]\ncmd = \"true\"\nheal = \"reboot\"\n":                         `heal "reboot"`,
		"[services.web.health]\ncmd = \"true\"\nretries = 3\n":                               "unknown keys",
		"[services.web.health]\n[services.web.health.http]\nport = 8000\nstatus = \"2xx\"\n": "http status",
	} {
		_, err := Load(write(t, withHealth(bad)))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", bad, err, want)
		}
	}
}

func TestAServiceOfAnEarlierVersionIsLabelledAnewNotReplaced(t *testing.T) {
	f := load(t, withHealth("[services.web.health]\ncmd = \"true\"\n"))
	api := newFake()
	p, _ := f.Plan(api)
	if err := p.Apply(api, (&builds{}).build, quiet); err != nil {
		t.Fatal(err)
	}
	// As 0.23 and 0.24 labelled it: a hash with its health check
	var legacy string
	objs, _ := f.objects()
	for _, o := range objs {
		if o.Key() == "service/web" {
			legacy = o.Legacy
		}
	}
	s := api.services["web"]
	s.Labels[SpecLabel] = legacy
	api.services["web"] = s
	p, _ = f.Plan(api)
	if got := strings.Join(steps(p), "\n"); got != "* service web (labelled anew)" {
		t.Fatalf("steps: %s", got)
	}
	p.Apply(api, (&builds{}).build, quiet)
	if p, _ := f.Plan(api); !p.Empty() {
		t.Errorf("after: %v", steps(p))
	}
}

func TestTemplatesAndMachinesHaveHealthChecksToo(t *testing.T) {
	f := load(t, strings.Replace(example, "labels = { role = \"worker\" }\n", "labels = { role = \"worker\" }\n\n[machines.worker.health]\ncmd = \"pgrep worker\"\nheal = \"hook\"\nheal_cmd = \"worker &\"\n", 1)+
		"\n[templates.py.health]\ncmd = \"true\"\n")
	api := newFake()
	p, _ := f.Plan(api)
	if err := p.Apply(api, (&builds{}).build, quiet); err != nil {
		t.Fatal(err)
	}
	if h := api.templates["py"].Health; h == nil || h.Cmd != "true" || h.Heal != daemon.HealReplace {
		t.Errorf("template's: %+v", h)
	}
	for _, n := range []string{"worker-1", "worker-2"} {
		if h := api.machines[n].Health; h == nil || h.Cmd != "pgrep worker" || h.Heal != daemon.HealHook {
			t.Errorf("%s's: %+v", n, h)
		}
	}
	// Changed: in place, every machine of the entry; the template isn't rebuilt
	changed := loadAt(t, f.Dir, strings.Replace(example, "labels = { role = \"worker\" }\n", "labels = { role = \"worker\" }\n\n[machines.worker.health]\ncmd = \"pgrep worker2\"\n", 1)+
		"\n[templates.py.health]\ncmd = \"true\"\n")
	p, _ = changed.Plan(api)
	if got := strings.Join(steps(p), "\n"); got != "* machine worker (health check, in place)" {
		t.Errorf("steps: %s", got)
	}
	api.calls = nil
	p.Apply(api, (&builds{}).build, quiet)
	if got := strings.Join(api.calls, "; "); got != "health machine worker-1 pgrep worker2; health machine worker-2 pgrep worker2" {
		t.Errorf("calls: %s", got)
	}
	// A machine heals by none or hook
	_, err := Load(write(t, strings.Replace(example, "labels = { role = \"worker\" }\n", "labels = { role = \"worker\" }\n\n[machines.worker.health]\ncmd = \"true\"\nheal = \"replace\"\n", 1)))
	if err == nil || !strings.Contains(err.Error(), "a machine heals by none or hook") {
		t.Errorf("machine healed by replace: %v", err)
	}
}

const supervised = `
[supervisors.app]
strategy = "rest_for_one"
children = ["web", "worker"]
max_restarts = 5
max_seconds = "2m"

[supervisors.app.restart]
worker = "transient"

[supervisors.top]
strategy = "one_for_all"
children = ["app"]
`

func TestSupervisorsComeAfterTheirChildrenWithTheirNames(t *testing.T) {
	f := load(t, example+supervised)
	api := newFake()
	p, err := f.PlanInstance(api, "two")
	if err != nil {
		t.Fatal(err)
	}
	got := steps(p)
	if got[len(got)-2] != "+ supervisor app-two (rest_for_one over web, worker)" || got[len(got)-1] != "+ supervisor top-two (one_for_all over app)" {
		t.Errorf("steps: %s", strings.Join(got, "\n"))
	}
	if err := p.Apply(api, (&builds{}).build, quiet); err != nil {
		t.Fatal(err)
	}
	var adds []string
	for _, c := range api.calls {
		if strings.HasPrefix(c, "add supervisor") {
			adds = append(adds, c)
		}
	}
	want := []string{
		"add supervisor app-two rest_for_one service/web-two,machine/worker-two-1:transient,machine/worker-two-2:transient",
		"add supervisor top-two one_for_all supervisor/app-two",
	}
	if strings.Join(adds, "\n") != strings.Join(want, "\n") {
		t.Errorf("added:\n%s\nwant:\n%s", strings.Join(adds, "\n"), strings.Join(want, "\n"))
	}
	if s := api.sups["app-two"]; s.MaxRestarts != 5 || s.MaxSeconds != daemon.Duration(2*time.Minute) || s.Labels[EntryLabel] != "app" {
		t.Errorf("app: %+v", s)
	}
	// Applied: nothing to do; down: the supervisors go first
	if p, _ := f.PlanInstance(api, "two"); !p.Empty() {
		t.Errorf("again: %v", steps(p))
	}
	p, _ = (&File{Name: f.Name, Dir: f.Dir}).PlanInstance(api, "two")
	api.calls = nil
	p.Apply(api, (&builds{}).build, quiet)
	if len(api.calls) < 2 || !strings.HasPrefix(api.calls[0], "rm supervisor") || !strings.HasPrefix(api.calls[1], "rm supervisor") {
		t.Errorf("down: %v", api.calls)
	}
}

func TestABadSupervisorIsRefused(t *testing.T) {
	for bad, want := range map[string]string{
		"[supervisors.s]\nchildren = [\"web\"]\nstrategy = \"all\"\n":                              `strategy "all"`,
		"[supervisors.s]\nchildren = []\n":                                                         "at least one",
		"[supervisors.s]\nchildren = [\"nope\"]\n":                                                 "child nope: no service, machine or supervisor",
		"[supervisors.s]\nchildren = [\"web\", \"web\"]\n":                                         "child web twice",
		"[supervisors.s]\nchildren = [\"s\"]\n":                                                    "its own child",
		"[supervisors.web]\nchildren = [\"worker\"]\n":                                             "a service has that name",
		"[supervisors.s]\nchildren = [\"web\"]\n[supervisors.s.restart]\nworker = \"temporary\"\n": "restart worker: not one of its children",
		"[supervisors.s]\nchildren = [\"web\"]\n[supervisors.s.restart]\nweb = \"sometimes\"\n":    `restart web = "sometimes"`,
		"[supervisors.s]\nchildren = [\"web\"]\nmax_seconds = \"long\"\n":                          "max_seconds",
		"[supervisors.a]\nchildren = [\"web\"]\n[supervisors.b]\nchildren = [\"web\"]\n":           "a child of supervisor",
		"[supervisors.a]\nchildren = [\"b\"]\n[supervisors.b]\nchildren = [\"a\"]\n":               "from itself",
	} {
		_, err := Load(write(t, example+bad))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", bad, err, want)
		}
	}
}

func TestATemplatesStartCommandsGoToTheDaemonAndChangeItsHash(t *testing.T) {
	file := `
name = "s"

[templates.py]
site = "/sites/py"
start = ["python3 -m http.server 8000 &", { cmd = "until wget -q -O- localhost:8000; do sleep 1; done", timeout = "30s" }]
`
	f := load(t, file)
	api := newFake()
	var got daemon.AddTemplate
	api.onAddTemplate = func(r daemon.AddTemplate) { got = r }
	p, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(api, nil, quiet); err != nil {
		t.Fatal(err)
	}
	want := []daemon.StartCommand{
		{Cmd: "python3 -m http.server 8000 &"},
		{Cmd: "until wget -q -O- localhost:8000; do sleep 1; done", Timeout: daemon.Duration(30 * time.Second)},
	}
	if !reflect.DeepEqual(got.Start, want) {
		t.Errorf("start: %+v", got.Start)
	}
	// Another start is another template; none hashes as a template always did
	other := load(t, strings.Replace(file, "8000 &", "9000 &", 1))
	none := load(t, strings.Replace(file, "start = [", "# start = [", 1))
	h := func(f *File) string { return hash(KindTemplate, withoutHealth(f.Templates["py"]), nil) }
	if h(f) == h(other) {
		t.Error("a changed start hashes the same")
	}
	if data, _ := json.Marshal(none.Templates["py"]); strings.Contains(string(data), "start") {
		t.Errorf("a template without start keeps the JSON (and hash) it always had: %s", data)
	}

	for what, bad := range map[string]string{
		"an empty command": `start = ["  "]`,
		"a bad timeout":    `start = [{ cmd = "x", timeout = "soon" }]`,
	} {
		text := "name = \"s\"\n[templates.py]\nsite = \"/sites/py\"\n" + bad + "\n"
		dir := t.TempDir()
		path := filepath.Join(dir, "snowglobe.toml")
		os.WriteFile(path, []byte(text), 0o644)
		if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "start[0]") {
			t.Errorf("%s: %v", what, err)
		}
	}
}

func TestASnapshotThatKeepsAProcessRunningIsWarnedAbout(t *testing.T) {
	f := load(t, example)
	api := newFake()
	api.readyAfter["wget -q -O- localhost:8000"] = 0
	// Before its commands: a shell; after: the server they left running too
	// Each listing is a job of its own: its runner's scripts (under .sg/) differ and don't count
	api.procs = []string{"/bin/sh -l\nsh /sgjob/aaa/.sg/job.sh\nsh .sg/cmd\n", "/bin/sh -l\nsh /sgjob/bbb/.sg/job.sh\nsh .sg/cmd\npython3 -m http.server 8000\n"}
	p, err := f.Plan(api)
	if err != nil {
		t.Fatal(err)
	}
	var log []string
	logf := func(format string, a ...any) { log = append(log, fmt.Sprintf(format, a...)) }
	var b builds
	if err := p.Apply(api, b.build, logf); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(log, "\n")
	if !strings.Contains(all, "! ready keeps python3 -m http.server 8000 running") || !strings.Contains(all, "start") {
		t.Errorf("no warning about the server it keeps:\n%s", all)
	}
	if strings.Contains(all, "/bin/sh -l running") || strings.Contains(all, "sgjob") {
		t.Errorf("warned about what ran before its commands:\n%s", all)
	}

	// Nothing left running: no warning
	api = newFake()
	api.procs = []string{"/bin/sh -l\n", "/bin/sh -l\n"}
	p, _ = f.Plan(api)
	log = nil
	if err := p.Apply(api, b.build, logf); err != nil {
		t.Fatal(err)
	}
	if all := strings.Join(log, "\n"); strings.Contains(all, "keeps") {
		t.Errorf("a warning with nothing kept:\n%s", all)
	}
}

func TestKeptRunningIsWhatIsNewAndSaysLittle(t *testing.T) {
	set := func(ps ...string) map[string]bool {
		m := map[string]bool{}
		for _, p := range ps {
			m[p] = true
		}
		return m
	}
	if got := keptRunning(nil, set("a")); got != nil {
		t.Errorf("no list before: %v", got)
	}
	if got := keptRunning(set("sh"), set("sh", "node server.js")); !reflect.DeepEqual(got, []string{"node server.js"}) {
		t.Errorf("one new: %v", got)
	}
	long := strings.Repeat("x", 100)
	got := keptRunning(set(), set("a", "b", "c", "d", "e", "f", "g", long))
	if len(got) != 6 || got[5] != "and 3 more" {
		t.Errorf("many: %v", got)
	}
	for _, p := range keptRunning(set(), set(long)) {
		if len(p) > 60 {
			t.Errorf("not cut: %d", len(p))
		}
	}
}
