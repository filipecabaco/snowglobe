package fleet

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// EntryLabel names the machine entry a machine was made for (an entry with count makes several)
const EntryLabel = "snowglobe.entry"

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
}

// Builder builds the site of a Dockerfile directory into out (snowglobe build DIR --out OUT).
type Builder func(dir, out, network string) error

// Step is one thing a plan does.
type Step struct {
	// "create", "replace" or "remove"
	Action string
	Kind   string
	Name   string
	// What it is, or why
	Detail string
}

func (s Step) String() string {
	mark := map[string]string{"create": "+", "replace": "~", "remove": "-"}[s.Action]
	line := fmt.Sprintf("%s %s %s", mark, s.Kind, s.Name)
	if s.Detail != "" {
		line += " (" + s.Detail + ")"
	}
	return line
}

// Plan is what it takes to get from what the daemon has to what the file wants.
type Plan struct {
	Steps []Step
	// How many of the file's objects are as it wants already
	Unchanged int

	file    *File
	removes []have
	creates []Object
}

// have is something of the fleet's the daemon has.
type have struct {
	kind, name, hash string
	// For a machine: its entry; for a template: whether it is of a snapshot
	entry      string
	ofSnapshot bool
}

func (h have) key() string {
	if h.kind == KindMachine {
		return KindMachine + "/" + h.entry
	}
	return h.kind + "/" + h.name
}

// current is what the daemon has: the fleet's, and every name in use.
func current(api API, fleet string) ([]have, map[string]string, error) {
	var mine []have
	taken := map[string]string{}
	ts, err := api.Templates()
	if err != nil {
		return nil, nil, err
	}
	for _, t := range ts {
		taken[KindTemplate+"/"+t.Name] = t.Labels[FleetLabel]
		if t.Labels[FleetLabel] == fleet {
			mine = append(mine, have{kind: KindTemplate, name: t.Name, hash: t.Labels[SpecLabel], ofSnapshot: t.Snapshot != ""})
		}
	}
	ss, err := api.Snapshots()
	if err != nil {
		return nil, nil, err
	}
	for _, s := range ss {
		taken[KindSnapshot+"/"+s.Name] = s.Labels[FleetLabel]
		if s.Labels[FleetLabel] == fleet {
			mine = append(mine, have{kind: KindSnapshot, name: s.Name, hash: s.Labels[SpecLabel]})
		}
	}
	svcs, err := api.Services()
	if err != nil {
		return nil, nil, err
	}
	for _, s := range svcs {
		taken[KindService+"/"+s.Name] = s.Labels[FleetLabel]
		if s.Labels[FleetLabel] == fleet {
			mine = append(mine, have{kind: KindService, name: s.Name, hash: s.Labels[SpecLabel]})
		}
	}
	ms, err := api.Machines(nil)
	if err != nil {
		return nil, nil, err
	}
	for _, m := range ms {
		taken[KindMachine+"/"+m.Name] = m.Labels[FleetLabel]
		// A service's replicas are the service's
		if m.Labels[FleetLabel] == fleet && m.Labels[EntryLabel] != "" {
			mine = append(mine, have{kind: KindMachine, name: m.Name, hash: m.Labels[SpecLabel], entry: m.Labels[EntryLabel]})
		}
	}
	return mine, taken, nil
}

