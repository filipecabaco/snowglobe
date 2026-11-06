package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// Link lets machines reach another machine, a service or a template's machines by a name: a guest
// on the From side that connects to As:AsPort gets the target's guest port Port. Nothing else
// joins machines: without a link a machine reaches no other.
//
// Each machine on the From side gets a Unix socket of its own for each of its links, in its
// template's socket directory (which only that template's machines and the daemon reach), and a
// link to it: the daemon knows which machine connects, and no TCP port stays open on the host
// for anyone else to use. Links change while machines run; new connections follow them.
//
// Instance, when set, narrows a link to one instance of a fleet (InstanceLabel): only the From
// side's machines of it take the link, and a template target means its machines of the same
// instance. That is how a fleet's instances stay apart: app#1 reaches db#1 and nothing of #2.
type Link struct {
	Name string `json:"name"`
	// A machine, or a template (its machines, now and later)
	From     string `json:"from"`
	FromKind string `json:"from_kind"`
	// A machine, a service (one of its replicas, started if none runs) or a template (one of its
	// machines)
	To     string `json:"to"`
	ToKind string `json:"to_kind"`
	// The target's guest port
	Port int `json:"port"`
	// What the From side's guests connect to (the target's name and Port by default)
	As       string            `json:"as"`
	AsPort   int               `json:"as_port"`
	Instance string            `json:"instance,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	Created  time.Time         `json:"created"`
}

// Kinds of things
const (
	KindMachine  = "machine"
	KindTemplate = "template"
	KindService  = "service"
)

// InstanceLabel names the fleet instance a machine, service or link belongs to.
const InstanceLabel = "snowglobe.instance"

var hostRE = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)

// linkSock is one machine's socket for one link.
type linkSock struct {
	path string
	ln   net.Listener
}

// AddLink makes a link and gives it to the machines it is for.
func (s *Server) AddLink(req Link) (*Link, error) {
	l := req
	if l.Port <= 0 || l.Port > 65535 {
		return nil, errStatus(400, "port: the target's guest port (1 to 65535)")
	}
	if l.AsPort == 0 {
		l.AsPort = l.Port
	}
	if l.AsPort < 0 || l.AsPort > 65535 {
		return nil, errStatus(400, "as_port: 1 to 65535")
	}
	s.mu.Lock()
	var err error
	if l.FromKind, err = s.kindOf(l.From, l.FromKind, KindMachine, KindTemplate); err == nil {
		l.ToKind, err = s.kindOf(l.To, l.ToKind, KindMachine, KindService, KindTemplate)
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if l.FromKind == KindMachine && l.ToKind == KindMachine && l.From == l.To {
		return nil, errStatus(400, "a machine reaches itself on localhost: no link needed")
	}
	if l.As == "" {
		l.As = l.To
	}
	if !hostRE.MatchString(l.As) {
		return nil, errStatus(400, "as %q: a host name (letters, digits, dots and dashes)", l.As)
	}
	if l.Instance != "" {
		if err := validName(l.Instance); err != nil {
			return nil, errStatus(400, "instance: %v", err)
		}
	}
	if l.Name == "" {
		l.Name = fmt.Sprintf("%s-%s-%d", l.From, l.To, l.Port)
		if l.Instance != "" {
			l.Name += "-" + l.Instance
		}
	}
	if err := validName(l.Name); err != nil {
		return nil, errStatus(400, "%v", err)
	}
	// The target needs a network device to take the connections
	var tpl string
	switch l.ToKind {
	case KindMachine:
		t, err := s.templateOf(l.To)
		if err != nil {
			return nil, err
		}
		tpl = t.Name
	case KindTemplate:
		tpl = l.To
	}
	if tpl != "" {
		s.mu.Lock()
		t, ok := s.st.Templates[tpl]
		s.mu.Unlock()
		if ok {
			if err := needsNetwork(t); err != nil {
				return nil, errStatus(400, "%s %s: its guest has no network to take the link's connections", l.ToKind, l.To)
			}
		}
	}
	l.Created = time.Now()
	s.mu.Lock()
	if _, taken := s.st.Links[l.Name]; taken {
		s.mu.Unlock()
		return nil, errStatus(409, "a link called %s exists", l.Name)
	}
	for _, o := range s.st.Links {
		if o.From == l.From && o.FromKind == l.FromKind && o.Instance == l.Instance && strings.EqualFold(o.As, l.As) && o.AsPort == l.AsPort {
			s.mu.Unlock()
			return nil, errStatus(409, "%s %s reaches %s:%d already (link %s)", l.FromKind, l.From, l.As, l.AsPort, o.Name)
		}
	}
	s.st.Links[l.Name] = &l
	s.save()
	s.mu.Unlock()
	where := ""
	if l.Instance != "" {
		where = " in instance " + l.Instance
	}
	s.note("link.added", "link "+l.Name, "%s %s reaches %s %s:%d as %s:%d%s", l.FromKind, l.From, l.ToKind, l.To, l.Port, l.As, l.AsPort, where)
	s.relinkMachines(func(m *Machine) bool { return takes(&l, m) })
	return &l, nil
}

// takes says whether machine m is on link l's From side.
func takes(l *Link, m *Machine) bool {
	if l.Instance != "" && m.Labels[InstanceLabel] != l.Instance {
		return false
	}
	return l.FromKind == KindMachine && l.From == m.Name || l.FromKind == KindTemplate && l.From == m.Template
}

// kindOf says what name is, of the kinds allowed: want if given, else the first that has it.
// Called with s.mu held.
func (s *Server) kindOf(name, want string, kinds ...string) (string, error) {
	if name == "" {
		return "", errStatus(400, "a %s to link", strings.Join(kinds, " or "))
	}
	if want != "" {
		ok := false
		for _, k := range kinds {
			ok = ok || k == want
		}
		if !ok {
			return "", errStatus(400, "%s: a %s", want, strings.Join(kinds, " or "))
		}
		if !s.has(want, name) {
			return "", errStatus(404, "no %s called %s", want, name)
		}
		return want, nil
	}
	for _, k := range kinds {
		if s.has(k, name) {
			return k, nil
		}
	}
	return "", errStatus(404, "no %s called %s", strings.Join(kinds, " or "), name)
}

func (s *Server) templateOf(machine string) (*Template, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.st.Machines[machine]
	if !ok {
		return nil, errStatus(404, "no machine called %s", machine)
	}
	t, ok := s.st.Templates[m.Template]
	if !ok {
		return nil, errStatus(404, "%s: its template %s is gone", machine, m.Template)
	}
	c := *t
	return &c, nil
}

// target is the machine a connection over link l goes to now, and what to call when it ends (a
// replica's activity).
func (s *Server) target(l *Link) (*Machine, func(), error) {
	switch l.ToKind {
	case KindService:
		m, err := s.pickReplica(l.To)
		if err != nil {
			return nil, nil, err
		}
		s.touch(m.Name, 1)
		return m, func() { s.touch(m.Name, -1) }, nil
	case KindTemplate:
		// One of its machines (of the link's instance, when it has one): the least busy
		var picked *Machine
		least := -1
		for _, m := range s.Machines(nil) {
			if m.Template != l.To || l.Instance != "" && m.Labels[InstanceLabel] != l.Instance {
				continue
			}
			s.svc.mu.Lock()
			busy := 0
			if a := s.svc.activity[m.Name]; a != nil {
				busy = a.active
			}
			s.svc.mu.Unlock()
			if least < 0 || busy < least {
				c := m
				picked, least = &c, busy
			}
		}
		if picked == nil {
			in := ""
			if l.Instance != "" {
				in = " in instance " + l.Instance
			}
			return nil, nil, fmt.Errorf("no machine of %s runs%s", l.To, in)
		}
		s.touch(picked.Name, 1)
		return picked, func() { s.touch(picked.Name, -1) }, nil
	}
	m, err := s.Machine(l.To)
	return m, func() {}, err
}

// listenLink makes machine m's socket for link l, each connection to it going to l's target.
// Called with s.mu held.
func (s *Server) listenLink(l *Link, m *Machine) (*linkSock, error) {
	t, ok := s.st.Templates[m.Template]
	if !ok {
		return nil, fmt.Errorf("%s: its template %s is gone", m.Name, m.Template)
	}
	sum := sha256.Sum256([]byte(l.Name + "\x00" + m.Name))
	path := filepath.Join(t.SocketDir, "l-"+hex.EncodeToString(sum[:6])+".sock")
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	os.Chmod(path, 0o600)
	name := l.Name
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				s.mu.Lock()
				cur, ok := s.st.Links[name]
				var link Link
				if ok {
					link = *cur
				}
				s.mu.Unlock()
				if !ok {
					c.Close()
					return
				}
				to, done, err := s.target(&link)
				if err != nil {
					s.note("link.error", "link "+name, "%v", err)
					c.Close()
					return
				}
				defer done()
				splice(c, to.Socket, link.Port)
			}()
		}
	}()
	return &linkSock{path: path, ln: ln}, nil
}

// relinkMachines gives the machines which picks their links as they are now: a socket for each
// link they take, and none for any other.
func (s *Server) relinkMachines(which func(*Machine) bool) {
	type push struct {
		name, sock string
		links      []control.Link
	}
	var todo []push
	s.mu.Lock()
	for _, m := range s.st.Machines {
		if !which(m) {
			continue
		}
		mine := s.linkSocks[m.Name]
		if mine == nil {
			mine = map[string]*linkSock{}
			s.linkSocks[m.Name] = mine
		}
		var links []control.Link
		for _, l := range s.st.Links {
			if !takes(l, m) {
				continue
			}
			ls := mine[l.Name]
			if ls == nil {
				var err error
				if ls, err = s.listenLink(l, m); err != nil {
					s.o.Logf("link %s for %s: %v", l.Name, m.Name, err)
					continue
				}
				mine[l.Name] = ls
			}
			links = append(links, control.Link{Host: l.As, Port: l.AsPort, URL: "unix://" + ls.path})
		}
		for name, ls := range mine {
			if l, ok := s.st.Links[name]; !ok || !takes(l, m) {
				ls.ln.Close()
				os.Remove(ls.path)
				delete(mine, name)
			}
		}
		sort.Slice(links, func(i, j int) bool {
			return links[i].Host+fmt.Sprint(links[i].Port) < links[j].Host+fmt.Sprint(links[j].Port)
		})
		// A machine taking no link isn't told it has none, unless it had some
		if len(links) > 0 || s.linked[m.Name] {
			todo = append(todo, push{m.Name, m.Socket, links})
			s.linked[m.Name] = len(links) > 0
		}
	}
	s.mu.Unlock()
	for _, p := range todo {
		if err := control.SetLinks(p.sock, p.links); err != nil {
			s.note("link.error", "machine "+p.name, "its links: %v", err)
		}
	}
}

// unlinkMachine closes a machine's link sockets (it is gone).
func (s *Server) unlinkMachine(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ls := range s.linkSocks[name] {
		ls.ln.Close()
		os.Remove(ls.path)
	}
	delete(s.linkSocks, name)
	delete(s.linked, name)
}

// RemoveLink removes a link: the machines it was for lose it.
func (s *Server) RemoveLink(name string) error {
	s.mu.Lock()
	l, ok := s.st.Links[name]
	if !ok {
		s.mu.Unlock()
		return errStatus(404, "no link called %s", name)
	}
	delete(s.st.Links, name)
	s.save()
	s.mu.Unlock()
	s.note("link.removed", "link "+name, "removed")
	s.relinkMachines(func(m *Machine) bool { return takes(l, m) })
	return nil
}

// dropLinks removes the links from or to what is gone (kind name).
func (s *Server) dropLinks(kind, name string) {
	s.mu.Lock()
	var gone []string
	for n, l := range s.st.Links {
		if (l.FromKind == kind && l.From == name) || (l.ToKind == kind && l.To == name) {
			gone = append(gone, n)
		}
	}
	s.mu.Unlock()
	for _, n := range gone {
		s.RemoveLink(n)
	}
}

// Links lists the links, by name.
func (s *Server) Links() []Link {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Link, 0, len(s.st.Links))
	for _, l := range s.st.Links {
		out = append(out, *l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// linkUp gives a machine that just came up its links, if it takes any.
func (s *Server) linkUp(m *Machine) {
	s.relinkMachines(func(o *Machine) bool { return o.Name == m.Name })
}

// relink gives every machine its links (a daemon started again: the sockets are made anew, and
// every machine is told, in case the last daemon gave it others).
func (s *Server) relink() {
	s.mu.Lock()
	for name := range s.st.Machines {
		s.linked[name] = true
	}
	s.mu.Unlock()
	s.relinkMachines(func(*Machine) bool { return true })
}

func (s *Server) linkRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/links", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Links(), nil)
	})
	mux.HandleFunc("POST /v1/links", func(w http.ResponseWriter, r *http.Request) {
		var req Link
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.AddLink(req)
		reply(w, v, err)
	})
	mux.HandleFunc("DELETE /v1/links/{name}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"removed": r.PathValue("name")}, s.RemoveLink(r.PathValue("name")))
	})
}

// FleetInfo is a fleet the daemon knows (fleet.Registry): its file if it was added (Owned: the
// daemon wrote it, in its own directory), how many things of it the daemon has, how many steps its
// plan has, its instances, or why its file can't be planned.
type FleetInfo struct {
	Name      string   `json:"name"`
	File      string   `json:"file,omitempty"`
	Owned     bool     `json:"owned,omitempty"`
	Objects   int      `json:"objects"`
	Pending   int      `json:"pending"`
	Instances []string `json:"instances,omitempty"`
	Error     string   `json:"error,omitempty"`
}
