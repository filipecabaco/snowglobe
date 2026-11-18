package daemon

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// A supervisor watches an ordered list of children (services, machines, other supervisors) and
// restarts them when one fails, as an Elixir supervisor does its processes. A child fails when its
// health check makes it (or one of a service's replicas) unhealthy, or its process ends without
// being asked to. The strategy says what is restarted then:
//
//   - one_for_one: the failed child alone
//   - one_for_all: every child
//   - rest_for_one: the failed child and every child after it in the list (what was started after
//     it, and so may depend on it)
//
// What is restarted is stopped in reverse order, then started in order. A machine starts again as
// it was (its name, template, ports, labels, snapshot, links); a service's running replicas are
// replaced (as many as were running: a service at zero stays there), and a failed replica of a
// failed service alone; a supervisor restarts all of its children.
//
// Each child's restart type says whether it is restarted: permanent (always), transient (when it
// fails its check, not when its process ends: that is a normal exit) or temporary (never: its
// failure is a normal exit, and restarts nothing else either). More than MaxRestarts restarts in
// MaxSeconds and the supervisor fails itself: a nested one is its parent's failed child, a
// top-level one stops restarting (degraded) until it is restarted by hand.

// Strategies
const (
	OneForOne  = "one_for_one"
	OneForAll  = "one_for_all"
	RestForOne = "rest_for_one"
)

// Restart types
const (
	Permanent = "permanent"
	Transient = "transient"
	Temporary = "temporary"
)

// KindSupervisor is a supervisor as a link end, a child or a fleet object.
const KindSupervisor = "supervisor"

// Supervisor states, besides the children's
const (
	SupervisorRunning  = "running"
	SupervisorDegraded = "degraded"
)

// How a child failed
const (
	failUnhealthy = "failed its health check"
	failEnded     = "ended (its process is gone)"
	failEscalated = "restarted too often"
)

// Supervisor is a supervisor as it is asked for (and kept).
type Supervisor struct {
	Name     string  `json:"name"`
	Strategy string  `json:"strategy"`
	Children []Child `json:"children"`
	// More restarts than this within MaxSeconds and it fails itself
	MaxRestarts int               `json:"max_restarts"`
	MaxSeconds  Duration          `json:"max_seconds"`
	Labels      map[string]string `json:"labels,omitempty"`
}

// Child is one of a supervisor's children: a service, machine or supervisor, and its restart type.
type Child struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Restart string `json:"restart"`
}

// SupervisorStatus is a supervisor and how it is doing: running or degraded, its parent, the
// restarts it counts now, and each child's state.
type SupervisorStatus struct {
	Supervisor
	State    string        `json:"state"`
	Parent   string        `json:"parent,omitempty"`
	Restarts int           `json:"restarts"`
	States   []ChildStatus `json:"states"`
}

// ChildStatus is how a child is: a service's health (or running, idle), a machine's (or running),
// a supervisor's state, or missing (it isn't there).
type ChildStatus struct {
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	State string `json:"state"`
}

// supervisors is the daemon's running side of its supervisors.
type supervisors struct {
	mu   sync.Mutex
	runs map[string]*supRun
}

// supRun is a supervisor's restarts: one at a time (restart), when they were, and whether it gave
// up.
type supRun struct {
	restart  sync.Mutex
	mu       sync.Mutex
	restarts []time.Time
	degraded bool
}

func newSupervisors() *supervisors { return &supervisors{runs: map[string]*supRun{}} }

func (s *Server) supRun(name string) *supRun {
	s.sup.mu.Lock()
	defer s.sup.mu.Unlock()
	r := s.sup.runs[name]
	if r == nil {
		r = &supRun{}
		s.sup.runs[name] = r
	}
	return r
}

// supervisorOfLocked is the supervisor a child is of (nil: none). s.mu is held.
func (s *Server) supervisorOfLocked(kind, name string) *Supervisor {
	for _, sup := range s.st.Supervisors {
		for _, c := range sup.Children {
			if c.Kind == kind && c.Name == name {
				return sup
			}
		}
	}
	return nil
}

func copySupervisor(sup *Supervisor) Supervisor {
	c := *sup
	c.Children = append([]Child(nil), sup.Children...)
	return c
}

