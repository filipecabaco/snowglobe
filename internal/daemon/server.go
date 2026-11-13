package daemon

import (
	"bufio"
	"context"
	"crypto/subtle"
	cryptotls "crypto/tls"
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
	"github.com/filipecabaco/snowglobe/internal/lifeline"
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
	// Snowglobe is the snowglobe command builds run (empty: this program)
	Snowglobe string
	// Routes, when set, adds routes of its own to the API (the fleet's, which this package can't
	// import)
	Routes func(*http.ServeMux)
	// Whether Docker can build here (nil: ask it); for tests
	dockerThere func() bool
	// What requests from another host may do
	Remote Policy
	// TLSCert and TLSKey, when set, serve the TCP API over TLS
	TLSCert, TLSKey string
	// Insecure lets the TCP API be plain HTTP on an address other hosts reach: the token and
	// everything else then cross the network in the clear
	Insecure bool
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
	// What happened, for /v1/events
	ev *events
	// Samples and counts, for /v1/metrics and /metrics; how often it samples (metricsEvery)
	meter        *meter
	metricsEvery time.Duration
	// Builds of sites, for /v1/builds
	builds *builds
	// Fire-and-forget runs, for /v1/runs
	runs *runs
	// Each machine's link sockets, by link, and whether it was given links (guarded by mu)
	linkSocks map[string]map[string]*linkSock
	linked    map[string]bool
	// Machine names being started: taken until they are up, or not (guarded by mu)
	starting map[string]bool
	// The process groups of the template servers it started and that still run (each with its
	// machines and jobs), and whether it is stopping: then it starts nothing more (guarded by mu)
	groups  map[int]bool
	closing bool
	// Templates that were running when the last daemon stopped, started again once it serves
	revive []string
	// Stops Serve (the API's shutdown), and is closed once everything it started has stopped
	quit    context.CancelFunc
	stopped chan struct{}
}

// How long a template gets to restore, and a machine or server to go once asked
var (
	restoreTimeout = 2 * time.Minute
	stopGrace      = 5 * time.Second
	reapEvery      = 2 * time.Second
)

// New opens the daemon's directory. Nothing its last run started still runs: a daemon's servers
// and machines end with it, stopped as it stops, or by their lifeline if it dies. Templates that
// were running are started again from their sites once it serves (those asleep stay asleep);
// services hold their ports again and start their replicas as they would (Min of them at once);
// machines, replicas included, are forgotten. A server that a daemon from before lifelines left
// running is stopped, with its machines, so that nothing runs that this one doesn't know of.
func New(o Options) (*Server, error) {
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, err
	}
	s := &Server{o: o, statePath: filepath.Join(o.Dir, "state.json"), forwards: map[string][]net.Listener{}, svc: newServices(), reapEvery: reapEvery, scaleEvery: scaleEvery,
		life: newLifecycle(), memOf: processMemory, ev: newEvents(), meter: newMeter(), metricsEvery: metricsEvery, runs: newRuns(),
		linkSocks: map[string]map[string]*linkSock{}, linked: map[string]bool{}, starting: map[string]bool{}, groups: map[int]bool{}, stopped: make(chan struct{})}
	if o.memOf != nil {
		s.memOf = o.memOf
	}
	if err := os.MkdirAll(filepath.Join(o.Dir, "builds"), 0o700); err != nil {
		return nil, err
	}
	s.builds = newBuilds(filepath.Join(o.Dir, "builds"))
	if s.o.Wait <= 0 {
		s.o.Wait = 30 * time.Second
	}
	s.st = loadState(s.statePath)
	for name, m := range s.st.Machines {
		// Left running by a daemon from before lifelines: stopped
		if m.Pid > 0 && alive(m.Pid) && control.Alive(m.Socket) {
			o.Logf("machine %s: stopping what an earlier daemon left running (pid %d)", name, m.Pid)
			syscall.Kill(m.Pid, syscall.SIGKILL)
		}
		os.Remove(m.Socket)
		delete(s.st.Machines, name)
	}
	for name, t := range s.st.Templates {
		// Asleep: it starts on its next use
		if t.Asleep {
			continue
		}
		if t.Pid > 0 && alive(t.Pid) && control.Alive(t.Server) {
			o.Logf("template %s: stopping the server an earlier daemon left running (pid %d)", name, t.Pid)
			// Not our child: only while it still answers on its socket is it the server left
			stopGroups([]int{t.Pid}, nil, func(int) bool { return control.Alive(t.Server) })
		}
		if t.SocketDir != "" {
			os.RemoveAll(t.SocketDir)
		}
		if _, err := os.Stat(filepath.Join(t.Site, "run.json")); err != nil {
			o.Logf("template %s: its site %s is gone", name, t.Site)
			delete(s.st.Templates, name)
			continue
		}
		// Asleep until Serve starts it again (or its first use does, whichever comes first)
		t.Pid, t.Server, t.SocketDir, t.Ready, t.Asleep = 0, "", "", "", true
		s.revive = append(s.revive, name)
	}
	sort.Strings(s.revive)
	// Services: their ports held again; their replicas start as they would
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
	// Links: what they are from or to must still be there
	for name, l := range s.st.Links {
		if !s.has(l.FromKind, l.From) || !s.has(l.ToKind, l.To) {
			o.Logf("link %s: what it joined is gone", name)
			delete(s.st.Links, name)
		}
	}
	if err := saveState(s.statePath, s.st); err != nil {
		return nil, err
	}
	s.relink()
	return s, nil
}

