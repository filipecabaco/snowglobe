package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// Registry is the fleets a daemon knows, like a compose project list: each a snowglobe.toml,
// added from where it is or written in the daemon's own directory (fleets/NAME/snowglobe.toml),
// kept in fleets.json. A fleet that made something carries its name on it (FleetLabel), so a
// fleet whose file was never added still shows, without a file.
type Registry struct {
	dir string
	mu  sync.Mutex
}

// Entry is a known fleet's file.
type Entry struct {
	Name string `json:"name"`
	File string `json:"file"`
}

// NewRegistry keeps the fleets of the daemon whose directory is dir.
func NewRegistry(dir string) *Registry { return &Registry{dir: dir} }

func (r *Registry) path() string { return filepath.Join(r.dir, "fleets.json") }

func (r *Registry) load() []Entry {
	var es []Entry
	data, err := os.ReadFile(r.path())
	if err == nil {
		json.Unmarshal(data, &es)
	}
	return es
}

func (r *Registry) save(es []Entry) error {
	sort.Slice(es, func(i, j int) bool { return es[i].Name < es[j].Name })
	data, _ := json.MarshalIndent(es, "", "  ")
	tmp := r.path() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.path())
}

// File is fleet name's file, if it was added.
func (r *Registry) File(name string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.load() {
		if e.Name == name {
			return e.File, true
		}
	}
	return "", false
}

// Add adds the fleet file at path (a full path): its name is the fleet's.
func (r *Registry) Add(path string) (*Entry, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("file: a fleet file's full path on the daemon's host")
	}
	f, err := Load(path)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	es := r.load()
	for _, e := range es {
		if e.Name == f.Name {
			if e.File == path {
				return &e, nil
			}
			return nil, fmt.Errorf("a fleet called %s is added already, from %s", f.Name, e.File)
		}
	}
	e := Entry{Name: f.Name, File: path}
	return &e, r.save(append(es, e))
}

// Write checks text as fleet name's file and writes it: over its file if it was added, else as a
// new one in the daemon's directory, which it adds. Its name must be name (or none).
func (r *Registry) Write(name, text string) (*Entry, error) {
	if !nameRE.MatchString(name) {
		return nil, fmt.Errorf("name %q: letters, digits, - and _", name)
	}
	path, ok := r.File(name)
	if !ok {
		path = filepath.Join(r.dir, "fleets", name, "snowglobe.toml")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	// Checked where it goes (its relative paths are from there), then put in place
	tmp := filepath.Join(filepath.Dir(path), ".snowglobe.toml.new")
	if err := os.WriteFile(tmp, []byte(text), 0o600); err != nil {
		return nil, err
	}
	f, err := Load(tmp)
	if err == nil && f.Name != name && f.Name != filepath.Base(filepath.Dir(tmp)) {
		err = fmt.Errorf("name = %q in the file: this fleet is %s", f.Name, name)
	}
	if err == nil && f.Name != name {
		// No name in it: the directory's, which a new fleet's is; an added file's may differ
		text = fmt.Sprintf("name = %q\n", name) + text
		os.WriteFile(tmp, []byte(text), 0o600)
	}
	if err != nil {
		os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	if ok {
		return &Entry{Name: name, File: path}, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	e := Entry{Name: name, File: path}
	return &e, r.save(append(r.load(), e))
}

// Forget drops fleet name from the list (its file stays where it is, unless the daemon wrote it).
func (r *Registry) Forget(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	es := r.load()
	for i, e := range es {
		if e.Name == name {
			if strings.HasPrefix(e.File, filepath.Join(r.dir, "fleets")+string(filepath.Separator)) {
				os.RemoveAll(filepath.Dir(e.File))
			}
			return r.save(append(es[:i], es[i+1:]...))
		}
	}
	return daemon.ErrNotFound("fleet " + name)
}

// Fleets is every fleet the daemon knows: added ones, and ones only their labels name, each with
// what of it the daemon has and what its plan would do.
func (r *Registry) Fleets(api API) ([]daemon.FleetInfo, error) {
	r.mu.Lock()
	es := r.load()
	r.mu.Unlock()
	counts, err := labelled(api)
	if err != nil {
		return nil, err
	}
	out := []daemon.FleetInfo{}
	seen := map[string]bool{}
	for _, e := range es {
		seen[e.Name] = true
		info := daemon.FleetInfo{Name: e.Name, File: e.File, Objects: counts[e.Name], Owned: strings.HasPrefix(e.File, filepath.Join(r.dir, "fleets"))}
		if f, err := Load(e.File); err != nil {
			info.Error = err.Error()
		} else if p, err := f.Plan(api); err != nil {
			info.Error = err.Error()
		} else {
			info.Pending = len(p.Steps)
		}
		info.Instances, _ = Instances(api, e.Name)
		out = append(out, info)
	}
	for name, n := range counts {
		if !seen[name] {
			inst, _ := Instances(api, name)
			out = append(out, daemon.FleetInfo{Name: name, Objects: n, Instances: inst})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// labelled counts what the daemon has of each fleet.
func labelled(api API) (map[string]int, error) {
	n := map[string]int{}
	ts, err := api.Templates()
	if err != nil {
		return nil, err
	}
	for _, t := range ts {
		if f := t.Labels[FleetLabel]; f != "" {
			n[f]++
		}
	}
	ss, err := api.Services()
	if err != nil {
		return nil, err
	}
	for _, s := range ss {
		if f := s.Labels[FleetLabel]; f != "" {
			n[f]++
		}
	}
	ms, err := api.Machines(nil)
	if err != nil {
		return nil, err
	}
	for _, m := range ms {
		if f := m.Labels[FleetLabel]; f != "" && m.Labels[EntryLabel] != "" {
			n[f]++
		}
	}
	ls, err := api.Links()
	if err != nil {
		return nil, err
	}
	for _, l := range ls {
		if f := l.Labels[FleetLabel]; f != "" {
			n[f]++
		}
	}
	return n, nil
}

// readText is a fleet file's text (at most 1 MiB).
func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > 1<<20 {
		return "", fmt.Errorf("%s: more than 1 MiB", path)
	}
	return string(data), nil
}