// Plan works out what Apply would do.
func (f *File) Plan(api API) (*Plan, error) {
	want, err := f.objects()
	if err != nil {
		return nil, err
	}
	mine, taken, err := current(api, f.Name)
	if err != nil {
		return nil, err
	}
	p := &Plan{file: f}
	wanted := map[string]Object{}
	for _, o := range want {
		wanted[o.Key()] = o
	}
	// What the fleet has, by entry: a machine entry may have several machines
	haveHash := map[string][]string{}
	for _, h := range mine {
		haveHash[h.key()] = append(haveHash[h.key()], h.hash)
	}
	// Names the daemon has that aren't the fleet's
	var conflicts []string
	for _, o := range want {
		names := []string{o.Name}
		if o.Kind == KindMachine {
			names = MachineNames(o.Name, o.Spec.(MachineSpec))
		}
		for _, n := range names {
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
		if o.Kind == KindMachine && same && len(hashes) != len(MachineNames(o.Name, o.Spec.(MachineSpec))) {
			same = false
		}
		switch {
		case same:
			p.Unchanged++
		case had:
			p.Steps = append(p.Steps, Step{Action: "replace", Kind: o.Kind, Name: o.Name, Detail: "changed"})
			p.creates = append(p.creates, o)
		default:
			p.Steps = append(p.Steps, Step{Action: "create", Kind: o.Kind, Name: o.Name, Detail: describe(o)})
			p.creates = append(p.creates, o)
		}
	}
	replaced := map[string]bool{}
	for _, o := range p.creates {
		replaced[o.Key()] = true
	}
	for _, h := range mine {
		if _, ok := wanted[h.key()]; !ok {
			p.Steps = append(p.Steps, Step{Action: "remove", Kind: h.kind, Name: h.name, Detail: "not in the file"})
			p.removes = append(p.removes, h)
		} else if replaced[h.key()] {
			p.removes = append(p.removes, h)
		}
	}
	sortRemoves(p.removes)
	return p, nil
}

// sortRemoves puts what is made from something before it: machines and services, templates of
// snapshots, snapshots, then templates.
func sortRemoves(hs []have) {
	rank := func(h have) int {
		switch {
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
		switch {
		case s.Build != "":
			return "build " + s.Build
		case s.Snapshot != "":
			return "of snapshot " + s.Snapshot
		}
		return s.Site
	case SnapshotSpec:
		return fmt.Sprintf("of %s, %d commands", s.Template, len(s.Run))
	case ServiceSpec:
		return fmt.Sprintf("%s, %s, %d to %d", s.Template, strings.Join(s.Ports, " "), s.Min, max(s.Max, s.Min, 1))
	case MachineSpec:
		return fmt.Sprintf("%s × %d", s.Template, max(s.Count, 1))
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
		logf("+ %s %s (%s)", o.Kind, o.Name, time.Since(begun).Round(time.Millisecond))
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
	}
	return fmt.Errorf("a %s?", kind)
}

func (p *Plan) labels(o Object, extra map[string]string) map[string]string {
	l := map[string]string{}
	for k, v := range extra {
		l[k] = v
	}
	l[FleetLabel] = p.file.Name
	l[SpecLabel] = o.Hash
	return l
}

func durationOf(s string) daemon.Duration {
	d, _ := time.ParseDuration(s)
	return daemon.Duration(d)
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
			Idle: durationOf(s.Idle), Snapshot: s.Snapshot, AllowPrivate: s.AllowPrivate, Labels: p.labels(o, nil)})
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
			ports = append(ports, port)
		}
		_, err := api.AddService(daemon.Service{Name: o.Name, Template: s.Template, Ports: ports, Min: s.Min, Max: s.Max,
			Idle: durationOf(s.Idle), Concurrency: s.Concurrency, State: s.State, Labels: p.labels(o, s.Labels)})
		return err
	case MachineSpec:
		for _, n := range MachineNames(o.Name, s) {
			l := p.labels(o, s.Labels)
			l[EntryLabel] = o.Name
			if _, err := api.Up(daemon.Up{Template: s.Template, Name: n, Ports: s.Ports, TTL: durationOf(s.TTL), Labels: l}); err != nil {
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
	if _, err := api.Up(daemon.Up{Template: s.Template, Name: setup, Labels: map[string]string{FleetLabel: p.file.Name}}); err != nil {
		return err
	}
	defer api.RemoveMachine(setup)
	for _, cmd := range s.Run {
		logf("  %s: %s", setup, cmd)
		res, err := api.Job(setup, control.JobRequest{Cmd: cmd, Timeout: 600})
		if err != nil {
			return err
		}
		if res.Status == nil || *res.Status != 0 {
			return fmt.Errorf("%q failed (%s): %s", cmd, status(res), strings.TrimSpace(string(res.Output)))
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
				return fmt.Errorf("not ready within %s: %q: %s", timeout, s.Ready, strings.TrimSpace(string(res.Output)))
			}
		}
	}
	_, err := api.SnapshotWith(setup, o.Name, p.labels(o, nil))
	return err
}

func status(res *control.JobResult) string {
	if res.Status == nil {
		return "out of time"
	}
	return fmt.Sprintf("exit %d", *res.Status)
}

// Down removes everything of fleet name, what is made from something before it.
func Down(api API, name string, logf func(string, ...any)) (int, error) {
	mine, _, err := current(api, name)
	if err != nil {
		return 0, err
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
