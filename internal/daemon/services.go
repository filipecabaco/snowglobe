package daemon

import (
	"context"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// A service is a template's machines behind host ports the daemon holds: each connection goes to
// one of its replicas, started on demand. With Min 0 it scales to zero: replicas idle for Idle
// are stopped, and the next connection (or job) starts one again in tens of milliseconds. State
// "keep" saves the replica before it stops and starts the next one from that save; "discard"
// starts every replica from the template.

// Service is a service's configuration and what it keeps between replicas.
type Service struct {
	Name     string `json:"name"`
	Template string `json:"template"`
	Ports    []Port `json:"ports,omitempty"`
	// Replicas kept running (0: scale to zero), and the most it starts
	Min int `json:"min"`
	Max int `json:"max"`
	// How long a replica may have no connection or job before it is stopped (above Min)
	Idle Duration `json:"idle"`
	// Connections a replica takes before another is started (up to Max)
	Concurrency int `json:"concurrency"`
	// "discard": a replica starts from the template; "keep": from the last one's save
	State string `json:"state"`
	// The snapshot the next replica starts from (State "keep")
	Saved   string            `json:"saved,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
	Created time.Time         `json:"created"`
}

// ServiceStatus is a service with its replicas as they are now.
type ServiceStatus struct {
	Service
	Replicas []Replica `json:"replicas"`
}

// Replica is a service's machine, with what it is doing.
type Replica struct {
	Machine string    `json:"machine"`
	Active  int       `json:"active"`
	Last    time.Time `json:"last"`
}

// Duration is a time.Duration as JSON: "5m", "30s" (or nanoseconds).
type Duration time.Duration

func (d Duration) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Duration(d).String() + `"`), nil
}

func (d *Duration) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		v, err := time.ParseDuration(string(b[1 : len(b)-1]))
		*d = Duration(v)
		return err
	}
	var n int64
	_, err := fmt.Sscan(string(b), &n)
	*d = Duration(n)
	return err
}

// serviceLabel marks a service's replicas
const serviceLabel = "snowglobe.service"

// activity is what a replica is doing: connections open, and when it last did anything; and
// whether it is being stopped, when nothing more goes to it.
type activity struct {
	active   int
	last     time.Time
	stopping bool
}

// services is the daemon's running side of its services: listeners, and its replicas' activity.
type services struct {
	mu        sync.Mutex
	listeners map[string][]net.Listener
	activity  map[string]*activity
	// One start at a time per service, so that a burst of connections to a service at zero
	// starts one replica, not one each
	starting map[string]*sync.Mutex
}

func newServices() *services {
	return &services{listeners: map[string][]net.Listener{}, activity: map[string]*activity{}, starting: map[string]*sync.Mutex{}}
}

// touch records that machine did something (a connection opened (+1) or closed (-1), a job (0)).
func (s *Server) touch(machine string, delta int) {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	a := s.svc.activity[machine]
	if a == nil {
		a = &activity{}
		s.svc.activity[machine] = a
	}
	a.active += delta
	a.last = time.Now()
}

// claim counts a connection or job on replica machine, unless it is being stopped.
func (s *Server) claim(machine string) bool {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	a := s.svc.activity[machine]
	if a == nil {
		a = &activity{}
		s.svc.activity[machine] = a
	}
	if a.stopping {
		return false
	}
	a.active++
	a.last = time.Now()
	return true
}

// markStopping marks a replica as being stopped, so that nothing more goes to it: only while it
// has been idle for idle (unless force), and once. With mark false it only says whether it would.
func (s *Server) markStopping(machine string, idle time.Duration, force, mark bool) bool {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	a := s.svc.activity[machine]
	if a == nil {
		a = &activity{last: time.Now()}
		s.svc.activity[machine] = a
		if !force {
			// Not seen doing anything yet: idle from now
			return false
		}
	}
	if a.stopping || !force && (a.active > 0 || time.Since(a.last) < idle) {
		return false
	}
	a.stopping = a.stopping || mark
	return true
}

