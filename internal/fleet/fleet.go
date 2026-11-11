// Package fleet is snowglobe's declarative side: a snowglobe.toml describes templates (a built
// site, a URL, or a Dockerfile directory to build first), snapshots made from them (a machine set
// up by commands, saved once ready), templates of those snapshots, services and machines; diff
// says what it would take to get the daemon there, apply does it, and down removes all of it.
//
// What a fleet makes carries two labels: snowglobe.fleet (its name) and snowglobe.spec (a hash of
// the entry that made it). What has the fleet's label and isn't in the file is removed; what is in
// it with another hash is replaced, with everything made from it.
//
// Nothing joins its machines but what the file says. [network] mode says how its links resolve:
// "exclusive" (the default) keeps each instance to itself (app#2 reaches db#2), "inclusive" lets
// every machine of a template reach any machine of the target's template across instances, and
// "all" also links every template to every other one's exposed ports (expose). A template's
// egress is "none" unless the file says "internet" or "private".
//
// A fleet runs as instances, like `docker compose -p`: templates and snapshots are shared (built
// and restored once), services, machines and exclusive links are made per instance, labelled
// snowglobe.instance. Instance main keeps the file's names; another's carry its name
// (db-2), and its host ports are picked by the system.
package fleet

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// The labels a fleet puts on what it makes
const (
	FleetLabel = "snowglobe.fleet"
	SpecLabel  = "snowglobe.spec"
)

// File is a snowglobe.toml.
type File struct {
	// The fleet's name (default: the file's directory's)
	Name      string                  `toml:"name"`
	Templates map[string]TemplateSpec `toml:"templates"`
	Snapshots map[string]SnapshotSpec `toml:"snapshots"`
	Services  map[string]ServiceSpec  `toml:"services"`
	Machines  map[string]MachineSpec  `toml:"machines"`
	Links     map[string]LinkSpec     `toml:"links"`
	Network   NetworkSpec             `toml:"network"`
	// Where the file is: relative paths in it are from here
	Dir string `toml:"-"`
}

// TemplateSpec is a template: of a built site, of a Dockerfile directory built first, or of a
// snapshot in the same file.
type TemplateSpec struct {
	Site        string `toml:"site" json:"site,omitempty"`
	Build       string `toml:"build" json:"build,omitempty"`
	Network     string `toml:"network" json:"network,omitempty"`
	Snapshot    string `toml:"snapshot" json:"snapshot,omitempty"`
	Idle        string `toml:"idle" json:"idle,omitempty"`
	MaxMachines int    `toml:"max_machines" json:"max_machines,omitempty"`
	// Its machines may reach the host's loopback and private addresses: another template's service
	// through a tcp:// tunnel the site was built with, say
	AllowPrivate bool `toml:"allow_private" json:"allow_private,omitempty"`
	// Where its machines' connections may go: none (the default: only links and forwarded ports),
	// internet, or private (also the host's loopback and private addresses)
	Egress string `toml:"egress" json:"egress,omitempty"`
	// Guest ports the other templates reach it on under [network] mode = "all"
	Expose []int `toml:"expose" json:"expose,omitempty"`
	// What the build saw of its directory (a hash of its files' names, sizes and times): a change
	// rebuilds
	Source string `toml:"-" json:"source,omitempty"`
}

// SnapshotSpec is a machine of a template set up by commands (each must succeed), saved once
// Ready succeeds (retried until Timeout, default 2m). A command's time is its own timeout, or else
// Timeout, or else 10m.
type SnapshotSpec struct {
	Template string    `toml:"template" json:"template"`
	Run      []Command `toml:"run" json:"run,omitempty"`
	Ready    string    `toml:"ready" json:"ready,omitempty"`
	Timeout  string    `toml:"timeout" json:"timeout,omitempty"`
}

// Command is one of a snapshot's setup commands: a string, or { cmd = "...", timeout = "90s" } for
// one with a time limit of its own.
type Command struct {
	Cmd     string `json:"cmd"`
	Timeout string `json:"timeout,omitempty"`
}

// CommandTimeout is a command's time when neither it nor its snapshot says.
const CommandTimeout = 10 * time.Minute

// UnmarshalTOML reads a command as a string or as a table of cmd and timeout.
func (c *Command) UnmarshalTOML(v any) error {
	switch v := v.(type) {
	case string:
		c.Cmd = v
		return nil
	case map[string]any:
		for k, x := range v {
			s, ok := x.(string)
			if !ok {
				return fmt.Errorf("run: %s: a string", k)
			}
			switch k {
			case "cmd":
				c.Cmd = s
			case "timeout":
				c.Timeout = s
			default:
				return fmt.Errorf("run: unknown key %s (a command is cmd and timeout)", k)
			}
		}
		if strings.TrimSpace(c.Cmd) == "" {
			return fmt.Errorf("run: a command table needs cmd")
		}
		return nil
	}
	return fmt.Errorf("run: a command, as a string or { cmd, timeout }")
}