// checkSupervisorLocked fills in a supervisor's defaults and says what is wrong with it; replacing
// is the one it replaces (its children may stay its). s.mu is held.
func (s *Server) checkSupervisorLocked(sup *Supervisor, replacing string) error {
	if err := validName(sup.Name); err != nil {
		return errStatus(400, "%v", err)
	}
	switch sup.Strategy {
	case "":
		sup.Strategy = OneForOne
	case OneForOne, OneForAll, RestForOne:
	default:
		return errStatus(400, "strategy %q: one_for_one, one_for_all or rest_for_one", sup.Strategy)
	}
	if sup.MaxRestarts == 0 {
		sup.MaxRestarts = 3
	}
	if sup.MaxRestarts < 0 {
		return errStatus(400, "max_restarts: 1 or more (a child never to be restarted is temporary)")
	}
	if sup.MaxSeconds == 0 {
		sup.MaxSeconds = Duration(time.Minute)
	}
	if sup.MaxSeconds < Duration(time.Second) {
		return errStatus(400, "max_seconds %s: a second or more", time.Duration(sup.MaxSeconds))
	}
	if len(sup.Children) == 0 {
		return errStatus(400, "children: at least one")
	}
	seen := map[string]bool{}
	for i := range sup.Children {
		c := &sup.Children[i]
		what := c.Kind + " " + c.Name
		switch c.Restart {
		case "":
			c.Restart = Permanent
		case Permanent, Transient, Temporary:
		default:
			return errStatus(400, "%s: restart %q: permanent, transient or temporary", what, c.Restart)
		}
		if seen[c.Kind+"/"+c.Name] {
			return errStatus(400, "%s: a child twice", what)
		}
		seen[c.Kind+"/"+c.Name] = true
		switch c.Kind {
		case KindService, KindMachine:
			if !s.has(c.Kind, c.Name) {
				return errStatus(404, "no %s called %s", c.Kind, c.Name)
			}
			if m := s.st.Machines[c.Name]; c.Kind == KindMachine && m.Labels[serviceLabel] != "" {
				return errStatus(400, "%s: a replica of service %s (supervise the service)", what, m.Labels[serviceLabel])
			}
		case KindSupervisor:
			if c.Name == sup.Name {
				return errStatus(400, "%s: a supervisor can't be its own child", what)
			}
			if _, ok := s.st.Supervisors[c.Name]; !ok {
				return errStatus(404, "no supervisor called %s", c.Name)
			}
			// Not one it is (in the end) a child of
			for p := s.supervisorOfLocked(KindSupervisor, sup.Name); p != nil; p = s.supervisorOfLocked(KindSupervisor, p.Name) {
				if p.Name == c.Name {
					return errStatus(400, "%s: supervisor %s is (in the end) its child: they'd go round in a circle", what, c.Name)
				}
			}
		default:
			return errStatus(400, "%s: a child is a service, machine or supervisor", what)
		}
		if other := s.supervisorOfLocked(c.Kind, c.Name); other != nil && other.Name != replacing {
			return errStatus(409, "%s is a child of supervisor %s already", what, other.Name)
		}
	}
	return nil
}

// AddSupervisor adds a supervisor over children that are there already.
func (s *Server) AddSupervisor(req Supervisor) (*SupervisorStatus, error) {
	sup := copySupervisor(&req)
	s.mu.Lock()
	if _, taken := s.st.Supervisors[sup.Name]; taken {
		s.mu.Unlock()
		return nil, errStatus(409, "a supervisor called %s exists", sup.Name)
	}
	if err := s.checkSupervisorLocked(&sup, ""); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.st.Supervisors[sup.Name] = &sup
	s.save()
	s.mu.Unlock()
	s.note("supervisor.added", "supervisor "+sup.Name, "%s over %s, at most %d restarts in %s", sup.Strategy, childList(sup.Children), sup.MaxRestarts, time.Duration(sup.MaxSeconds))
	return s.SupervisorStatus(sup.Name)
}

// UpdateSupervisor changes a supervisor in place: its children are not restarted, and its restart
// count stays.
func (s *Server) UpdateSupervisor(name string, req Supervisor) (*SupervisorStatus, error) {
	sup := copySupervisor(&req)
	sup.Name = name
	s.mu.Lock()
	if _, ok := s.st.Supervisors[name]; !ok {
		s.mu.Unlock()
		return nil, errStatus(404, "no supervisor called %s", name)
	}
	if err := s.checkSupervisorLocked(&sup, name); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.st.Supervisors[name] = &sup
	s.save()
	s.mu.Unlock()
	s.note("supervisor.changed", "supervisor "+name, "%s over %s, at most %d restarts in %s", sup.Strategy, childList(sup.Children), sup.MaxRestarts, time.Duration(sup.MaxSeconds))
	return s.SupervisorStatus(name)
}