// AddService validates a service, holds its ports and starts its Min replicas.
func (s *Server) AddService(req Service) (*ServiceStatus, error) {
	if err := validName(req.Name); err != nil {
		return nil, errStatus(400, "%v", err)
	}
	if req.Min < 0 {
		return nil, errStatus(400, "min: 0 or more")
	}
	if req.Max == 0 {
		req.Max = max(req.Min, 1)
	}
	if req.Max < max(req.Min, 1) {
		return nil, errStatus(400, "max %d: at least min (%d) and 1", req.Max, req.Min)
	}
	if req.Concurrency <= 0 {
		req.Concurrency = 10
	}
	if req.Idle == 0 {
		req.Idle = Duration(5 * time.Minute)
	}
	if req.Idle < Duration(time.Second) {
		return nil, errStatus(400, "idle %s: a second or more", time.Duration(req.Idle))
	}
	switch req.State {
	case "":
		req.State = "discard"
	case "discard":
	case "keep":
		// One machine's state, carried from replica to replica
		if req.Max != 1 {
			return nil, errStatus(400, "state keep: one replica at most (max 1), whose state the next one carries on")
		}
	default:
		return nil, errStatus(400, "state %q: discard or keep", req.State)
	}
	s.mu.Lock()
	_, taken := s.st.Services[req.Name]
	t, ok := s.st.Templates[req.Template]
	s.mu.Unlock()
	if taken {
		return nil, errStatus(409, "a service called %s exists", req.Name)
	}
	if !ok {
		return nil, errStatus(404, "no template called %s", req.Template)
	}
	if len(req.Ports) > 0 {
		if err := needsNetwork(t); err != nil {
			return nil, err
		}
	}
	svc := req
	svc.Saved = ""
	svc.Created = time.Now()
	svc.Ports = append([]Port(nil), req.Ports...)
	for i := range svc.Ports {
		// No address: this host's loopback, as up's ports (never every interface by omission)
		if svc.Ports[i].IP == "" {
			svc.Ports[i].IP = "127.0.0.1"
		}
	}
	if err := s.listenService(&svc); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if _, taken := s.st.Services[svc.Name]; taken {
		s.mu.Unlock()
		s.closeListeners(svc.Name)
		return nil, errStatus(409, "a service called %s exists", svc.Name)
	}
	s.st.Services[svc.Name] = &svc
	s.save()
	s.mu.Unlock()
	if err := s.topUp(svc.Name, svc.Min, false); err != nil {
		s.RemoveService(svc.Name)
		return nil, err
	}
	s.note("service.added", "service "+svc.Name, "on %s, %d to %d replicas of %s, idle %s, state %s", portList(svc.Ports), svc.Min, svc.Max,
		svc.Template, time.Duration(svc.Idle), svc.State)
	return s.ServiceStatus(svc.Name)
}

func portList(ps []Port) string {
	if len(ps) == 0 {
		return "no ports"
	}
	out := ""
	for i, p := range ps {
		if i > 0 {
			out += ", "
		}
		out += p.String()
	}
	return out
}

// listenService holds a service's host ports (filling in those the system picks). The name is
// held first, so that two services of one name never both listen.
func (s *Server) listenService(svc *Service) error {
	s.svc.mu.Lock()
	if _, held := s.svc.listeners[svc.Name]; held {
		s.svc.mu.Unlock()
		return errStatus(409, "a service called %s exists", svc.Name)
	}
	s.svc.listeners[svc.Name] = nil
	s.svc.mu.Unlock()
	var ls []net.Listener
	for i, p := range svc.Ports {
		l, err := net.Listen("tcp", net.JoinHostPort(p.IP, fmt.Sprint(p.Host)))
		if err != nil {
			for _, l := range ls {
				l.Close()
			}
			s.svc.mu.Lock()
			delete(s.svc.listeners, svc.Name)
			s.svc.mu.Unlock()
			return errStatus(400, "port %s: %v", p, err)
		}
		svc.Ports[i].Host = l.Addr().(*net.TCPAddr).Port
		ls = append(ls, l)
		go s.acceptService(svc.Name, l, p.Guest)
	}
	s.svc.mu.Lock()
	s.svc.listeners[svc.Name] = ls
	s.svc.mu.Unlock()
	return nil
}

// closeListeners lets go of a service's host ports.
func (s *Server) closeListeners(name string) {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	for _, l := range s.svc.listeners[name] {
		l.Close()
	}
	delete(s.svc.listeners, name)
}

func (s *Server) acceptService(name string, l net.Listener, guest int) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go func() {
			m, err := s.pickReplica(name)
			if err != nil {
				s.note("service.error", "service "+name, "%v", err)
				c.Close()
				return
			}
			defer s.touch(m.Name, -1)
			splice(c, m.Socket, guest)
		}()
	}
}

// replicas are a service's machines, by name.
func (s *Server) replicas(name string) []Machine {
	return s.Machines(map[string]string{serviceLabel: name})
}

