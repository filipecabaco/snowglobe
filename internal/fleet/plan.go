package fleet

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// EntryLabel names the file's entry a service, machine or link of an instance was made for (an
// entry with count makes several machines; another instance's carry its name)
const EntryLabel = "snowglobe.entry"

// Main is the instance a fleet is applied as by default: it keeps the file's names.
const Main = "main"

// API is what a fleet needs of the daemon (daemon.Client).
type API interface {
	Templates() ([]daemon.Template, error)
	Snapshots() ([]daemon.Snapshot, error)
	Services() ([]daemon.ServiceStatus, error)
	Machines(labels map[string]string) ([]daemon.Machine, error)
	AddTemplate(daemon.AddTemplate) (*daemon.Template, error)
	RemoveTemplate(name string) error
	SnapshotWith(machine, name string, labels map[string]string) (*daemon.Snapshot, error)
	RemoveSnapshot(name string) error
	AddService(daemon.Service) (*daemon.ServiceStatus, error)
	RemoveService(name string) error
	Up(daemon.Up) (*daemon.Machine, error)
	RemoveMachine(name string) error
	Job(name string, req control.JobRequest) (*control.JobResult, error)
	Links() ([]daemon.Link, error)
	AddLink(daemon.Link) (*daemon.Link, error)
	RemoveLink(name string) error
}

// Builder builds the site of a Dockerfile directory into out (snowglobe build DIR --out OUT).
type Builder func(dir, out, network string) error

// Step is one thing a plan does.
type Step struct {
	// "create", "replace" or "remove"
	Action string `json:"action"`
	Kind   string `json:"kind"`
	// The name it has (or will have) on the daemon
	Name string `json:"name"`
	// What it is, or why
	Detail string `json:"detail,omitempty"`
	// kind/entry: ApplyStep's argument
	Key string `json:"key"`
	// What it is made from (kind/entry)
	Deps []string `json:"deps,omitempty"`
	// Whether it can be applied on its own now: nothing it is made from is still to come
	Ready bool `json:"ready"`
	// Made per instance (a service, machine or exclusive link), not shared by them
	PerInstance bool `json:"per_instance,omitempty"`
}

func (s Step) String() string {
	mark := map[string]string{"create": "+", "replace": "~", "remove": "-"}[s.Action]
	line := fmt.Sprintf("%s %s %s", mark, s.Kind, s.Name)
	if s.Detail != "" {
		line += " (" + s.Detail + ")"
	}
	return line
}

// Plan is what it takes to get one instance of a fleet (and what its instances share) from what
// the daemon has to what the file wants.
type Plan struct {
	Instance string
	Steps    []Step
	// How many of the file's objects are as it wants already
	Unchanged int

	file    *File
	removes []have
	creates []Object
}

// have is something of the fleet's the daemon has.
type have struct {
	kind, name, hash string
	// Its entry (per instance) and instance
	entry, instance string
	// A template: whether it is of a snapshot
	ofSnapshot bool
}

func (h have) key() string {
	if h.entry != "" {
		return h.kind + "/" + h.entry
	}
	return h.kind + "/" + h.name
}

// perInstance says whether an object is made per instance: services, machines and exclusive
// links are; templates, snapshots and links between templates are shared.
func perInstance(o Object) bool {
	switch o.Kind {
	case KindService, KindMachine:
		return true
	case KindLink:
		return o.Spec.(LinkSpec).Mode == Exclusive
	}
	return false
}

// nameIn is an entry's name on the daemon in instance inst: as it is in main, with the instance's
// name after it elsewhere.
func nameIn(entry, inst string) string {
	if inst == Main || inst == "" {
		return entry
	}
	return entry + "-" + inst
}