// RemoveSupervisor removes a supervisor; its children go on, unsupervised.
func (s *Server) RemoveSupervisor(name string) error {
	s.mu.Lock()
	if _, ok := s.st.Supervisors[name]; !ok {
		s.mu.Unlock()
		return errStatus(404, "no supervisor called %s", name)
	}
	delete(s.st.Supervisors, name)
	s.save()
	s.mu.Unlock()
	s.sup.mu.Lock()
	delete(s.sup.runs, name)
	s.sup.mu.Unlock()
	s.note("supervisor.removed", "supervisor "+name, "removed; its children go on unsupervised")
	return nil
}

// Supervisors lists the supervisors, by name.
func (s *Server) Supervisors() []SupervisorStatus {
	s.mu.Lock()
	var names []string
	for n := range s.st.Supervisors {
		names = append(names, n)
	}
	s.mu.Unlock()
	sort.Strings(names)
	out := []SupervisorStatus{}
	for _, n := range names {
		if st, err := s.SupervisorStatus(n); err == nil {
			out = append(out, *st)
		}
	}
	return out
}

// SupervisorStatus is a supervisor and how it and its children are doing.
func (s *Server) SupervisorStatus(name string) (*SupervisorStatus, error) {
	s.mu.Lock()
	sup, ok := s.st.Supervisors[name]
	var st SupervisorStatus
	if ok {
		st.Supervisor = copySupervisor(sup)
		if p := s.supervisorOfLocked(KindSupervisor, name); p != nil {
			st.Parent = p.Name
		}
	}
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no supervisor called %s", name)
	}
	run := s.supRun(name)
	run.mu.Lock()
	st.State = SupervisorRunning
	if run.degraded {
		st.State = SupervisorDegraded
	}
	cut := time.Now().Add(-time.Duration(st.MaxSeconds))
	for _, t := range run.restarts {
		if t.After(cut) {
			st.Restarts++
		}
	}
	run.mu.Unlock()
	st.States = []ChildStatus{}
	for _, c := range st.Children {
		st.States = append(st.States, ChildStatus{Kind: c.Kind, Name: c.Name, State: s.childState(c)})
	}
	return &st, nil
}

// childState is how a child is doing, in a word.
func (s *Server) childState(c Child) string {
	switch c.Kind {
	case KindService:
		st, err := s.ServiceStatus(c.Name)
		switch {
		case err != nil:
			return "missing"
		case st.ServiceHealth != "":
			return st.ServiceHealth
		case len(st.Replicas) == 0:
			return ServiceIdle
		}
		return SupervisorRunning
	case KindMachine:
		if _, err := s.Machine(c.Name); err != nil {
			return "missing"
		}
		s.svc.mu.Lock()
		defer s.svc.mu.Unlock()
		if h := s.svc.health[c.Name]; h != nil {
			return h.State
		}
		return SupervisorRunning
	case KindSupervisor:
		st, err := s.SupervisorStatus(c.Name)
		if err != nil {
			return "missing"
		}
		return st.State
	}
	return "missing"
}

// RestartSupervisor starts a supervisor over: its restart count is cleared, it is no longer
// degraded, and its children (but temporary ones) are restarted, in order.
func (s *Server) RestartSupervisor(name string) error {
	s.mu.Lock()
	sup, ok := s.st.Supervisors[name]
	var cp Supervisor
	if ok {
		cp = copySupervisor(sup)
	}
	s.mu.Unlock()
	if !ok {
		return errStatus(404, "no supervisor called %s", name)
	}
	run := s.supRun(name)
	run.restart.Lock()
	defer run.restart.Unlock()
	run.mu.Lock()
	run.restarts, run.degraded = nil, false
	run.mu.Unlock()
	var which []int
	for i, c := range cp.Children {
		if c.Restart != Temporary {
			which = append(which, i)
		}
	}
	restarted := s.restartChildren(cp, which, -1, "", nil)
	s.note("supervisor.restarted", "supervisor "+name, "restarted by hand: %s", strings.Join(restarted, ", "))
	return nil
}

// ended takes in that a machine's process is gone (reap): a supervised machine (or replica) is
// its supervisor's failed child. It says whether the machine is to start again (its links stay).
func (s *Server) ended(m Machine) bool {
	if svc := m.Labels[serviceLabel]; svc != "" {
		s.childFailed(KindService, svc, failEnded, "replica "+m.Name, m.Name, nil)
		return false
	}
	return s.childFailed(KindMachine, m.Name, failEnded, "", "", &m)
}