// MarshalJSON gives a command with no timeout of its own as its string, so a file's hashes (and
// so what is already set up) don't change for commands written as before.
func (c Command) MarshalJSON() ([]byte, error) {
	if c.Timeout == "" {
		return json.Marshal(c.Cmd)
	}
	type plain Command
	return json.Marshal(plain(c))
}

// UnmarshalJSON reads what MarshalJSON writes.
func (c *Command) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		*c = Command{}
		return json.Unmarshal(data, &c.Cmd)
	}
	type plain Command
	return json.Unmarshal(data, (*plain)(c))
}

// Limit is how long the command may run: its own timeout, the snapshot's, or CommandTimeout.
func (s SnapshotSpec) Limit(c Command) time.Duration {
	for _, v := range []string{c.Timeout, s.Timeout} {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return CommandTimeout
}

// ServiceSpec is a service (see `snowglobe service add`).
type ServiceSpec struct {
	Template    string            `toml:"template" json:"template"`
	Ports       []string          `toml:"ports" json:"ports,omitempty"`
	Min         int               `toml:"min" json:"min"`
	Max         int               `toml:"max" json:"max,omitempty"`
	Idle        string            `toml:"idle" json:"idle,omitempty"`
	Concurrency int               `toml:"concurrency" json:"concurrency,omitempty"`
	State       string            `toml:"state" json:"state,omitempty"`
	Labels      map[string]string `toml:"labels" json:"labels,omitempty"`
}

// MachineSpec is Count machines of a template (named NAME, or NAME-1 to NAME-Count).
type MachineSpec struct {
	Template string            `toml:"template" json:"template"`
	Count    int               `toml:"count" json:"count,omitempty"`
	Ports    []string          `toml:"ports" json:"ports,omitempty"`
	TTL      string            `toml:"ttl" json:"ttl,omitempty"`
	Labels   map[string]string `toml:"labels" json:"labels,omitempty"`
}

// NetworkSpec is a fleet's network profile.
type NetworkSpec struct {
	// exclusive (the default), inclusive or all
	Mode string `toml:"mode"`
}

// Network modes
const (
	Exclusive = "exclusive"
	Inclusive = "inclusive"
	All       = "all"
)

// mode is the fleet's network mode.
func (f *File) mode() string {
	if f.Network.Mode == "" {
		return Exclusive
	}
	return f.Network.Mode
}

// egress is a template's egress: none unless it says, private with allow_private.
func (t TemplateSpec) egress() string {
	switch {
	case t.Egress != "":
		return t.Egress
	case t.AllowPrivate:
		return "private"
	}
	return "none"
}

// LinkSpec is a link: the guests of From (a template or machine of the file) reach To (a service
// or machine of the file) at its guest Port as As:AsPort (To and Port by default).
type LinkSpec struct {
	From   string `toml:"from" json:"from"`
	To     string `toml:"to" json:"to"`
	Port   int    `toml:"port" json:"port"`
	As     string `toml:"as" json:"as,omitempty"`
	AsPort int    `toml:"as_port" json:"as_port,omitempty"`
	// The network mode it resolves under (the file's)
	Mode string `toml:"-" json:"mode,omitempty"`
}

var nameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)

// Load reads and checks a fleet file.
func Load(path string) (*File, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	var f File
	md, err := toml.DecodeFile(abs, &f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		keys := make([]string, len(undecoded))
		for i, k := range undecoded {
			keys[i] = k.String()
		}
		return nil, fmt.Errorf("%s: unknown keys: %s", path, strings.Join(keys, ", "))
	}
	f.Dir = filepath.Dir(abs)
	if f.Name == "" {
		f.Name = filepath.Base(f.Dir)
	}
	// A file saved with CRLF line endings (a Windows editor, or git's autocrlf) keeps them inside a
	// multi-line string, and a \r at the end of a shell line is part of its last word: the commands
	// get LF endings, as the browser page's reader gives them
	for n, s := range f.Snapshots {
		run := make([]Command, len(s.Run))
		for i, c := range s.Run {
			run[i] = Command{Cmd: strings.ReplaceAll(c.Cmd, "\r\n", "\n"), Timeout: c.Timeout}
		}
		s.Run, s.Ready = run, strings.ReplaceAll(s.Ready, "\r\n", "\n")
		f.Snapshots[n] = s
	}
	return &f, f.check()
}

