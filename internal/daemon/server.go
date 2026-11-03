package daemon

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/remote"
)

// Options configure a daemon.
type Options struct {
	// Dir holds its socket, state.json and the templates' logs and jobs (Dir())
	Dir string
	// VM is the snowglobe-vm that runs templates
	VM string
	// Listen, when set, also serves the API on this TCP address, to requests bearing Token
	Listen string
	Token  string
	// Logf reports what the daemon does (nil: nothing)
	Logf func(format string, a ...any)
}

// Server is a running daemon.
type Server struct {
	o         Options
	statePath string

	mu sync.Mutex
	st state
	// The listeners forwarding each machine's ports, closed when it goes
	forwards map[string][]net.Listener
}

// How long a template gets to restore, and a machine or server to go once asked
var (
	restoreTimeout = 2 * time.Minute
	stopGrace      = 5 * time.Second
	reapEvery      = 2 * time.Second
)

// New opens the daemon's directory and takes back what its last run left running: templates
// whose server is alive, machines whose control socket answers. The rest is forgotten.
func New(o Options) (*Server, error) {
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, err
	}
	s := &Server{o: o, statePath: filepath.Join(o.Dir, "state.json"), forwards: map[string][]net.Listener{}}
	s.st = loadState(s.statePath)
	for name, t := range s.st.Templates {
		if !alive(t.Pid) {
			o.Logf("template %s: its server is gone", name)
			delete(s.st.Templates, name)
			os.RemoveAll(t.SocketDir)
		}
	}
	for name, m := range s.st.Machines {
		if _, ok := s.st.Templates[m.Template]; !ok || !control.Alive(m.Socket) {
			o.Logf("machine %s: gone", name)
			delete(s.st.Machines, name)
			continue
		}
		if err := s.forward(m); err != nil {
			o.Logf("machine %s: its ports: %v", name, err)
		}
	}
	if err := saveState(s.statePath, s.st); err != nil {
		return nil, err
	}
	return s, nil
}