// childFailed takes in that a child failed, how (and what it found): its supervisor (if it has
// one) restarts what its strategy says, in the background. replica is a service's replica that
// failed, gone the machine that ended (to start it again as it was). It says whether the child is
// to be restarted.
func (s *Server) childFailed(kind, name, how, detail, replica string, gone *Machine) bool {
	s.mu.Lock()
	sup := s.supervisorOfLocked(kind, name)
	var c Child
	var supName string
	if sup != nil {
		supName = sup.Name
		for _, ch := range sup.Children {
			if ch.Kind == kind && ch.Name == name {
				c = ch
			}
		}
	}
	s.mu.Unlock()
	if sup == nil {
		return false
	}
	subject := "supervisor " + supName
	switch {
	case c.Restart == Temporary:
		s.note("supervisor.child_exited", subject, "%s %s %s: temporary, so nothing is restarted", kind, name, how)
		return false
	case c.Restart == Transient && how == failEnded:
		s.note("supervisor.child_exited", subject, "%s %s %s: transient, so a normal exit: nothing is restarted", kind, name, how)
		return false
	}
	run := s.supRun(supName)
	run.mu.Lock()
	degraded := run.degraded
	run.mu.Unlock()
	if degraded {
		s.note("supervisor.child_failed", subject, "%s %s %s: not restarted (the supervisor is degraded)", kind, name, how)
		return false
	}
	go s.supervise(supName, kind, name, how, detail, replica, gone)
	return true
}