func (f *File) check() error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if !nameRE.MatchString(f.Name) {
		bad("name %q: letters, digits, - and _", f.Name)
	}
	duration := func(what, v string) {
		if v == "" {
			return
		}
		if _, err := time.ParseDuration(v); err != nil {
			bad("%s: %q is not a duration (30s, 5m, 1h)", what, v)
		}
	}
	names := map[string]string{}
	name := func(kind, n string) {
		if !nameRE.MatchString(n) {
			bad("%s %q: 1 to 63 letters, digits, - or _", kind, n)
		}
	}
	for n, t := range f.Templates {
		name("template", n)
		set := 0
		for _, v := range []string{t.Site, t.Build, t.Snapshot} {
			if v != "" {
				set++
			}
		}
		if set != 1 {
			bad("template %s: one of site, build or snapshot", n)
		}
		if t.Snapshot != "" {
			if _, ok := f.Snapshots[t.Snapshot]; !ok {
				bad("template %s: no snapshot %s in the file", n, t.Snapshot)
			}
		}
		if t.Network != "" && t.Build == "" {
			bad("template %s: network is for build", n)
		}
		switch t.Egress {
		case "", "none", "internet", "private":
		default:
			bad("template %s: egress %q: none, internet or private", n, t.Egress)
		}
		if t.AllowPrivate && t.Egress != "" && t.Egress != "private" {
			bad("template %s: allow_private with egress %s", n, t.Egress)
		}
		for _, p := range t.Expose {
			if p < 1 || p > 65535 {
				bad("template %s: expose %d: 1 to 65535", n, p)
			}
		}
		duration("template "+n+": idle", t.Idle)
	}
	for n, s := range f.Snapshots {
		name("snapshot", n)
		if _, ok := f.Templates[s.Template]; !ok {
			bad("snapshot %s: no template %s in the file", n, s.Template)
		}
		duration("snapshot "+n+": timeout", s.Timeout)
		for i, c := range s.Run {
			duration(fmt.Sprintf("snapshot %s: run[%d]: timeout", n, i), c.Timeout)
		}
	}
	for n, s := range f.Services {
		name("service", n)
		names[n] = "service"
		if _, ok := f.Templates[s.Template]; !ok {
			bad("service %s: no template %s in the file", n, s.Template)
		}
		duration("service "+n+": idle", s.Idle)
	}
	for n, m := range f.Machines {
		name("machine", n)
		if other := names[n]; other != "" {
			bad("machine %s: a %s has that name", n, other)
		}
		if _, ok := f.Templates[m.Template]; !ok {
			bad("machine %s: no template %s in the file", n, m.Template)
		}
		if m.Count < 0 {
			bad("machine %s: count 0 or more", n)
		}
		duration("machine "+n+": ttl", m.TTL)
	}
	switch f.Network.Mode {
	case "", Exclusive, Inclusive, All:
	default:
		bad("network mode %q: exclusive, inclusive or all", f.Network.Mode)
	}
	for n, l := range f.Links {
		name("link", n)
		if _, ok := f.Templates[l.From]; !ok {
			if m, ok := f.Machines[l.From]; !ok || m.Count > 1 {
				bad("link %s: from a template, or a machine (count 1), of the file; not %q", n, l.From)
			}
		}
		if _, ok := f.Services[l.To]; !ok {
			if m, ok := f.Machines[l.To]; !ok || m.Count > 1 {
				bad("link %s: to a service, or a machine (count 1), of the file; not %q", n, l.To)
			}
		}
		if l.Port < 1 || l.Port > 65535 || l.AsPort < 0 || l.AsPort > 65535 {
			bad("link %s: port (the target's guest port) and as_port 1 to 65535", n)
		}
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	// A template of a snapshot of a template of a snapshot ... of itself
	if _, err := f.objects(); err != nil {
		return err
	}
	return nil
}

// linkEnd is the key of a link's end: the file's kind (a template or service, else a machine).
func (f *File) linkEnd(name, kind string) string {
	_, isTemplate := f.Templates[name]
	_, isService := f.Services[name]
	if kind == KindTemplate && isTemplate || kind == KindService && isService {
		return kind + "/" + name
	}
	return KindMachine + "/" + name
}

// path resolves a path in the file against its directory.

func (f *File) path(p string) string {
	if p == "" || filepath.IsAbs(p) || strings.Contains(p, "://") {
		return p
	}
	return filepath.Join(f.Dir, p)
}

// Kind of object a fleet makes
const (
	KindTemplate = "template"
	KindSnapshot = "snapshot"
	KindService  = "service"
	KindMachine  = "machine"
	KindLink     = "link"
)

// Object is one thing the fleet wants: its spec, a hash of it, and what it is made from.
type Object struct {
	Kind string
	Name string
	Spec any
	Hash string
	// The objects (kind/name) it is made from
	Deps []string
}