// current is what the daemon has: the fleet's (shared, and instance inst's when inst is set), and
// every name in use.
func current(api API, fleet, inst string) ([]have, map[string]string, error) {
	var mine []have
	taken := map[string]string{}
	add := func(kind, name string, labels map[string]string, h have) {
		taken[kind+"/"+name] = labels[FleetLabel]
		if labels[FleetLabel] != fleet {
			return
		}
		h.kind, h.name, h.hash = kind, name, labels[SpecLabel]
		h.entry, h.instance = labels[EntryLabel], labels[daemon.InstanceLabel]
		if h.instance != "" && inst != "" && h.instance != inst {
			return
		}
		mine = append(mine, h)
	}
	ts, err := api.Templates()
	if err != nil {
		return nil, nil, err
	}
	for _, t := range ts {
		add(KindTemplate, t.Name, t.Labels, have{ofSnapshot: t.Snapshot != ""})
	}
	ss, err := api.Snapshots()
	if err != nil {
		return nil, nil, err
	}
	for _, s := range ss {
		add(KindSnapshot, s.Name, s.Labels, have{})
	}
	svcs, err := api.Services()
	if err != nil {
		return nil, nil, err
	}
	for _, s := range svcs {
		add(KindService, s.Name, s.Labels, have{})
	}
	ls, err := api.Links()
	if err != nil {
		return nil, nil, err
	}
	for _, l := range ls {
		add(KindLink, l.Name, l.Labels, have{})
	}
	ms, err := api.Machines(nil)
	if err != nil {
		return nil, nil, err
	}
	for _, m := range ms {
		// A service's replicas are the service's, and a snapshot's setup machine its own
		if m.Labels[EntryLabel] == "" {
			taken[KindMachine+"/"+m.Name] = m.Labels[FleetLabel]
			continue
		}
		add(KindMachine, m.Name, m.Labels, have{})
	}
	return mine, taken, nil
}

// Instances are the fleet's instances the daemon has, main first.
func Instances(api API, fleet string) ([]string, error) {
	mine, _, err := current(api, fleet, "")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	for _, h := range mine {
		if h.instance != "" && !seen[h.instance] {
			seen[h.instance] = true
			out = append(out, h.instance)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i] == Main) != (out[j] == Main) {
			return out[i] == Main
		}
		return out[i] < out[j]
	})
	return out, nil
}

// Plan works out what Apply would do for instance main.
func (f *File) Plan(api API) (*Plan, error) { return f.PlanInstance(api, Main) }