// pickReplica is the replica a connection or job goes to: the least busy one under the service's
// concurrency, else a new one (up to Max), else the least busy. A service at zero starts one.
// The replica is claimed for it (counted busy) as it is picked, so that the scaler can't stop it
// in between: the caller ends it with touch(m.Name, -1). Replicas being stopped aren't picked.
func (s *Server) pickReplica(name string) (*Machine, error) {
	s.mu.Lock()
	svc, ok := s.st.Services[name]
	var conc, maxN int
	if ok {
		conc, maxN = svc.Concurrency, svc.Max
	}
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no service called %s", name)
	}
	pick := func() (*Machine, bool) {
		all := s.replicas(name)
		s.svc.mu.Lock()
		defer s.svc.mu.Unlock()
		var rs []Machine
		for _, m := range all {
			if a := s.svc.activity[m.Name]; a == nil || !a.stopping {
				rs = append(rs, m)
			}
		}
		if len(rs) == 0 {
			return nil, false
		}
		busy := func(m Machine) int {
			if a := s.svc.activity[m.Name]; a != nil {
				return a.active
			}
			return 0
		}
		sort.SliceStable(rs, func(i, j int) bool { return busy(rs[i]) < busy(rs[j]) })
		least := rs[0]
		if busy(least) >= conc && len(rs) < maxN {
			return nil, false
		}
		a := s.svc.activity[least.Name]
		if a == nil {
			a = &activity{}
			s.svc.activity[least.Name] = a
		}
		a.active++
		a.last = time.Now()
		return &least, true
	}
	if m, ok := pick(); ok {
		return m, nil
	}
	// Room for another: one start at a time, then look again (another may have started it)
	lock := s.startLock(name)
	lock.Lock()
	defer lock.Unlock()
	if m, ok := pick(); ok {
		return m, nil
	}
	m, err := s.startReplica(name, false)
	if err != nil {
		return nil, err
	}
	s.touch(m.Name, 1)
	return m, nil
}

// startLock is a service's lock for starting replicas: every start (for a connection, for its
// minimum, when it is added) holds it and counts the replicas again under it, so that a replica
// still starting (not yet listed) is never started twice.
func (s *Server) startLock(name string) *sync.Mutex {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	lock := s.svc.starting[name]
	if lock == nil {
		lock = &sync.Mutex{}
		s.svc.starting[name] = lock
	}
	return lock
}

// topUp starts replicas of a service until it has min, counting them under its start lock.
// noWait: a start that doesn't fit the memory budget is refused at once (the scaler's).
func (s *Server) topUp(name string, min int, noWait bool) error {
	lock := s.startLock(name)
	lock.Lock()
	defer lock.Unlock()
	for running := len(s.replicas(name)); running < min; running++ {
		if _, err := s.startReplica(name, noWait); err != nil {
			return err
		}
	}
	return nil
}

// startReplica starts one of a service's replicas: from its last save (state keep), else from
// its template. Its start lock is held.
func (s *Server) startReplica(name string, noWait bool) (*Machine, error) {
	s.mu.Lock()
	svc, ok := s.st.Services[name]
	var req Up
	if ok {
		req = Up{Template: svc.Template, Name: randomName(name), Labels: map[string]string{serviceLabel: name}, noWait: noWait}
		// A replica is of its service's fleet and instance: its instance's links are its own
		for _, k := range []string{"snowglobe.fleet", InstanceLabel} {
			if v := svc.Labels[k]; v != "" {
				req.Labels[k] = v
			}
		}
		if svc.State == "keep" {
			req.Snapshot = svc.Saved
		}
	}
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no service called %s", name)
	}
	begun := time.Now()
	m, err := s.Up(req)
	if err != nil {
		return nil, fmt.Errorf("service %s: a replica: %w", name, err)
	}
	s.touch(m.Name, 0)
	from := "its template"
	if req.Snapshot != "" {
		from = "its last state"
	}
	s.note("service.replica_up", "service "+name, "replica %s up from %s in %d ms", m.Name, from, time.Since(begun).Milliseconds())
	return m, nil
}

// ServiceJob runs a job on one of a service's replicas (starting one if it is at zero).
func (s *Server) ServiceJob(ctx context.Context, name string, req control.JobRequest) (*control.JobResult, error) {
	m, err := s.pickReplica(name)
	if err != nil {
		return nil, err
	}
	defer s.touch(m.Name, -1)
	return s.runJob(ctx, m.Socket, m.Name, req)
}

// scale stops what has been idle too long, above each service's Min (saving it first, state
// keep), and starts what is missing below it.
func (s *Server) scale() {
	s.mu.Lock()
	var svcs []Service
	for _, svc := range s.st.Services {
		svcs = append(svcs, *svc)
	}
	s.mu.Unlock()
	for _, svc := range svcs {
		rs := s.replicas(svc.Name)
		running := len(rs)
		for _, m := range rs {
			if running <= svc.Min {
				break
			}
			if s.stopReplica(svc, m, false) {
				running--
			}
		}
		if running < svc.Min {
			// Not waiting for room in the memory budget: tried again on the next round
			if err := s.topUp(svc.Name, svc.Min, true); err != nil {
				s.o.Logf("%v", err)
			}
		}
	}
}