// supervise restarts what a supervisor's strategy says for a failed child, unless it has
// restarted too often: then it fails itself.
func (s *Server) supervise(supName, kind, name, how, detail, replica string, gone *Machine) {
	run := s.supRun(supName)
	run.restart.Lock()
	defer run.restart.Unlock()
	s.mu.Lock()
	sup, ok := s.st.Supervisors[supName]
	var cp Supervisor
	idx := -1
	parent := ""
	if ok {
		cp = copySupervisor(sup)
		for i, c := range cp.Children {
			if c.Kind == kind && c.Name == name {
				idx = i
			}
		}
		if p := s.supervisorOfLocked(KindSupervisor, supName); p != nil {
			parent = p.Name
		}
	}
	s.mu.Unlock()
	subject := "supervisor " + supName
	// Removed meanwhile, no longer its child, or no longer failing (restarted by another)
	if idx < 0 || !s.stillFailed(kind, name, how, replica) {
		return
	}
	now := time.Now()
	run.mu.Lock()
	if run.degraded {
		run.mu.Unlock()
		return
	}
	cut := now.Add(-time.Duration(cp.MaxSeconds))
	kept := run.restarts[:0]
	for _, t := range run.restarts {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	run.restarts = kept
	if len(run.restarts) >= cp.MaxRestarts {
		run.restarts = nil
		if parent == "" {
			run.degraded = true
		}
		run.mu.Unlock()
		if parent != "" {
			s.note("supervisor.escalated", subject, "%s %s %s, after %d restarts in %s: it fails, and supervisor %s decides", kind, name, how, cp.MaxRestarts, time.Duration(cp.MaxSeconds), parent)
			s.childFailed(KindSupervisor, supName, failEscalated, "", "", nil)
			return
		}
		s.note("supervisor.degraded", subject, "%s %s %s, after %d restarts in %s: restarting stopped until it is restarted by hand", kind, name, how, cp.MaxRestarts, time.Duration(cp.MaxSeconds))
		return
	}
	run.restarts = append(run.restarts, now)
	count := len(run.restarts)
	run.mu.Unlock()

	var which []int
	switch cp.Strategy {
	case OneForAll:
		for i := range cp.Children {
			which = append(which, i)
		}
	case RestForOne:
		for i := idx; i < len(cp.Children); i++ {
			which = append(which, i)
		}
	default:
		which = []int{idx}
	}
	// A temporary child is left alone (but the one that failed: it isn't temporary)
	var keep []int
	for _, i := range which {
		if i == idx || cp.Children[i].Restart != Temporary {
			keep = append(keep, i)
		}
	}
	why := fmt.Sprintf("%s %s %s", kind, name, how)
	if detail != "" {
		why += ": " + detail
	}
	restarted := s.restartChildren(cp, keep, idx, replica, gone)
	s.note("supervisor.restarted", subject, "restarted %s (%s, restart %d of %d in %s): %s", strings.Join(restarted, ", "), cp.Strategy, count, cp.MaxRestarts, time.Duration(cp.MaxSeconds), why)
}

// stillFailed says whether a child is still as it failed: a restart that came first (or a pass)
// makes another unneeded.
func (s *Server) stillFailed(kind, name, how, replica string) bool {
	switch how {
	case failEnded:
		if kind == KindMachine {
			_, err := s.Machine(name)
			return err != nil
		}
		return true
	case failUnhealthy:
		m := name
		if kind == KindService {
			m = replica
		}
		s.svc.mu.Lock()
		defer s.svc.mu.Unlock()
		h := s.svc.health[m]
		return h != nil && h.State == Unhealthy
	}
	return true
}

// stopped is a child as it was stopped, to start again: a machine's record, how many replicas a
// service had running, a supervisor's children.
type stopped struct {
	c   Child
	m   *Machine
	n   int
	sub []stopped
}

// restartChildren stops a supervisor's children which (indexes, in order) in reverse order, then
// starts them in order. failed is the one that failed (-1: none), with the replica that did (a
// service's) or its record (a machine that ended). It is the children restarted, named.
func (s *Server) restartChildren(sup Supervisor, which []int, failed int, replica string, gone *Machine) []string {
	var done []stopped
	for k := len(which) - 1; k >= 0; k-- {
		i := which[k]
		c := sup.Children[i]
		if i == failed {
			done = append(done, s.stopChild(c, replica, gone))
		} else {
			done = append(done, s.stopChild(c, "", nil))
		}
	}
	var names []string
	for k := len(done) - 1; k >= 0; k-- {
		s.startChild(done[k])
		names = append(names, done[k].c.Kind+" "+done[k].c.Name)
	}
	return names
}

// stopChild stops a child to start it again. A service with a failed replica loses that replica
// alone; otherwise all of its running replicas.
func (s *Server) stopChild(c Child, replica string, gone *Machine) stopped {
	out := stopped{c: c}
	switch c.Kind {
	case KindMachine:
		if gone != nil {
			out.m = gone
			return out
		}
		m, err := s.takeDown(c.Name)
		if err != nil {
			return out
		}
		out.m = m
	case KindService:
		s.mu.Lock()
		svc, ok := s.st.Services[c.Name]
		var cp Service
		if ok {
			cp = *svc
		}
		s.mu.Unlock()
		if !ok {
			return out
		}
		rs := s.replicas(c.Name)
		in, _ := s.inService(rs)
		// As many as are running start again; a replica that ended was one more
		out.n = len(in)
		there := false
		for _, m := range rs {
			if replica != "" && m.Name != replica {
				continue
			}
			there = true
			s.stopReplica(cp, m, true)
		}
		if replica != "" && !there {
			out.n++
		}
	case KindSupervisor:
		s.mu.Lock()
		sub, ok := s.st.Supervisors[c.Name]
		var cp Supervisor
		if ok {
			cp = copySupervisor(sub)
		}
		s.mu.Unlock()
		if !ok {
			return out
		}
		for k := len(cp.Children) - 1; k >= 0; k-- {
			if cp.Children[k].Restart != Temporary {
				out.sub = append([]stopped{s.stopChild(cp.Children[k], "", nil)}, out.sub...)
			}
		}
	}
	return out
}

// startChild starts a stopped child again.
func (s *Server) startChild(st stopped) {
	switch st.c.Kind {
	case KindMachine:
		if st.m == nil {
			return
		}
		u, ok := upAgain(st.m)
		if !ok {
			s.note("machine.stopped", "machine "+st.m.Name, "not started again: its ttl is over")
			s.dropLinks(KindMachine, st.m.Name)
			return
		}
		if _, err := s.Up(u); err != nil {
			s.note("supervisor.error", "machine "+st.m.Name, "starting it again: %v", err)
			s.dropLinks(KindMachine, st.m.Name)
		}
	case KindService:
		s.mu.Lock()
		svc, ok := s.st.Services[st.c.Name]
		n := 0
		if ok {
			n = min(max(st.n, svc.Min), svc.Max)
		}
		s.mu.Unlock()
		if n > 0 {
			if err := s.topUp(st.c.Name, n, false); err != nil {
				s.note("supervisor.error", "service "+st.c.Name, "starting its replicas again: %v", err)
			}
		}
	case KindSupervisor:
		for _, sub := range st.sub {
			s.startChild(sub)
		}
		run := s.supRun(st.c.Name)
		run.mu.Lock()
		run.restarts, run.degraded = nil, false
		run.mu.Unlock()
	}
}

// upAgain is the request that starts a machine again as it was; false when its ttl is over.
func upAgain(m *Machine) (Up, bool) {
	var ports []string
	for _, p := range m.Ports {
		if strings.Contains(p.IP, ":") {
			ports = append(ports, fmt.Sprintf("%d:%d", p.Host, p.Guest))
		} else {
			ports = append(ports, fmt.Sprintf("%s:%d:%d", p.IP, p.Host, p.Guest))
		}
	}
	u := Up{Template: m.Template, Name: m.Name, Ports: ports, Labels: m.Labels, Snapshot: m.Snapshot, Egress: m.Egress, Health: m.Health}
	if m.Expires != nil {
		left := time.Until(*m.Expires)
		if left <= 0 {
			return u, false
		}
		u.TTL = Duration(left)
	}
	return u, true
}

// childList names children: "service db, machine api (transient)".
func childList(cs []Child) string {
	var out []string
	for _, c := range cs {
		n := c.Kind + " " + c.Name
		if c.Restart != Permanent {
			n += " (" + c.Restart + ")"
		}
		out = append(out, n)
	}
	return strings.Join(out, ", ")
}

// SetHealth changes the health check of a service, machine or template in place (nil: none),
// and adds labels to it (what a fleet marks it with): nothing is restarted. Its replicas'
// (machines') checks start over.
func (s *Server) SetHealth(kind, name string, h *Health, labels map[string]string) error {
	var err error
	if h != nil {
		h, err = NormalHealth(kind, h)
		if err != nil {
			return err
		}
	}
	s.mu.Lock()
	var affected []string
	var keys []string
	mark := func(l *map[string]string) {
		if len(labels) == 0 {
			return
		}
		if *l == nil {
			*l = map[string]string{}
		}
		for k, v := range labels {
			(*l)[k] = v
		}
	}
	switch kind {
	case KindService:
		svc, ok := s.st.Services[name]
		if !ok {
			s.mu.Unlock()
			return errStatus(404, "no service called %s", name)
		}
		if h != nil && h.HTTP != nil {
			if t := s.st.Templates[svc.Template]; t != nil {
				if err := needsNetwork(t); err != nil {
					s.mu.Unlock()
					return err
				}
			}
		}
		svc.Health = h
		mark(&svc.Labels)
		keys = append(keys, name)
	case KindMachine:
		m, ok := s.st.Machines[name]
		if !ok {
			s.mu.Unlock()
			return errStatus(404, "no machine called %s", name)
		}
		if m.Labels[serviceLabel] != "" {
			s.mu.Unlock()
			return errStatus(400, "machine %s is a replica of service %s: its service's health check is what checks it", name, m.Labels[serviceLabel])
		}
		m.Health = h
		mark(&m.Labels)
		affected = append(affected, name)
		keys = append(keys, "machine:"+name)
	case KindTemplate:
		t, ok := s.st.Templates[name]
		if !ok {
			s.mu.Unlock()
			return errStatus(404, "no template called %s", name)
		}
		t.Health = h
		mark(&t.Labels)
		// What has none of its own takes it
		for _, m := range s.st.Machines {
			if m.Template == name && m.Labels[serviceLabel] == "" && m.Health == nil {
				affected = append(affected, m.Name)
				keys = append(keys, "machine:"+m.Name)
			}
		}
		for _, svc := range s.st.Services {
			if svc.Template == name && svc.Health == nil {
				keys = append(keys, svc.Name)
			}
		}
	default:
		s.mu.Unlock()
		return errStatus(400, "a health check is on a service, machine or template, not a %s", kind)
	}
	for _, k := range keys {
		if svc, ok := s.st.Services[k]; ok {
			for _, m := range s.st.Machines {
				if m.Labels[serviceLabel] == svc.Name {
					affected = append(affected, m.Name)
				}
			}
		}
	}
	s.save()
	s.mu.Unlock()
	s.svc.mu.Lock()
	for _, m := range affected {
		if rh := s.svc.health[m]; rh != nil {
			rh.markReady()
			delete(s.svc.health, m)
		}
	}
	for _, k := range keys {
		delete(s.svc.heals, k)
	}
	s.svc.mu.Unlock()
	what := "removed"
	if h != nil {
		what = strings.TrimPrefix(h.describe(), ", ")
	}
	s.note(kind+".health_changed", kind+" "+name, "health check %s (nothing restarted)", what)
	return nil
}