// PlanInstance works out what applying instance inst would do (with what instances share).
func (f *File) PlanInstance(api API, inst string) (*Plan, error) {
	if inst == "" {
		inst = Main
	}
	if !nameRE.MatchString(inst) || len(inst) > 20 {
		return nil, fmt.Errorf("instance %q: up to 20 letters, digits, - or _", inst)
	}
	want, err := f.objects()
	if err != nil {
		return nil, err
	}
	mine, taken, err := current(api, f.Name, inst)
	if err != nil {
		return nil, err
	}
	p := &Plan{file: f, Instance: inst}
	wanted := map[string]Object{}
	for _, o := range want {
		wanted[o.Key()] = o
	}
	// What the fleet has, by key: a machine entry may have several machines
	haveHash := map[string][]string{}
	for _, h := range mine {
		haveHash[h.key()] = append(haveHash[h.key()], h.hash)
	}
	// Names the daemon has that aren't the fleet's
	var conflicts []string
	for _, o := range want {
		for _, n := range p.names(o) {
			if owner, ok := taken[o.Kind+"/"+n]; ok && owner != f.Name {
				who := "outside any fleet"
				if owner != "" {
					who = "of fleet " + owner
				}
				conflicts = append(conflicts, fmt.Sprintf("%s %s exists %s", o.Kind, n, who))
			}
		}
	}
	if len(conflicts) > 0 {
		return nil, fmt.Errorf("names in use: %s", strings.Join(conflicts, "; "))
	}

	for _, o := range want {
		hashes, had := haveHash[o.Key()]
		same := had && len(hashes) > 0
		for _, h := range hashes {
			same = same && h == o.Hash
		}
		if o.Kind == KindMachine && same && len(hashes) != len(p.names(o)) {
			same = false
		}
		// Named as the entry is (in this instance): a machine entry with count is one step
		name := o.Name
		if perInstance(o) {
			name = nameIn(o.Name, p.Instance)
		}
		step := Step{Kind: o.Kind, Name: name, Key: o.Key(), Deps: o.Deps, PerInstance: perInstance(o)}
		switch {
		case same:
			p.Unchanged++
			continue
		case had:
			step.Action, step.Detail = "replace", "changed"
		default:
			step.Action, step.Detail = "create", describe(o)
		}
		p.Steps = append(p.Steps, step)
		p.creates = append(p.creates, o)
	}
	replaced := map[string]bool{}
	for _, o := range p.creates {
		replaced[o.Key()] = true
	}
	for _, h := range mine {
		if _, ok := wanted[h.key()]; !ok {
			p.Steps = append(p.Steps, Step{Action: "remove", Kind: h.kind, Name: h.name, Detail: "not in the file", Key: h.kind + "/" + h.name, PerInstance: h.instance != ""})
			p.removes = append(p.removes, h)
		} else if replaced[h.key()] {
			p.removes = append(p.removes, h)
		}
	}
	sortRemoves(p.removes)
	// A step is ready when nothing it is made from is still to come
	pending := map[string]bool{}
	for _, o := range p.creates {
		pending[o.Key()] = true
	}
	for i, s := range p.Steps {
		ready := true
		for _, d := range s.Deps {
			ready = ready && !pending[d]
		}
		p.Steps[i].Ready = ready
	}
	return p, nil
}

// names are the daemon names an object has in the plan's instance.
func (p *Plan) names(o Object) []string {
	if !perInstance(o) {
		return []string{o.Name}
	}
	n := nameIn(o.Name, p.Instance)
	if o.Kind == KindMachine {
		return MachineNames(n, o.Spec.(MachineSpec))
	}
	return []string{n}
}

// ApplyStep carries out one step of the plan (its key, kind/entry): a remove, or a create or
// replace once what it is made from is there. A replace removes what was made from the old one
// with it (their own steps make them again).
func (p *Plan) ApplyStep(api API, build Builder, key string, logf func(string, ...any)) error {
	var step *Step
	for i := range p.Steps {
		if p.Steps[i].Key == key {
			step = &p.Steps[i]
		}
	}
	if step == nil {
		return fmt.Errorf("no step %s in the plan (it may be done already)", key)
	}
	if !step.Ready {
		return fmt.Errorf("%s is made from %s: apply that first", key, strings.Join(step.Deps, ", "))
	}
	if step.Action == "remove" {
		logf("- %s %s", step.Kind, step.Name)
		if err := remove(api, step.Kind, step.Name); err != nil && !daemon.NotFound(err) {
			return fmt.Errorf("removing %s: %w", key, err)
		}
		return nil
	}
	// What goes with it: the old one, and what is made from it that is replaced too
	going := map[string]bool{key: true}
	for changed := true; changed; {
		changed = false
		for _, o := range p.creates {
			for _, d := range o.Deps {
				if going[d] && !going[o.Key()] {
					going[o.Key()] = true
					changed = true
				}
			}
		}
	}
	for _, h := range p.removes {
		if going[h.key()] {
			logf("- %s %s", h.kind, h.name)
			if err := remove(api, h.kind, h.name); err != nil && !daemon.NotFound(err) {
				return fmt.Errorf("removing %s %s: %w", h.kind, h.name, err)
			}
		}
	}
	for _, o := range p.creates {
		if o.Key() == key {
			begun := time.Now()
			if err := p.create(api, build, o, logf); err != nil {
				return fmt.Errorf("%s %s: %w", o.Kind, o.Name, err)
			}
			logf("+ %s %s (%s)", o.Kind, p.names(o)[0], time.Since(begun).Round(time.Millisecond))
		}
	}
	return nil
}