// Key is how plans name objects: kind/name.
func (o Object) Key() string { return o.Kind + "/" + o.Name }

// objects is what the file wants, in an order where each comes after what it is made from.
func (f *File) objects() ([]Object, error) {
	var all []Object
	for n, t := range f.Templates {
		t.Site = f.path(t.Site)
		if t.Build != "" {
			t.Build = f.path(t.Build)
			t.Source = sourceHash(t.Build)
		}
		o := Object{Kind: KindTemplate, Name: n, Spec: t}
		if t.Snapshot != "" {
			o.Deps = []string{KindSnapshot + "/" + t.Snapshot}
		}
		all = append(all, o)
	}
	for n, s := range f.Snapshots {
		all = append(all, Object{Kind: KindSnapshot, Name: n, Spec: s, Deps: []string{KindTemplate + "/" + s.Template}})
	}
	for n, s := range f.Services {
		all = append(all, Object{Kind: KindService, Name: n, Spec: s, Deps: []string{KindTemplate + "/" + s.Template}})
	}
	for n, m := range f.Machines {
		all = append(all, Object{Kind: KindMachine, Name: n, Spec: m, Deps: []string{KindTemplate + "/" + m.Template}})
	}
	for n, l := range f.Links {
		l.Mode = f.mode()
		all = append(all, Object{Kind: KindLink, Name: n, Spec: l, Deps: []string{f.linkEnd(l.From, KindTemplate), f.linkEnd(l.To, KindService)}})
	}
	// Mode all: every template reaches every other one's exposed ports by its name
	if f.mode() == All {
		for a := range f.Templates {
			for b, tb := range f.Templates {
				if a == b {
					continue
				}
				for _, port := range tb.Expose {
					n := fmt.Sprintf("all-%s-%s-%d", a, b, port)
					if !nameRE.MatchString(n) {
						sum := sha256.Sum256([]byte(n))
						n = "all-" + hex.EncodeToString(sum[:6])
					}
					all = append(all, Object{Kind: KindLink, Name: n, Spec: LinkSpec{From: a, To: b, Port: port, As: b, Mode: All},
						Deps: []string{KindTemplate + "/" + a, KindTemplate + "/" + b}})
				}
			}
		}
	}
	// Templates (and the snapshots they need) first, then services, machines and links; by name within
	rank := map[string]int{KindTemplate: 0, KindSnapshot: 1, KindService: 2, KindMachine: 3, KindLink: 4}

	sort.Slice(all, func(i, j int) bool {
		if rank[all[i].Kind] != rank[all[j].Kind] {
			return rank[all[i].Kind] < rank[all[j].Kind]
		}
		return all[i].Name < all[j].Name
	})
	byKey := map[string]*Object{}
	for i := range all {
		byKey[all[i].Key()] = &all[i]
	}
	// Hashes take in what they are made from: a template rebuilt makes its snapshots new too
	var ordered []Object
	state := map[string]int{} // 1 visiting, 2 done
	var visit func(o *Object) error
	visit = func(o *Object) error {
		switch state[o.Key()] {
		case 1:
			return fmt.Errorf("%s is made, in the end, from itself", o.Key())
		case 2:
			return nil
		}
		state[o.Key()] = 1
		var depHashes []string
		for _, d := range o.Deps {
			dep := byKey[d]
			if err := visit(dep); err != nil {
				return err
			}
			depHashes = append(depHashes, dep.Hash)
		}
		o.Hash = hash(o.Kind, o.Spec, depHashes)
		state[o.Key()] = 2
		ordered = append(ordered, *o)
		return nil
	}
	for i := range all {
		if err := visit(&all[i]); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}

func hash(kind string, spec any, deps []string) string {
	data, _ := json.Marshal(map[string]any{"kind": kind, "spec": spec, "deps": deps})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:6])
}

// sourceHash is a Dockerfile directory as a build sees it: its files' names, sizes and times.
func sourceHash(dir string) string {
	h := sha256.New()
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			rel, _ := filepath.Rel(dir, p)
			fmt.Fprintf(h, "%s %d %d\n", rel, info.Size(), info.ModTime().UnixNano())
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil)[:6])
}

// MachineNames are the machines a machine entry makes.
func MachineNames(name string, m MachineSpec) []string {
	if m.Count <= 1 {
		return []string{name}
	}
	out := make([]string, m.Count)
	for i := range out {
		out[i] = fmt.Sprintf("%s-%d", name, i+1)
	}
	return out
}

// BuildDir is where a template's build goes: .snowglobe/<fleet>/<template> beside the file.
func (f *File) BuildDir(template string) string {
	return filepath.Join(f.Dir, ".snowglobe", f.Name, template)
}