// stopReplica stops a replica once it is idle (or at once, force), and says whether it did: saved
// first when its service keeps state. Marked as stopping first, nothing more goes to it; with
// state kept, its service's start lock is held until it is gone, so that the next replica starts
// from this save and not the last.
func (s *Server) stopReplica(svc Service, m Machine, force bool) bool {
	idle := time.Duration(svc.Idle)
	// Busy: not waiting for the lock to find that out
	if !force && !s.markStopping(m.Name, idle, false, false) {
		return false
	}
	if svc.State == "keep" {
		lock := s.startLock(svc.Name)
		lock.Lock()
		defer lock.Unlock()
	}
	if _, err := s.Machine(m.Name); err != nil {
		// Gone meanwhile (stopped by another)
		return false
	}
	if !s.markStopping(m.Name, idle, force, true) {
		return false
	}
	if svc.State == "keep" {
		snap, err := s.Snapshot(m.Name, randomName(svc.Name+"-state"))
		if err != nil {
			// Not stopped: its state would be lost
			s.note("service.error", "service "+svc.Name, "saving %s before it stops: %v", m.Name, err)
			s.svc.mu.Lock()
			if a := s.svc.activity[m.Name]; a != nil {
				a.stopping = false
			}
			s.svc.mu.Unlock()
			return false
		}
		s.mu.Lock()
		old, kept := "", false
		if cur, ok := s.st.Services[svc.Name]; ok {
			old, cur.Saved, kept = cur.Saved, snap.Name, true
			s.save()
		}
		s.mu.Unlock()
		if !kept {
			// The service was removed meanwhile: nothing will start from it
			old = snap.Name
		}
		if old != "" {
			s.RemoveSnapshot(old)
		}
	}
	s.RemoveMachine(m.Name)
	s.svc.mu.Lock()
	delete(s.svc.activity, m.Name)
	s.svc.mu.Unlock()
	s.note("service.replica_stopped", "service "+svc.Name, "replica %s stopped, idle %s", m.Name, time.Duration(svc.Idle))
	return true
}

// scaleEvery is how often idle replicas are looked for
var scaleEvery = time.Second

func (s *Server) scaler(ctx context.Context) {
	t := time.NewTicker(s.scaleEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.scale()
			s.lifecycle()
		}
	}
}

// RemoveService stops a service's replicas, lets go of its ports and drops its saved state. It
// is forgotten first, so that nothing starts another replica of it, and its start lock waited
// for, so that a replica still starting is up (and then stopped) before its replicas are listed.
func (s *Server) RemoveService(name string) error {
	s.mu.Lock()
	svc, ok := s.st.Services[name]
	if ok {
		delete(s.st.Services, name)
		s.save()
	}
	s.mu.Unlock()
	if !ok {
		return errStatus(404, "no service called %s", name)
	}
	s.closeListeners(name)
	lock := s.startLock(name)
	lock.Lock()
	for _, m := range s.replicas(name) {
		s.RemoveMachine(m.Name)
		s.svc.mu.Lock()
		delete(s.svc.activity, m.Name)
		s.svc.mu.Unlock()
	}
	s.svc.mu.Lock()
	delete(s.svc.starting, name)
	s.svc.mu.Unlock()
	lock.Unlock()
	// (Read once its replicas are gone: a save before a stop updated it until it was forgotten)
	s.mu.Lock()
	saved := svc.Saved
	s.mu.Unlock()
	if saved != "" {
		s.RemoveSnapshot(saved)
	}
	s.note("service.removed", "service "+name, "removed")
	s.dropLinks(KindService, name)
	return nil
}

// ServiceStatus is a service and its replicas now.
func (s *Server) ServiceStatus(name string) (*ServiceStatus, error) {
	s.mu.Lock()
	svc, ok := s.st.Services[name]
	var st ServiceStatus
	if ok {
		st.Service = *svc
	}
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no service called %s", name)
	}
	st.Replicas = []Replica{}
	for _, m := range s.replicas(name) {
		r := Replica{Machine: m.Name}
		s.svc.mu.Lock()
		if a := s.svc.activity[m.Name]; a != nil {
			r.Active, r.Last = a.active, a.last
		}
		s.svc.mu.Unlock()
		st.Replicas = append(st.Replicas, r)
	}
	return &st, nil
}

// Services lists the services and their replicas, by name.
func (s *Server) Services() []ServiceStatus {
	s.mu.Lock()
	var names []string
	for n := range s.st.Services {
		names = append(names, n)
	}
	s.mu.Unlock()
	sort.Strings(names)
	out := []ServiceStatus{}
	for _, n := range names {
		if st, err := s.ServiceStatus(n); err == nil {
			out = append(out, *st)
		}
	}
	return out
}