// sortRemoves puts what is made from something before it: links, machines and services,
// templates of snapshots, snapshots, then templates.
func sortRemoves(hs []have) {
	rank := func(h have) int {
		switch {
		case h.kind == KindLink:
			return -1
		case h.kind == KindMachine || h.kind == KindService:
			return 0
		case h.kind == KindTemplate && h.ofSnapshot:
			return 1
		case h.kind == KindSnapshot:
			return 2
		}
		return 3
	}
	sort.SliceStable(hs, func(i, j int) bool { return rank(hs[i]) < rank(hs[j]) })
}

func describe(o Object) string {
	switch s := o.Spec.(type) {
	case TemplateSpec:
		what := s.Site
		switch {
		case s.Build != "":
			what = "build " + s.Build
		case s.Snapshot != "":
			what = "of snapshot " + s.Snapshot
		}
		return what + ", egress " + s.egress()
	case SnapshotSpec:
		n := "commands"
		if len(s.Run) == 1 {
			n = "command"
		}
		return fmt.Sprintf("of %s, %d %s", s.Template, len(s.Run), n)
	case ServiceSpec:
		return fmt.Sprintf("%s, %s, %d to %d", s.Template, strings.Join(s.Ports, " "), s.Min, max(s.Max, s.Min, 1))
	case MachineSpec:
		return fmt.Sprintf("%s × %d", s.Template, max(s.Count, 1))
	case LinkSpec:
		as, port := s.As, s.AsPort
		if as == "" {
			as = s.To
		}
		if port == 0 {
			port = s.Port
		}
		return fmt.Sprintf("%s reaches %s:%d as %s:%d, %s", s.From, s.To, s.Port, as, port, s.Mode)
	}
	return ""
}

// Empty says whether there is nothing to do.
func (p *Plan) Empty() bool { return len(p.Steps) == 0 }

// Apply carries out the plan: what goes, then what comes, in order; logf reports each step.
func (p *Plan) Apply(api API, build Builder, logf func(string, ...any)) error {
	for _, h := range p.removes {
		logf("- %s %s", h.kind, h.name)
		if err := remove(api, h.kind, h.name); err != nil && !daemon.NotFound(err) {
			return fmt.Errorf("removing %s %s: %w", h.kind, h.name, err)
		}
	}
	for _, o := range p.creates {
		begun := time.Now()
		if err := p.create(api, build, o, logf); err != nil {
			return fmt.Errorf("%s %s: %w", o.Kind, o.Name, err)
		}
		logf("+ %s %s (%s)", o.Kind, p.names(o)[0], time.Since(begun).Round(time.Millisecond))
	}
	return nil
}

func remove(api API, kind, name string) error {
	switch kind {
	case KindTemplate:
		return api.RemoveTemplate(name)
	case KindSnapshot:
		return api.RemoveSnapshot(name)
	case KindService:
		return api.RemoveService(name)
	case KindMachine:
		return api.RemoveMachine(name)
	case KindLink:
		return api.RemoveLink(name)
	}
	return fmt.Errorf("a %s?", kind)
}

// labels are what an object carries: the fleet, its spec's hash, and per instance its entry and
// instance.
func (p *Plan) labels(o Object, extra map[string]string) map[string]string {
	l := map[string]string{}
	for k, v := range extra {
		l[k] = v
	}
	l[FleetLabel] = p.file.Name
	l[SpecLabel] = o.Hash
	if perInstance(o) {
		l[EntryLabel] = o.Name
		l[daemon.InstanceLabel] = p.Instance
	}
	return l
}

func durationOf(s string) daemon.Duration {
	d, _ := time.ParseDuration(s)
	return daemon.Duration(d)
}