// Serve answers the API until ctx is done. Templates and machines outlive it: a daemon started
// again takes them back.
func (s *Server) Serve(ctx context.Context) error {
	sock := filepath.Join(s.o.Dir, "daemon.sock")
	if alreadyServing(sock) {
		return fmt.Errorf("a daemon is running already on %s", sock)
	}
	os.Remove(sock)
	unix, err := net.Listen("unix", sock)
	if err != nil {
		return fmt.Errorf("%s: %w", sock, err)
	}
	os.Chmod(sock, 0o600)
	servers := []*http.Server{{Handler: s.Handler()}}
	listeners := []net.Listener{unix}
	if s.o.Listen != "" {
		if s.o.Token == "" {
			unix.Close()
			return errors.New("--listen needs a token (--token-file): the API runs commands on machines")
		}
		tcp, err := net.Listen("tcp", s.o.Listen)
		if err != nil {
			unix.Close()
			return err
		}
		servers = append(servers, &http.Server{Handler: s.withToken(s.Handler())})
		listeners = append(listeners, tcp)
		s.o.Logf("serving the API on %s (token required)", tcp.Addr())
	}
	s.o.Logf("serving the API on %s", sock)
	go s.reap(ctx)
	errs := make(chan error, len(servers))
	for i, srv := range servers {
		go func() { errs <- srv.Serve(listeners[i]) }()
	}
	select {
	case <-ctx.Done():
	case err = <-errs:
	}
	for _, srv := range servers {
		srv.Close()
	}
	os.Remove(sock)
	s.mu.Lock()
	for _, ls := range s.forwards {
		for _, l := range ls {
			l.Close()
		}
	}
	s.mu.Unlock()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

func alreadyServing(sock string) bool {
	c, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func alive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func (s *Server) save() {
	if err := saveState(s.statePath, s.st); err != nil {
		s.o.Logf("state: %v", err)
	}
}

// --- templates

// AddTemplate is a request for a template.
type AddTemplate struct {
	// A built site: a directory, a tarball, a tarball URL or a deployed site's URL
	Site        string `json:"site"`
	Name        string `json:"name,omitempty"`
	MaxMachines int    `json:"max_machines,omitempty"`
	// A snapshot to restore instead of the site's own state (its site, unless Site says it)
	Snapshot string `json:"snapshot,omitempty"`
}

// AddTemplate restores a site once, in a fork server of its own, for machines to be forked from.
func (s *Server) AddTemplate(req AddTemplate) (*Template, error) {
	var snap *Snapshot
	if req.Snapshot != "" {
		s.mu.Lock()
		found, ok := s.st.Snapshots[req.Snapshot]
		s.mu.Unlock()
		if !ok {
			return nil, errStatus(404, "no snapshot called %s", req.Snapshot)
		}
		c := *found
		snap = &c
		if req.Site == "" {
			req.Site = snap.Site
		}
		if req.Name == "" {
			req.Name = snap.Name
		}
	}
	site, err := resolveSite(req.Site)
	if err != nil {
		return nil, errStatus(400, "%v", err)
	}
	if snap != nil && site != snap.Site {
		return nil, errStatus(400, "snapshot %s is of %s, not %s", snap.Name, snap.Site, site)
	}
	name := req.Name
	if name == "" {
		name = strings.Map(func(r rune) rune {
			if r == '-' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
				return r
			}
			return '-'
		}, filepath.Base(site))
	}
	if err := validName(name); err != nil {
		return nil, errStatus(400, "%v", err)
	}
	max := req.MaxMachines
	if max <= 0 {
		max = 256
	}
	s.mu.Lock()
	_, taken := s.st.Templates[name]
	s.mu.Unlock()
	if taken {
		return nil, errStatus(409, "a template called %s exists", name)
	}

	dir := filepath.Join(s.o.Dir, "templates", name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	sockDir, err := shortDir()
	if err != nil {
		return nil, err
	}
	t := &Template{
		Name: name, Site: site, SocketDir: sockDir, Server: filepath.Join(sockDir, "_server.sock"),
		JobsRoot: filepath.Join(dir, "jobs"), Log: filepath.Join(dir, "log"), MaxMachines: max, VM: s.o.VM, Started: time.Now(),
	}
	args := []string{"run", site, "--serve", t.Server, "--jobs-root", t.JobsRoot, "--max-machines", fmt.Sprint(max)}
	if snap != nil {
		t.Snapshot = snap.Name
		args = append(args, "--state", snap.Path)
	}
	// A pooled site keeps its blobs in the directory next to it
	if _, err := os.Stat(filepath.Join(site, "system", "filesystem")); err != nil {
		args = append(args, "--blobs", filepath.Join(filepath.Dir(site), "blobs"))
	}
	log, err := os.Create(t.Log)
	if err != nil {
		os.RemoveAll(sockDir)
		return nil, err
	}
	defer log.Close()
	cmd := exec.Command(s.o.VM, args...)
	cmd.Stdout, cmd.Stderr = log, log
	// A process group (and session) of its own: it and its machines outlive the daemon, and go
	// together when the template is removed
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		os.RemoveAll(sockDir)
		return nil, err
	}
	t.Pid = cmd.Process.Pid
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	for deadline := time.Now().Add(restoreTimeout); ; time.Sleep(50 * time.Millisecond) {
		if line := lineWith(t.Log, "serving jobs"); line != "" {
			t.Ready = line
			break
		}
		select {
		case <-exited:
			os.RemoveAll(sockDir)
			return nil, fmt.Errorf("template %s stopped while restoring: %s", name, lastLines(t.Log, 5))
		default:
		}
		if time.Now().After(deadline) {
			syscall.Kill(-t.Pid, syscall.SIGKILL)
			os.RemoveAll(sockDir)
			return nil, fmt.Errorf("template %s did not restore within %s: %s", name, restoreTimeout, lastLines(t.Log, 5))
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, taken := s.st.Templates[name]; taken {
		syscall.Kill(-t.Pid, syscall.SIGKILL)
		os.RemoveAll(sockDir)
		return nil, errStatus(409, "a template called %s exists", name)
	}
	s.st.Templates[name] = t
	s.save()
	s.o.Logf("template %s: %s", name, t.Ready)
	return t, nil
}

// RemoveTemplate removes a template's machines, then the template.
func (s *Server) RemoveTemplate(name string) error {
	s.mu.Lock()
	t, ok := s.st.Templates[name]
	var machines []string
	for n, m := range s.st.Machines {
		if m.Template == name {
			machines = append(machines, n)
		}
	}
	s.mu.Unlock()
	if !ok {
		return errStatus(404, "no template called %s", name)
	}
	for _, m := range machines {
		s.RemoveMachine(m)
	}
	// The server's process group: the server and anything of it still running
	syscall.Kill(-t.Pid, syscall.SIGTERM)
	if !gone(t.Pid, stopGrace) {
		syscall.Kill(-t.Pid, syscall.SIGKILL)
	}
	os.RemoveAll(t.SocketDir)
	os.RemoveAll(filepath.Join(s.o.Dir, "templates", name))
	s.mu.Lock()
	delete(s.st.Templates, name)
	s.save()
	s.mu.Unlock()
	s.o.Logf("template %s: removed", name)
	return nil
}

// Templates lists the templates, by name.
func (s *Server) Templates() []Template {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Template, 0, len(s.st.Templates))
	for _, t := range s.st.Templates {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// TemplateJob runs one job on a fresh fork of a template, which ends with it.
func (s *Server) TemplateJob(name string, req control.JobRequest) (*control.JobResult, error) {
	s.mu.Lock()
	t, ok := s.st.Templates[name]
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no template called %s", name)
	}
	return control.Job(t.Server, name, req)
}

func resolveSite(site string) (string, error) {
	var err error
	switch {
	case site == "":
		return "", errors.New("site: a built site's directory, tarball or URL")
	case remote.IsURL(site):
		site, err = remote.Fetch(site)
	case remote.IsTarball(site):
		site, err = remote.Unpack(site)
	default:
		site, err = filepath.Abs(site)
	}
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(site, "run.json")); err != nil {
		return "", fmt.Errorf("%s isn't a built snowglobe site (no run.json)", site)
	}
	return site, nil
}

// shortDir makes a private directory short enough for the sockets in it (a Unix socket's path
// must fit in about 100 bytes): under the temporary directory, else /tmp.
func shortDir() (string, error) {
	for _, base := range []string{os.TempDir(), "/tmp"} {
		// The longest socket in it: a 63-character machine name
		if len(filepath.Join(base, "sgt-0123456789", strings.Repeat("m", 63)+".sock")) > 103 {
			continue
		}
		if d, err := os.MkdirTemp(base, "sgt-"); err == nil {
			return d, nil
		}
	}
	return "", errors.New("no temporary directory short enough for the machines' sockets")
}

// --- machines

// Up is a request for a machine.
type Up struct {
	Template string            `json:"template"`
	Name     string            `json:"name,omitempty"`
	Ports    []string          `json:"ports,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	// A snapshot to start from instead of the template's state (of the same site)
	Snapshot string `json:"snapshot,omitempty"`
}

// Up forks a machine from a template: it lasts until it is removed, with its ports forwarded.
func (s *Server) Up(req Up) (*Machine, error) {
	name := req.Name
	if name == "" {
		name = randomName(req.Template)
	}
	if err := validName(name); err != nil {
		return nil, errStatus(400, "%v", err)
	}
	var ports []Port
	for _, spec := range req.Ports {
		p, err := ParsePort(spec)
		if err != nil {
			return nil, errStatus(400, "%v", err)
		}
		ports = append(ports, p)
	}
	s.mu.Lock()
	t, ok := s.st.Templates[req.Template]
	_, taken := s.st.Machines[name]
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no template called %s", req.Template)
	}
	if taken {
		return nil, errStatus(409, "a machine called %s exists", name)
	}
	state := ""
	if req.Snapshot != "" {
		var err error
		if state, err = s.restorable(req.Snapshot, t); err != nil {
			return nil, err
		}
		defer os.Remove(state)
	}
	spawned, err := control.Spawn(t.Server, name, state)
	if err != nil {
		return nil, errStatus(409, "%v", err)
	}
	m := &Machine{Name: name, Template: t.Name, Pid: spawned.Pid, Socket: spawned.Socket, Ports: ports, Labels: req.Labels, Snapshot: req.Snapshot, Created: time.Now()}
	if !filepath.IsAbs(m.Socket) {
		m.Socket = filepath.Join(t.SocketDir, filepath.Base(m.Socket))
	}
	if err := s.forward(m); err != nil {
		stop(m)
		return nil, errStatus(400, "%v", err)
	}
	s.mu.Lock()
	s.st.Machines[name] = m
	s.save()
	s.mu.Unlock()
	s.o.Logf("machine %s: up from %s (pid %d)", name, t.Name, m.Pid)
	return m, nil
}

// RemoveMachine stops a machine and forgets it.
func (s *Server) RemoveMachine(name string) error {
	s.mu.Lock()
	m, ok := s.st.Machines[name]
	ls := s.forwards[name]
	delete(s.forwards, name)
	s.mu.Unlock()
	if !ok {
		return errStatus(404, "no machine called %s", name)
	}
	for _, l := range ls {
		l.Close()
	}
	stop(m)
	s.mu.Lock()
	delete(s.st.Machines, name)
	s.save()
	s.mu.Unlock()
	s.o.Logf("machine %s: removed", name)
	return nil
}

// stop ends a machine: asked, then made to.
func stop(m *Machine) {
	syscall.Kill(m.Pid, syscall.SIGTERM)
	for deadline := time.Now().Add(stopGrace); time.Now().Before(deadline) && control.Alive(m.Socket); {
		time.Sleep(50 * time.Millisecond)
	}
	syscall.Kill(m.Pid, syscall.SIGKILL)
	os.Remove(m.Socket)
}

// Machines lists the machines with every label in labels, by name.
func (s *Server) Machines(labels map[string]string) []Machine {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Machine{}
	for _, m := range s.st.Machines {
		match := true
		for k, v := range labels {
			if m.Labels[k] != v {
				match = false
			}
		}
		if match {
			out = append(out, *m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Machine is the machine called name.
func (s *Server) Machine(name string) (*Machine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.st.Machines[name]
	if !ok {
		return nil, errStatus(404, "no machine called %s", name)
	}
	c := *m
	return &c, nil
}

// Job runs a job on a machine's serial shell.
func (s *Server) Job(name string, req control.JobRequest) (*control.JobResult, error) {
	m, err := s.Machine(name)
	if err != nil {
		return nil, err
	}
	return control.Job(m.Socket, name, req)
}

// forward listens on a machine's host ports (filling in those the system picks) and connects each
// connection to its guest port through the machine's control socket.
func (s *Server) forward(m *Machine) error {
	var ls []net.Listener
	for i, p := range m.Ports {
		l, err := net.Listen("tcp", net.JoinHostPort(p.IP, fmt.Sprint(p.Host)))
		if err != nil {
			for _, l := range ls {
				l.Close()
			}
			return fmt.Errorf("port %s: %w", p, err)
		}
		m.Ports[i].Host = l.Addr().(*net.TCPAddr).Port
		ls = append(ls, l)
		go func(l net.Listener, guest int) {
			for {
				c, err := l.Accept()
				if err != nil {
					return
				}
				go splice(c, m.Socket, guest)
			}
		}(l, p.Guest)
	}
	s.mu.Lock()
	s.forwards[m.Name] = ls
	s.mu.Unlock()
	return nil
}

// splice connects a host connection to a guest port, each way until it ends.
func splice(c net.Conn, sock string, guest int) {
	defer c.Close()
	g, err := control.Connect(sock, guest)
	if err != nil {
		return
	}
	defer g.Close()
	done := make(chan struct{})
	go func() {
		io.Copy(g, c)
		control.CloseWrite(g)
		close(done)
	}()
	io.Copy(c, g)
	if tc, ok := c.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
	<-done
}

// reap forgets machines that stopped and templates whose server did (with their machines).
func (s *Server) reap(ctx context.Context) {
	t := time.NewTicker(reapEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		var deadMachines, deadTemplates []string
		for _, tm := range s.Templates() {
			if !alive(tm.Pid) {
				deadTemplates = append(deadTemplates, tm.Name)
			}
		}
		for _, m := range s.Machines(nil) {
			if !control.Alive(m.Socket) {
				deadMachines = append(deadMachines, m.Name)
			}
		}
		if len(deadMachines)+len(deadTemplates) == 0 {
			continue
		}
		s.mu.Lock()
		for _, n := range deadMachines {
			if m, ok := s.st.Machines[n]; ok && !control.Alive(m.Socket) {
				for _, l := range s.forwards[n] {
					l.Close()
				}
				delete(s.forwards, n)
				delete(s.st.Machines, n)
				syscall.Kill(m.Pid, syscall.SIGKILL)
				os.Remove(m.Socket)
				s.o.Logf("machine %s: stopped", n)
			}
		}
		for _, n := range deadTemplates {
			t, ok := s.st.Templates[n]
			if !ok || alive(t.Pid) {
				continue
			}
			for mn, m := range s.st.Machines {
				if m.Template == n {
					for _, l := range s.forwards[mn] {
						l.Close()
					}
					delete(s.forwards, mn)
					delete(s.st.Machines, mn)
					syscall.Kill(m.Pid, syscall.SIGKILL)
				}
			}
			syscall.Kill(-t.Pid, syscall.SIGKILL)
			os.RemoveAll(t.SocketDir)
			delete(s.st.Templates, n)
			s.o.Logf("template %s: its server stopped", n)
		}
		s.save()
		s.mu.Unlock()
	}
}

// --- snapshots

// Snapshot saves a running machine whole as name: the machine writes it under its template's
// jobs root (all its sandbox lets it write), and the daemon keeps it with its own.
func (s *Server) Snapshot(machine, name string) (*Snapshot, error) {
	m, err := s.Machine(machine)
	if err != nil {
		return nil, err
	}
	if name == "" {
		name = randomName(machine)
	}
	if err := validName(name); err != nil {
		return nil, errStatus(400, "%v", err)
	}
	s.mu.Lock()
	t, ok := s.st.Templates[m.Template]
	_, taken := s.st.Snapshots[name]
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "%s: its template %s is gone", machine, m.Template)
	}
	if taken {
		return nil, errStatus(409, "a snapshot called %s exists", name)
	}
	staging := filepath.Join(t.JobsRoot, ".snapshots")
	kept := filepath.Join(s.o.Dir, "snapshots")
	for _, d := range []string{staging, kept} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	written := filepath.Join(staging, name+".zst")
	saved, err := control.Save(m.Socket, written)
	if err != nil {
		os.Remove(written)
		return nil, err
	}
	snap := &Snapshot{Name: name, Site: t.Site, Template: t.Name, Machine: machine, Path: filepath.Join(kept, name+".zst"),
		Bytes: saved.Bytes, Ms: saved.Ms, Created: time.Now()}
	if err := os.Rename(written, snap.Path); err != nil {
		os.Remove(written)
		return nil, err
	}
	s.mu.Lock()
	s.st.Snapshots[name] = snap
	s.save()
	s.mu.Unlock()
	s.o.Logf("snapshot %s: of %s, %d bytes in %d ms", name, machine, saved.Bytes, saved.Ms)
	return snap, nil
}

// Snapshots lists the snapshots, by name.
func (s *Server) Snapshots() []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Snapshot, 0, len(s.st.Snapshots))
	for _, sn := range s.st.Snapshots {
		out = append(out, *sn)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// RemoveSnapshot deletes a snapshot.
func (s *Server) RemoveSnapshot(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sn, ok := s.st.Snapshots[name]
	if !ok {
		return errStatus(404, "no snapshot called %s", name)
	}
	os.Remove(sn.Path)
	delete(s.st.Snapshots, name)
	s.save()
	return nil
}

// restorable puts snapshot name where template t's machines may read it (its jobs root: their
// sandbox reads nothing else of the daemon's), as a link, and returns that path for the spawn.
func (s *Server) restorable(name string, t *Template) (string, error) {
	s.mu.Lock()
	sn, ok := s.st.Snapshots[name]
	s.mu.Unlock()
	if !ok {
		return "", errStatus(404, "no snapshot called %s", name)
	}
	if sn.Site != t.Site {
		return "", errStatus(400, "snapshot %s is of %s, and template %s of %s", name, sn.Site, t.Name, t.Site)
	}
	dir := filepath.Join(t.JobsRoot, ".restore")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	link := filepath.Join(dir, randomName(name)+".zst")
	if err := os.Link(sn.Path, link); err != nil {
		return "", err
	}
	return link, nil
}

// --- HTTP

// Handler is the API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"ok": true}, nil)
	})
	mux.HandleFunc("GET /v1/templates", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Templates(), nil)
	})
	mux.HandleFunc("POST /v1/templates", func(w http.ResponseWriter, r *http.Request) {
		var req AddTemplate
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.AddTemplate(req)
		reply(w, v, err)
	})
	mux.HandleFunc("DELETE /v1/templates/{name}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"removed": r.PathValue("name")}, s.RemoveTemplate(r.PathValue("name")))
	})
	mux.HandleFunc("POST /v1/templates/{name}/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req control.JobRequest
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.TemplateJob(r.PathValue("name"), req)
		reply(w, v, err)
	})
	mux.HandleFunc("GET /v1/machines", func(w http.ResponseWriter, r *http.Request) {
		labels := map[string]string{}
		for _, l := range r.URL.Query()["label"] {
			k, v, _ := strings.Cut(l, "=")
			labels[k] = v
		}
		reply(w, s.Machines(labels), nil)
	})
	mux.HandleFunc("POST /v1/machines", func(w http.ResponseWriter, r *http.Request) {
		var req Up
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.Up(req)
		reply(w, v, err)
	})
	mux.HandleFunc("GET /v1/machines/{name}", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.Machine(r.PathValue("name"))
		reply(w, v, err)
	})
	mux.HandleFunc("DELETE /v1/machines/{name}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"removed": r.PathValue("name")}, s.RemoveMachine(r.PathValue("name")))
	})
	mux.HandleFunc("POST /v1/machines/{name}/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req control.JobRequest
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.Job(r.PathValue("name"), req)
		reply(w, v, err)
	})
	mux.HandleFunc("POST /v1/machines/{name}/snapshots", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.Snapshot(r.PathValue("name"), req.Name)
		reply(w, v, err)
	})
	mux.HandleFunc("GET /v1/snapshots", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Snapshots(), nil)
	})
	mux.HandleFunc("DELETE /v1/snapshots/{name}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"removed": r.PathValue("name")}, s.RemoveSnapshot(r.PathValue("name")))
	})
	return mux
}

// maxBody bounds a request: a job's files ride in it
const maxBody = 256 << 20

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(v); err != nil {
		return errStatus(400, "request: %v", err)
	}
	return nil
}

func reply(w http.ResponseWriter, v any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(statusOf(err))
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(v)
}

// withToken lets through only requests that bear the token.
func (s *Server) withToken(h http.Handler) http.Handler {
	want := []byte("Bearer " + s.o.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			reply(w, nil, errStatus(401, "a token is needed (Authorization: Bearer ...)"))
			return
		}
		h.ServeHTTP(w, r)
	})
}

// --- small helpers

func gone(pid int, d time.Duration) bool {
	for deadline := time.Now().Add(d); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if !alive(pid) {
			return true
		}
	}
	return !alive(pid)
}

func lineWith(path, s string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.Contains(sc.Text(), s) {
			return sc.Text()
		}
	}
	return ""
}

func lastLines(path string, n int) string {
	data, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