// has says whether the daemon has kind name. Called with s.mu held, or before serving.
func (s *Server) has(kind, name string) bool {
	switch kind {
	case KindMachine:
		_, ok := s.st.Machines[name]
		return ok
	case KindTemplate:
		_, ok := s.st.Templates[name]
		return ok
	case KindService:
		_, ok := s.st.Services[name]
		return ok
	}
	return false
}

// Serve answers the API until ctx is done (or the API is asked to stop), then stops everything
// the daemon started (stopAll) before it returns.
func (s *Server) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	s.quit = cancel
	s.mu.Unlock()
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
	// No write timeout: events, attach and build logs stream for as long as they are watched
	servers := []*http.Server{{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}}
	listeners := []net.Listener{unix}
	if s.o.Listen != "" {
		if s.o.Token == "" {
			unix.Close()
			return errors.New("--listen needs a token (--token-file): the API runs commands on machines")
		}
		tls := s.o.TLSCert != "" || s.o.TLSKey != ""
		if tls && (s.o.TLSCert == "" || s.o.TLSKey == "") {
			unix.Close()
			return errors.New("--tls-cert and --tls-key go together")
		}
		if !tls && !s.o.Insecure && !loopback(s.o.Listen) {
			unix.Close()
			return fmt.Errorf("--listen %s reaches other hosts: serve it over TLS (--tls-cert and --tls-key), or say --insecure-listen to send the token in the clear", s.o.Listen)
		}
		tcp, err := net.Listen("tcp", s.o.Listen)
		if err != nil {
			unix.Close()
			return err
		}
		if tls {
			cert, err := cryptotls.LoadX509KeyPair(s.o.TLSCert, s.o.TLSKey)
			if err != nil {
				unix.Close()
				tcp.Close()
				return fmt.Errorf("--tls-cert, --tls-key: %w", err)
			}
			tcp = cryptotls.NewListener(tcp, &cryptotls.Config{Certificates: []cryptotls.Certificate{cert}, MinVersion: cryptotls.VersionTLS12})
		}
		servers = append(servers, &http.Server{Handler: s.withToken(s.Handler()), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute,
			// (A request's body: a job's files, an upload, read as it comes; a slow sender is cut
			// off rather than held forever)
			ReadTimeout: 30 * time.Minute})
		listeners = append(listeners, tcp)
		scheme := "http"
		if tls {
			scheme = "https"
		}
		s.o.Logf("serving the API on %s://%s (token required; requests from it held to the remote policy)", scheme, tcp.Addr())
	}
	s.o.Logf("serving the API on %s", sock)
	go s.reap(ctx)
	go s.scaler(ctx)
	go s.sampler(ctx)
	go s.reviveTemplates()
	errs := make(chan error, len(servers))
	for i, srv := range servers {
		go func() { errs <- srv.Serve(listeners[i]) }()
	}
	select {
	case <-ctx.Done():
	case err = <-errs:
	}
	// No new connection; those open (a request to stop, waiting for it) are answered
	for _, l := range listeners {
		l.Close()
	}
	os.Remove(sock)
	s.mu.Lock()
	for _, ls := range s.forwards {
		for _, l := range ls {
			l.Close()
		}
	}
	for _, mine := range s.linkSocks {
		for _, ls := range mine {
			ls.ln.Close()
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
	s.stopAll()
	close(s.stopped)
	answered, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	for _, srv := range servers {
		srv.Shutdown(answered)
		srv.Close()
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// reviveTemplates starts again the templates that were running when the last daemon stopped.
func (s *Server) reviveTemplates() {
	for _, name := range s.revive {
		_, done, err := s.awake(name)
		if err != nil {
			s.note("template.error", "template "+name, "starting it again: %v", err)
			continue
		}
		done()
	}
}

// stopAll stops everything the daemon started, as it stops: the replicas of services that keep
// their state are saved first (as when they scale to zero); builds are interrupted; then every
// template server's process group (the server, its machines and its jobs) and every build's gets
// a SIGTERM, up to stopGrace to go, then a SIGKILL. Their sockets go, and state.json says that
// nothing runs: templates, services, snapshots and links stay, for the next daemon to start again.
func (s *Server) stopAll() {
	s.mu.Lock()
	s.closing = true
	var keep []Service
	for _, svc := range s.st.Services {
		if svc.State == "keep" {
			keep = append(keep, *svc)
		}
	}
	s.mu.Unlock()
	for _, svc := range keep {
		for _, m := range s.replicas(svc.Name) {
			s.stopReplica(svc, m, true)
		}
	}

	s.builds.mu.Lock()
	var builds []int
	for id, b := range s.builds.all {
		if b.finished() {
			continue
		}
		now := time.Now()
		b.Status, b.Error, b.Ended = "interrupted", "the daemon stopped while it ran", &now
		s.builds.write(b)
		if p := s.builds.procs[id]; p != nil {
			builds = append(builds, p.Pid)
		}
	}
	s.builds.mu.Unlock()

	s.mu.Lock()
	var groups, machines []int
	for g := range s.groups {
		groups = append(groups, g)
	}
	for _, m := range s.st.Machines {
		machines = append(machines, m.Pid)
	}
	s.mu.Unlock()
	if n := len(groups) + len(builds); n > 0 {
		s.o.Logf("stopping %d template servers (%d machines) and %d builds", len(groups), len(machines), len(builds))
	}
	stopGroups(append(groups, builds...), machines, s.unreaped)
	// Reaped: each server by the goroutine that waits for it, each build by its own
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		s.mu.Lock()
		left := len(s.groups)
		s.mu.Unlock()
		if left == 0 {
			break
		}
	}

	s.mu.Lock()
	for _, t := range s.st.Templates {
		if t.SocketDir != "" {
			os.RemoveAll(t.SocketDir)
		}
		t.Pid, t.Server, t.SocketDir, t.Ready = 0, "", "", ""
	}
	for name, m := range s.st.Machines {
		os.Remove(m.Socket)
		delete(s.st.Machines, name)
	}
	s.save()
	s.mu.Unlock()
	s.note("daemon.stopped", "daemon", "stopped, and everything it started with it")
}

// unreaped says whether pid is a process this daemon started (a template server or a build) and
// has not yet waited for. Until it has, even a process that has exited is a zombie that keeps its
// pid, and so its process group's id, reserved: signalling it can reach nothing else.
func (s *Server) unreaped(pid int) bool {
	s.mu.Lock()
	ok := s.groups[pid]
	s.mu.Unlock()
	if ok {
		return true
	}
	s.builds.mu.Lock()
	defer s.builds.mu.Unlock()
	for _, p := range s.builds.procs {
		if p.Pid == pid {
			return true
		}
	}
	return false
}

// ForceStop is a second interrupt while the daemon stops: a SIGKILL, now, to every template server
// group and build still running (and the machines in state.json that still are). Safe because
// of the lifelines: whatever it doesn't reach ends with the daemon.
func (s *Server) ForceStop() {
	s.mu.Lock()
	var groups, machines []int
	for g := range s.groups {
		groups = append(groups, g)
	}
	for _, m := range s.st.Machines {
		machines = append(machines, m.Pid)
	}
	s.mu.Unlock()
	s.builds.mu.Lock()
	for _, p := range s.builds.procs {
		groups = append(groups, p.Pid)
	}
	s.builds.mu.Unlock()
	killNow(groups, machines, s.unreaped)
}

// stopGroups ends process groups and processes: a SIGTERM each, up to stopGrace for all of them
// to go, then a SIGKILL to what is left. A process group is signalled only while ours says its
// leader is still verifiably what was started (not reaped, so its id can't have been reused by
// anything else); a pid (a machine's, from state.json) only while it is still alive.
func stopGroups(groups, pids []int, ours func(pid int) bool) {
	for _, g := range groups {
		if ours(g) {
			killGroup(g, syscall.SIGTERM)
		}
	}
	for _, p := range pids {
		if alive(p) {
			syscall.Kill(p, syscall.SIGTERM)
		}
	}
	left := func() bool {
		for _, g := range groups {
			if ours(g) && syscall.Kill(-g, 0) == nil {
				return true
			}
		}
		for _, p := range pids {
			if alive(p) {
				return true
			}
		}
		return false
	}
	for deadline := time.Now().Add(stopGrace); time.Now().Before(deadline) && left(); {
		time.Sleep(50 * time.Millisecond)
	}
	killNow(groups, pids, ours)
}

// killNow is stopGroups' last step, and ForceStop's: a SIGKILL to what is still ours.
func killNow(groups, pids []int, ours func(pid int) bool) {
	for _, g := range groups {
		if ours(g) {
			killGroup(g, syscall.SIGKILL)
		}
	}
	for _, p := range pids {
		if alive(p) {
			syscall.Kill(p, syscall.SIGKILL)
		}
	}
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
	Idle   Duration          `json:"idle,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	// A snapshot to restore instead of the site's own state (its site, unless Site says it)
	Snapshot string `json:"snapshot,omitempty"`
	// Its machines may reach the host's loopback and private addresses (--allow-private): another
	// template's service through a tcp:// tunnel, say
	AllowPrivate bool `json:"allow_private,omitempty"`
	// Where its machines' connections may go: "none" (only links and forwarded ports), "internet"
	// (public addresses), "private" (also the host's loopback and private ones); empty: as the
	// site was built (internet when it has a network), or private with AllowPrivate
	Egress string `json:"egress,omitempty"`
	// From another host (IsRemote): held to the daemon's Policy
	remote bool
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
	if req.remote && !s.o.Remote.Private && (req.AllowPrivate || req.Egress == "private") {
		return nil, errStatus(403, "a request from another host can't let machines reach this host's loopback and private addresses (the daemon allows it with --remote-allow-private)")
	}
	var site string
	var err error
	switch {
	case snap != nil && req.Site == snap.Site:
		// The snapshot's own site, the daemon's to name
		site = snap.Site
	case req.remote && !remote.IsURL(req.Site):
		if err := s.o.Remote.Path(req.Site, s.uploads()); err != nil {
			return nil, err
		}
		site, err = resolveSite(req.Site, false)
	default:
		site, err = resolveSite(req.Site, req.remote && !s.o.Remote.Private)
	}
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
	switch req.Egress {
	case "", "none", "internet", "private":
	default:
		return nil, errStatus(400, "egress %q: none, internet or private", req.Egress)
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
		MaxMachines: max, VM: s.o.VM, Idle: req.Idle, Labels: req.Labels, Started: time.Now(),
		AllowPrivate: req.AllowPrivate, Egress: req.Egress,
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
		killGroup(t.Pid, syscall.SIGKILL)
		os.RemoveAll(t.SocketDir)
		return nil, errStatus(409, "a template called %s exists", name)
	}
	s.st.Templates[name] = t
	s.save()
	s.note("template.added", "template "+name, "%s", t.Ready)
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
	if t.AllowPrivate {
		args = append(args, "--allow-private")
	}
	if t.Egress != "" {
		args = append(args, "--egress", t.Egress)
	}
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
	// A process group (and session) of its own, with its machines: they go together when the
	// template is removed or the daemon stops, and a ctrl-c meant for the daemon doesn't reach
	// them before it has stopped them in order
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// And they end with the daemon, however it ends: a crash closes their lifeline
	if err := lifeline.Pass(cmd); err != nil {
		os.RemoveAll(sockDir)
		return err
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		os.RemoveAll(sockDir)
		return errStatus(503, "the daemon is stopping")
	}
	err = cmd.Start()
	if err == nil {
		s.groups[cmd.Process.Pid] = true
	}
	s.mu.Unlock()
	if err != nil {
		os.RemoveAll(sockDir)
		return err
	}
	t.Pid = cmd.Process.Pid
	exited := make(chan struct{})
	go func() {
		cmd.Wait()
		s.mu.Lock()
		delete(s.groups, t.Pid)
		s.mu.Unlock()
		close(exited)
	}()
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
			killGroup(t.Pid, syscall.SIGKILL)
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
	// (No pid: a server that never started, or is starting again. kill(-0) would be this
	// daemon's own process group)
	if !t.Asleep && t.Pid > 0 {
		killGroup(t.Pid, syscall.SIGTERM)
		if !gone(t.Pid, stopGrace) {
			killGroup(t.Pid, syscall.SIGKILL)
		}
	}
	os.RemoveAll(t.SocketDir)
	os.RemoveAll(filepath.Join(s.o.Dir, "templates", name))
	s.mu.Lock()
	delete(s.st.Templates, name)
	s.sweepUploads()
	s.save()
	s.mu.Unlock()
	s.note("template.removed", "template "+name, "removed")
	s.dropLinks(KindTemplate, name)
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

// TemplateJob runs one job on a fresh fork of a template, which ends with it. The fork is a
// machine as far as the memory budget goes, and keeps its template awake while it runs.
func (s *Server) TemplateJob(ctx context.Context, name string, req control.JobRequest) (*control.JobResult, error) {
	t, done, err := s.awake(name)
	if err != nil {
		return nil, err
	}
	defer done()
	admitted, err := s.admitJob(name)
	if err != nil {
		return nil, err
	}
	defer admitted()
	return s.runJob(ctx, t.Server, name, req)
}

func resolveSite(site string, public bool) (string, error) {
	var err error
	switch {
	case site == "":
		return "", errors.New("site: a built site's directory, tarball or URL")
	case remote.IsURL(site) && public:
		site, err = remote.FetchPublic(site)
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
	// Refused at once when it doesn't fit the memory budget, rather than waiting for room (the
	// scaler's starts: it tries again on its next round)
	noWait bool
}

// Up forks a machine from a template: it lasts until it is removed, with its ports forwarded.
func (s *Server) Up(req Up) (*Machine, error) {
	begun := time.Now()
	m, err := s.up(req)
	if err == nil {
		s.meter.up(time.Since(begun))
	}
	return m, err
}

// maxJobOutput is how much of a job's output, and of its out/ files, the daemon keeps: the rest
// is dropped as it is read, and the output says how much went
var maxJobOutput int64 = 16 << 20

// runJob runs a job on the control socket sock, counted in the metrics, until it ends or ctx is
// done (its caller gone).
func (s *Server) runJob(ctx context.Context, sock, name string, req control.JobRequest) (*control.JobResult, error) {
	begun := time.Now()
	r, err := control.JobLimited(ctx, sock, name, req, maxJobOutput)
	s.meter.job(time.Since(begun), err)
	if err != nil {
		return nil, err
	}
	if r.OutputCut > 0 || r.OutCut > 0 {
		s.note("job.cut", "machine "+name, "kept the first %s of its output and of out/: %d and %d bytes more were dropped", mb(maxJobOutput), r.OutputCut, r.OutCut)
	}
	if r.OutputCut > 0 {
		r.Output = fmt.Appendf(r.Output, "\n[snowglobe: %d more bytes of output were cut; the daemon keeps the first %s]\n", r.OutputCut, mb(maxJobOutput))
	}
	return r, nil
}

func (s *Server) up(req Up) (*Machine, error) {
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
	// Another up of the same name, still starting
	taken = taken || s.starting[name]
	if ok && !taken {
		s.starting[name] = true
	}
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no template called %s", req.Template)
	}
	if taken {
		return nil, errStatus(409, "a machine called %s exists", name)
	}
	defer func() {
		s.mu.Lock()
		delete(s.starting, name)
		s.mu.Unlock()
	}()
	// Asleep: started again first
	t, done, err := s.awake(req.Template)
	if err != nil {
		return nil, err
	}
	defer done()
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
		defer os.Remove(state + userState)
	}
	// Room in the memory budget, held until it is up
	wait := s.o.Wait
	if req.noWait {
		wait = 0
	}
	release, err := s.admit(t.Name, wait)
	if err != nil {
		return nil, err
	}
	defer release()
	s.mu.Lock()
	closing := s.closing
	s.mu.Unlock()
	if closing {
		return nil, errStatus(503, "the daemon is stopping")
	}
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
	s.note("machine.up", "machine "+name, "up from %s (pid %d)", t.Name, m.Pid)
	s.linkUp(m)
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
	s.note("machine.removed", "machine "+name, "removed")
	s.unlinkMachine(name)
	s.dropLinks(KindMachine, name)
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
func (s *Server) Job(ctx context.Context, name string, req control.JobRequest) (*control.JobResult, error) {
	m, err := s.Machine(name)
	if err != nil {
		return nil, err
	}
	// A service's replica is busy while the job runs; one being stopped takes none
	if m.Labels[serviceLabel] != "" {
		if !s.claim(name) {
			return nil, errStatus(409, "replica %s is stopping (send the job to its service)", name)
		}
		defer s.touch(name, -1)
	}
	return s.runJob(ctx, m.Socket, name, req)
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

// reap forgets machines that stopped and templates whose server did (with their machines). A
// template a service runs on is kept, asleep: the service's next replica starts its server again.
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
		// Stopping: what it stops is not to be forgotten as dead
		if s.closing {
			s.mu.Unlock()
			return
		}
		for _, n := range deadMachines {
			if m, ok := s.st.Machines[n]; ok && !control.Alive(m.Socket) {
				for _, l := range s.forwards[n] {
					l.Close()
				}
				delete(s.forwards, n)
				delete(s.st.Machines, n)
				syscall.Kill(m.Pid, syscall.SIGKILL)
				os.Remove(m.Socket)
				s.note("machine.stopped", "machine "+n, "stopped (its process is gone)")
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
					// Its link sockets and links go below, as a dead machine's do
					deadMachines = append(deadMachines, mn)
				}
			}
			killGroup(t.Pid, syscall.SIGKILL)
			os.RemoveAll(t.SocketDir)
			var used []string
			for _, svc := range s.st.Services {
				if svc.Template == n {
					used = append(used, svc.Name)
				}
			}
			if len(used) > 0 {
				sort.Strings(used)
				t.Asleep, t.Pid, t.Server, t.SocketDir, t.Ready = true, 0, "", "", ""
				s.note("template.stopped", "template "+n, "its server stopped, and its machines with it; started again on the next use of service %s", strings.Join(used, ", "))
				continue
			}
			delete(s.st.Templates, n)
			s.note("template.stopped", "template "+n, "its server stopped, and its machines with it")
		}
		s.save()
		s.mu.Unlock()
		for _, n := range deadMachines {
			if !s.hasLocked(KindMachine, n) {
				s.unlinkMachine(n)
				s.dropLinks(KindMachine, n)
			}
		}
		for _, n := range deadTemplates {
			if !s.hasLocked(KindTemplate, n) {
				s.dropLinks(KindTemplate, n)
			}
		}
	}
}

// hasLocked is has, taking s.mu.
func (s *Server) hasLocked(kind, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.has(kind, name)
}

// --- snapshots

// Snapshot saves a running machine whole as name: the machine writes it under its template's
// jobs root (all its sandbox lets it write), and the daemon keeps it with its own.
func (s *Server) Snapshot(machine, name string) (*Snapshot, error) {
	return s.SnapshotWith(machine, name, nil)
}

// SnapshotWith is Snapshot, with labels.
func (s *Server) SnapshotWith(machine, name string, labels map[string]string) (*Snapshot, error) {
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
		Bytes: saved.Bytes, Ms: saved.Ms, Labels: labels, Created: time.Now()}
	if err := os.Rename(written, snap.Path); err != nil {
		os.Remove(written)
		os.Remove(written + userState)
		return nil, err
	}
	// A machine with no kernel: its program's process, saved beside it
	if _, err := os.Stat(written + userState); err == nil {
		if err := os.Rename(written+userState, snap.Path+userState); err != nil {
			os.Remove(snap.Path)
			return nil, err
		}
	}
	s.mu.Lock()
	s.st.Snapshots[name] = snap
	s.save()
	s.mu.Unlock()
	s.note("snapshot.saved", "snapshot "+name, "of %s, %d bytes in %d ms", machine, saved.Bytes, saved.Ms)
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
	os.Remove(sn.Path + userState)
	delete(s.st.Snapshots, name)
	s.sweepUploads()
	s.save()
	s.ev.publish(Event{Time: time.Now(), Kind: "snapshot.removed", Subject: "snapshot " + name, Message: "removed"})
	return nil
}

// userState is the suffix of what a snapshot of a machine with no kernel keeps beside its machine:
// its program's process (snowglobe-vm writes both)
const userState = ".user"

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
	if _, err := os.Stat(sn.Path + userState); err == nil {
		if err := os.Link(sn.Path+userState, link+userState); err != nil {
			os.Remove(link)
			return "", err
		}
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
	mux.HandleFunc("GET /v1/events", s.serveEvents)
	// Stop the daemon, and everything it started; answered once that has stopped
	mux.HandleFunc("POST /v1/shutdown", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		quit := s.quit
		s.mu.Unlock()
		if quit == nil {
			reply(w, nil, errStatus(409, "not serving"))
			return
		}
		quit()
		<-s.stopped
		reply(w, map[string]any{"stopped": true}, nil)
	})
	mux.HandleFunc("GET /v1/stats", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Stats(), nil)
	})
	mux.HandleFunc("GET /v1/metrics", s.serveMetrics)
	mux.HandleFunc("GET /metrics", s.servePrometheus)
	s.buildRoutes(mux)
	s.portRoutes(mux)
	s.runRoutes(mux)
	s.linkRoutes(mux)
	s.graphRoutes(mux)
	if s.o.Routes != nil {
		s.o.Routes(mux)
	}
	mux.HandleFunc("GET /v1/machines/{name}/attach", s.serveAttach)
	mux.HandleFunc("POST /v1/sites", s.serveUpload)
	mux.HandleFunc("GET /v1/templates", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Templates(), nil)
	})
	mux.HandleFunc("POST /v1/templates", func(w http.ResponseWriter, r *http.Request) {
		var req AddTemplate
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		req.remote = IsRemote(r)
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
		v, err := s.TemplateJob(r.Context(), r.PathValue("name"), req)
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
		v, err := s.Job(r.Context(), r.PathValue("name"), req)
		reply(w, v, err)
	})
	mux.HandleFunc("POST /v1/machines/{name}/snapshots", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels"`
		}
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.SnapshotWith(r.PathValue("name"), req.Name, req.Labels)
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
		v, err := s.ServiceJob(r.Context(), r.PathValue("name"), req)
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
		h.ServeHTTP(w, markRemote(r))
	})
}

// --- small helpers

// killGroup signals process group pid, if pid names one: kill(-0) or kill(-(-1)) would reach
// this daemon's own group, or every process it may signal.
func killGroup(pid int, sig syscall.Signal) {
	if pid > 1 {
		syscall.Kill(-pid, sig)
	}
}

// loopback says whether a listen address is reachable from this host only.
func loopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

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