// ports are an instance's host ports: the file's in main, the system's choice elsewhere (two
// instances can't hold one port).
func (p *Plan) ports(specs []string) ([]daemon.Port, error) {
	var out []daemon.Port
	for _, spec := range specs {
		port, err := daemon.ParsePort(spec)
		if err != nil {
			return nil, err
		}
		if p.Instance != Main {
			port.Host = 0
		}
		out = append(out, port)
	}
	return out, nil
}

// templateOf is the template a link's end is (an entry of the file: a template, or the template
// of a service or machine).
func (f *File) templateOf(name string) string {
	if _, ok := f.Templates[name]; ok {
		return name
	}
	if s, ok := f.Services[name]; ok {
		return s.Template
	}
	return f.Machines[name].Template
}

func (p *Plan) create(api API, build Builder, o Object, logf func(string, ...any)) error {
	switch s := o.Spec.(type) {
	case TemplateSpec:
		site := s.Site
		if s.Build != "" {
			site = p.file.BuildDir(o.Name)
			logf("  building %s into %s", s.Build, site)
			if err := build(s.Build, site, s.Network); err != nil {
				return fmt.Errorf("build: %w", err)
			}
		}
		_, err := api.AddTemplate(daemon.AddTemplate{Site: site, Name: o.Name, MaxMachines: s.MaxMachines,
			Idle: durationOf(s.Idle), Snapshot: s.Snapshot, Egress: s.egress(), Labels: p.labels(o, nil)})
		return err
	case SnapshotSpec:
		return p.snapshot(api, o, s, logf)
	case ServiceSpec:
		var ports []daemon.Port
		for _, spec := range s.Ports {
			port, err := daemon.ParsePort(spec)
			if err != nil {
				return err
			}
			if p.Instance != Main {
				port.Host = 0
			}
			ports = append(ports, port)
		}
		_, err := api.AddService(daemon.Service{Name: p.names(o)[0], Template: s.Template, Ports: ports, Min: s.Min, Max: s.Max,
			Idle: durationOf(s.Idle), Concurrency: s.Concurrency, State: s.State, Labels: p.labels(o, s.Labels)})
		return err
	case LinkSpec:
		l := daemon.Link{Name: p.names(o)[0], Port: s.Port, As: s.As, AsPort: s.AsPort, Labels: p.labels(o, nil)}
		if l.As == "" {
			l.As = s.To
		}
		if s.Mode == Exclusive {
			// Inside the instance: its machines, to its service or machine
			l.Instance = p.Instance
			l.From, l.FromKind = s.From, KindTemplate
			if _, ok := p.file.Machines[s.From]; ok {
				l.From, l.FromKind = nameIn(s.From, p.Instance), KindMachine
			}
			l.To, l.ToKind = nameIn(s.To, p.Instance), KindService
			if _, ok := p.file.Machines[s.To]; ok {
				l.ToKind = KindMachine
			}
		} else {
			// Across instances: every machine of the template, to any machine of the target's
			l.From, l.FromKind = p.file.templateOf(s.From), KindTemplate
			l.To, l.ToKind = p.file.templateOf(s.To), KindTemplate
		}
		_, err := api.AddLink(l)
		return err
	case MachineSpec:
		ports, err := p.ports(s.Ports)
		if err != nil {
			return err
		}
		var specs []string
		for _, port := range ports {
			specs = append(specs, fmt.Sprintf("%s:%d:%d", port.IP, port.Host, port.Guest))
		}
		for _, n := range p.names(o) {
			if _, err := api.Up(daemon.Up{Template: s.Template, Name: n, Ports: specs, TTL: durationOf(s.TTL), Labels: p.labels(o, s.Labels)}); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("a %T?", o.Spec)
}

// snapshot sets a machine of the template up with its commands, waits for it to be ready, and
// saves it; the machine goes either way.
func (p *Plan) snapshot(api API, o Object, s SnapshotSpec, logf func(string, ...any)) error {
	setup := o.Name + "-setup"
	// One left by an apply of this fleet that failed or was interrupted: it goes, as this one's
	// will (another's, or one outside any fleet, stays, and the name stays taken)
	ms, err := api.Machines(map[string]string{FleetLabel: p.file.Name})
	if err != nil {
		return err
	}
	for _, m := range ms {
		if m.Name == setup && m.Labels[FleetLabel] == p.file.Name && m.Labels[EntryLabel] == "" {
			logf("  %s: left by an earlier apply, removed", setup)
			if err := api.RemoveMachine(setup); err != nil && !daemon.NotFound(err) {
				return err
			}
		}
	}
	if _, err := api.Up(daemon.Up{Template: s.Template, Name: setup, Labels: map[string]string{FleetLabel: p.file.Name}}); err != nil {
		return err
	}
	defer api.RemoveMachine(setup)
	for i, c := range s.Run {
		logf("  %s: %s", setup, brief(c.Cmd))
		limit := s.Limit(c)
		res, err := api.Job(setup, control.JobRequest{Cmd: c.Cmd, Timeout: limit.Seconds()})
		if err != nil {
			return err
		}
		if res.TimedOut {
			return fmt.Errorf("command %d of %d timed out (its limit %s): %q: %s", i+1, len(s.Run), limit, brief(c.Cmd), strings.TrimSpace(string(res.Output)))
		}
		if res.Status == nil || *res.Status != 0 {
			return fmt.Errorf("%q failed (%s): %s", brief(c.Cmd), status(res), strings.TrimSpace(string(res.Output)))
		}
	}
	if s.Ready != "" {
		timeout := 2 * time.Minute
		if s.Timeout != "" {
			timeout, _ = time.ParseDuration(s.Timeout)
		}
		for deadline := time.Now().Add(timeout); ; time.Sleep(500 * time.Millisecond) {
			res, err := api.Job(setup, control.JobRequest{Cmd: s.Ready, Timeout: 60})
			if err != nil {
				return err
			}
			if res.Status != nil && *res.Status == 0 {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("not ready within %s: %q: %s", timeout, brief(s.Ready), strings.TrimSpace(string(res.Output)))
			}
		}
	}
	_, err = api.SnapshotWith(setup, o.Name, p.labels(o, nil))
	return err
}

// brief is a command for a log line or an error: a multi-line one (a script in a ”' string) by its first
// line and how many more it has, not all of it with its newlines.
func brief(cmd string) string {
	lines := strings.Split(strings.TrimSpace(cmd), "\n")
	if len(lines) == 1 {
		return lines[0]
	}
	return fmt.Sprintf("%s … (+%d lines)", strings.TrimSpace(lines[0]), len(lines)-1)
}

func status(res *control.JobResult) string {
	if res.Status == nil {
		return "out of time"
	}
	return fmt.Sprintf("exit %d", *res.Status)
}

// Down removes everything of fleet name, what is made from something before it.
func Down(api API, name string, logf func(string, ...any)) (int, error) {
	return down(api, name, "", logf)
}

// DownInstance removes instance inst of fleet name: its services, machines and links. What the
// instances share stays.
func DownInstance(api API, name, inst string, logf func(string, ...any)) (int, error) {
	if inst == "" {
		return 0, fmt.Errorf("an instance")
	}
	return down(api, name, inst, logf)
}

func down(api API, name, inst string, logf func(string, ...any)) (int, error) {
	mine, _, err := current(api, name, inst)
	if err != nil {
		return 0, err
	}
	if inst != "" {
		var only []have
		for _, h := range mine {
			if h.instance == inst {
				only = append(only, h)
			}
		}
		mine = only
	}
	// The fleet's setup machines and services' replicas go with their services and templates
	sortRemoves(mine)
	for _, h := range mine {
		logf("- %s %s", h.kind, h.name)
		if err := remove(api, h.kind, h.name); err != nil && !daemon.NotFound(err) {
			return 0, fmt.Errorf("removing %s %s: %w", h.kind, h.name, err)
		}
	}
	return len(mine), nil
}
