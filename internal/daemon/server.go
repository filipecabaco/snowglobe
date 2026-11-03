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
	// Memory, when set, is the most the template servers and machines may take together (bytes):
	// a machine that doesn't fit waits up to Wait (30 s) for room, then is refused
	Memory int64
	Wait   time.Duration
	// What a process costs the host (nil: processMemory); for tests
	memOf func(pid int) int64
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
	// Services' ports and replicas' activity
	svc *services
	// How often stopped machines and idle replicas are looked for (taken from reapEvery and
	// scaleEvery when it starts)
	reapEvery, scaleEvery time.Duration
	// Limits and lifecycle: admissions, templates waking and sleeping
	life *lifecycleState
	// What a process costs the host (processMemory; tests replace it)
	memOf func(pid int) int64
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
	s := &Server{o: o, statePath: filepath.Join(o.Dir, "state.json"), forwards: map[string][]net.Listener{}, svc: newServices(), reapEvery: reapEvery, scaleEvery: scaleEvery,
		life: newLifecycle(), memOf: processMemory}
	if o.memOf != nil {
		s.memOf = o.memOf
	}
	if s.o.Wait <= 0 {
		s.o.Wait = 30 * time.Second
	}
	s.st = loadState(s.statePath)
	for name, t := range s.st.Templates {
		// Asleep: it starts on its next use
		if !t.Asleep && !alive(t.Pid) {
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
	// Services: their ports held again (their replicas were taken back with the machines)
	for name, svc := range s.st.Services {
		if _, ok := s.st.Templates[svc.Template]; !ok {
			o.Logf("service %s: its template %s is gone", name, svc.Template)
			delete(s.st.Services, name)
			continue
		}
		if err := s.listenService(svc); err != nil {
			o.Logf("service %s: %v", name, err)
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
	go s.scaler(ctx)
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
	s.svc.mu.Lock()
	for _, ls := range s.svc.listeners {
		for _, l := range ls {
			l.Close()
		}
	}
	s.svc.mu.Unlock()
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
	// How long it may serve no machine before its server stops (0: never); the next use starts it
	// again
	Idle Duration `json:"idle,omitempty"`
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
	if req.Idle != 0 && req.Idle < Duration(time.Second) {
		return nil, errStatus(400, "idle %s: 0 (never), or a second or more", time.Duration(req.Idle))
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
	t := &Template{
		Name: name, Site: site, JobsRoot: filepath.Join(dir, "jobs"), Log: filepath.Join(dir, "log"),
		MaxMachines: max, VM: s.o.VM, Idle: req.Idle, Started: time.Now(),
	}
	if snap != nil {
		t.Snapshot = snap.Name
	}
	if err := s.startServer(t); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, taken := s.st.Templates[name]; taken {
		syscall.Kill(-t.Pid, syscall.SIGKILL)
		os.RemoveAll(t.SocketDir)
		return nil, errStatus(409, "a template called %s exists", name)
	}
	s.st.Templates[name] = t
	s.save()
	s.o.Logf("template %s: %s", name, t.Ready)
	return t, nil
}

// startServer starts a template's fork server and waits for it to have restored: its socket in a
// new short directory, its log appended to.
func (s *Server) startServer(t *Template) error {
	sockDir, err := shortDir()
	if err != nil {
		return err
	}
	t.SocketDir, t.Server = sockDir, filepath.Join(sockDir, "_server.sock")
	args := []string{"run", t.Site, "--serve", t.Server, "--jobs-root", t.JobsRoot, "--max-machines", fmt.Sprint(t.MaxMachines)}
	if t.Snapshot != "" {
		s.mu.Lock()
		snap, ok := s.st.Snapshots[t.Snapshot]
		s.mu.Unlock()
		if !ok {
			os.RemoveAll(sockDir)
			return errStatus(409, "template %s: its snapshot %s is gone", t.Name, t.Snapshot)
		}
		args = append(args, "--state", snap.Path)
	}
	// A pooled site keeps its blobs in the directory next to it
	if _, err := os.Stat(filepath.Join(t.Site, "system", "filesystem")); err != nil {
		args = append(args, "--blobs", filepath.Join(filepath.Dir(t.Site), "blobs"))
	}
	log, err := os.OpenFile(t.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		os.RemoveAll(sockDir)
		return err
	}
	defer log.Close()
	// Where this start's lines begin: the restore line is looked for after it
	from, _ := log.Seek(0, io.SeekEnd)
	cmd := exec.Command(s.o.VM, args...)
	cmd.Stdout, cmd.Stderr = log, log
	// A process group (and session) of its own: it and its machines outlive the daemon, and go
	// together when the template is removed
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		os.RemoveAll(sockDir)
		return err
	}
	t.Pid = cmd.Process.Pid
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	for deadline := time.Now().Add(restoreTimeout); ; time.Sleep(50 * time.Millisecond) {
		if line := lineWithFrom(t.Log, from, "serving jobs"); line != "" {
			t.Ready = line
			return nil
		}
		select {
		case <-exited:
			os.RemoveAll(sockDir)
			return fmt.Errorf("template %s stopped while restoring: %s", t.Name, lastLines(t.Log, 5))
		default:
		}
		if time.Now().After(deadline) {
			syscall.Kill(-t.Pid, syscall.SIGKILL)
			os.RemoveAll(sockDir)
			return fmt.Errorf("template %s did not restore within %s: %s", t.Name, restoreTimeout, lastLines(t.Log, 5))
		}
	}
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
	s.mu.Lock()
	for _, svc := range s.st.Services {
		if svc.Template == name {
			s.mu.Unlock()
			return errStatus(409, "service %s runs on template %s: remove it first", svc.Name, name)
		}
	}
	s.mu.Unlock()
	for _, m := range machines {
		s.RemoveMachine(m)
	}
	// The server's process group: the server and anything of it still running
	if !t.Asleep {
		syscall.Kill(-t.Pid, syscall.SIGTERM)
		if !gone(t.Pid, stopGrace) {
			syscall.Kill(-t.Pid, syscall.SIGKILL)
		}
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
	t, err := s.awake(name)
	if err != nil {
		return nil, err
	}
	defer s.used(name)
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
	// How long it lives, whatever it does (0: until it is removed)
	TTL Duration `json:"ttl,omitempty"`
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
	if req.TTL < 0 {
		return nil, errStatus(400, "ttl: 0 or more")
	}
	s.mu.Lock()
	_, ok := s.st.Templates[req.Template]
	_, taken := s.st.Machines[name]
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no template called %s", req.Template)
	}
	if taken {
		return nil, errStatus(409, "a machine called %s exists", name)
	}
	// Asleep: started again first
	t, err := s.awake(req.Template)
	if err != nil {
		return nil, err
	}
	defer s.used(t.Name)
	if len(ports) > 0 {
		if err := needsNetwork(t); err != nil {
			return nil, err
		}
	}
	state := ""
	if req.Snapshot != "" {
		var err error
		if state, err = s.restorable(req.Snapshot, t); err != nil {
			return nil, err
		}
		defer os.Remove(state)
	}
	// Room in the memory budget, held until it is up
	release, err := s.admit(t.Name)
	if err != nil {
		return nil, err
	}
	defer release()
	spawned, err := control.Spawn(t.Server, name, state)
	if err != nil {
		return nil, errStatus(409, "%v", err)
	}
	m := &Machine{Name: name, Template: t.Name, Pid: spawned.Pid, Socket: spawned.Socket, Ports: ports, Labels: req.Labels, Snapshot: req.Snapshot, Created: time.Now()}
	if req.TTL > 0 {
		expires := m.Created.Add(time.Duration(req.TTL))
		m.Expires = &expires
	}
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
	s.used(m.Template)
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
	// A service's replica is busy while the job runs
	if m.Labels[serviceLabel] != "" {
		s.touch(name, 1)
		defer s.touch(name, -1)
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
	t := time.NewTicker(s.reapEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		var deadMachines, deadTemplates []string
		for _, tm := range s.Templates() {
			if !tm.Asleep && !alive(tm.Pid) {
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
			if !ok || t.Asleep || alive(t.Pid) {
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
	for _, t := range s.st.Templates {
		if t.Snapshot == name {
			return errStatus(409, "template %s is made of snapshot %s: remove it first", t.Name, name)
		}
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
	mux.HandleFunc("GET /v1/services", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Services(), nil)
	})
	mux.HandleFunc("POST /v1/services", func(w http.ResponseWriter, r *http.Request) {
		var req Service
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.AddService(req)
		reply(w, v, err)
	})
	mux.HandleFunc("GET /v1/services/{name}", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.ServiceStatus(r.PathValue("name"))
		reply(w, v, err)
	})
	mux.HandleFunc("DELETE /v1/services/{name}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"removed": r.PathValue("name")}, s.RemoveService(r.PathValue("name")))
	})
	mux.HandleFunc("POST /v1/services/{name}/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req control.JobRequest
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.ServiceJob(r.PathValue("name"), req)
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

func lineWith(path, s string) string { return lineWithFrom(path, 0, s) }

func lineWithFrom(path string, from int64, s string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	f.Seek(from, io.SeekStart)
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

// needsNetwork refuses ports on a template whose site was built without a network: its guest has
// no network device, so there is nothing a forwarded connection could reach (as `run -p` says).
func needsNetwork(t *Template) error {
	var run struct {
		Network string `json:"network"`
	}
	data, err := os.ReadFile(filepath.Join(t.Site, "run.json"))
	if err != nil {
		return err
	}
	if json.Unmarshal(data, &run) != nil || run.Network != "fetch" {
		return errStatus(400, "ports need a guest with a network: template %s's site was built without one (build it with --network fetch)", t.Name)
	}
	return nil
}
