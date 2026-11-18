package daemon

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// A service's health check asks each of its replicas, every Interval, whether it works: an HTTP
// request to a guest port (answered with an expected status) or a command run in the guest (exit
// 0). Failures in a row make a replica unhealthy, and its service's Heal says what is done then.
//
// Checks are kept out of scale to zero's way: they never start a replica (a service at zero has
// nothing to check), they don't count as use (a check neither opens a connection the scaler sees
// nor moves a replica's last use, so a healthy idle replica still stops), and a replica about to
// be stopped for being idle, or being stopped, isn't checked. A replica that failed its check is
// never saved: a service that keeps its state starts the next one from the last good save.

// Heal strategies
const (
	// Said (an event, its health) and nothing more: connections still go to it
	HealNone = "none"
	// Taken out of service, kept as it is to be looked at: nothing more goes to it, and it stops
	// once idle (unsaved). Another starts if the service is below its minimum without it
	HealDrain = "drain"
	// Its HealCmd run in the guest (restart the app, say), then checked again from the start;
	// unhealthy again, it is replaced
	HealHook = "hook"
	// Taken out of service, its connections given Drain to end, then stopped (unsaved): another
	// starts at once if the service is below its minimum without it, else on the next use
	HealReplace = "replace"
)

// Health is how a service's replicas are checked, and what is done with one that fails.
type Health struct {
	// One of: an HTTP GET to a guest port, or a command in the guest
	HTTP *HTTPCheck `json:"http,omitempty"`
	Cmd  string     `json:"cmd,omitempty"`
	// How often each replica is checked, and how long a check may take
	Interval Duration `json:"interval"`
	Timeout  Duration `json:"timeout"`
	// Checks failed in a row that make a replica unhealthy
	Failures int `json:"failures"`
	// How long a replica has after it starts before a failed check counts
	Grace Duration `json:"grace"`
	// none, drain, hook or replace
	Heal string `json:"heal"`
	// The command a hook runs in the guest
	HealCmd string `json:"heal_cmd,omitempty"`
	// How long a replica being replaced has for its connections to end
	Drain Duration `json:"drain"`
	// A new replica's first connection waits for it to pass a check (up to Grace)
	WaitReady bool `json:"wait_ready,omitempty"`
}

// HTTPCheck is a GET of Path on guest Port, answered with a status in Status ("200-399",
// "200,204").
type HTTPCheck struct {
	Port   int    `json:"port"`
	Path   string `json:"path"`
	Status string `json:"status"`
}

// ReplicaHealth is how a replica's checks are going: State is starting (not yet passed),
// healthy, unhealthy or draining (out of service, to stop).
type ReplicaHealth struct {
	State    string    `json:"state"`
	Since    time.Time `json:"since"`
	Failures int       `json:"failures,omitempty"`
	// What the last check found, and when
	Last    string    `json:"last,omitempty"`
	Checked time.Time `json:"checked,omitempty"`
}

// Replica health states
const (
	Starting  = "starting"
	Healthy   = "healthy"
	Unhealthy = "unhealthy"
	Draining  = "draining"
)

// Service health (ServiceStatus.Health), besides a replica's states: nothing running to check,
// or healing given up
const (
	ServiceIdle     = "idle"
	ServiceDegraded = "degraded"
)

// minProbeInterval is the shortest check interval (a command check is a process in the guest)
var minProbeInterval = time.Second

// healTimeout is how long a hook's command may run
var healTimeout = time.Minute

// maxHeals is how many heals in a row a service gets, with none of its replicas passing a check
// in between, before healing stops and it is degraded
const maxHeals = 5

// maxHealBackoff is the longest wait between one heal of a service and the next
const maxHealBackoff = 5 * time.Minute

// replicaHealth is a replica's checks as they go.
type replicaHealth struct {
	ReplicaHealth
	service string
	started time.Time
	// A check is running; a heal is
	probing, healing bool
	// Its hook ran: unhealthy again, it is replaced
	hooked bool
	// Closed when it first passes (or its grace is over): what wait_ready waits for
	ready     chan struct{}
	readyDone bool
}

func (h *replicaHealth) markReady() {
	if !h.readyDone {
		h.readyDone = true
		close(h.ready)
	}
}

// serviceHeal is a service's heals: how many in a row, the earliest the next may be, whether it
// gave up, and whether its next replica starts from its template rather than its last save.
type serviceHeal struct {
	attempts int
	next     time.Time
	degraded bool
	fresh    bool
}

// checkHealth fills in a health check's defaults and says what is wrong with it.
func checkHealth(h *Health) error {
	if (h.HTTP == nil) == (h.Cmd == "") {
		return errStatus(400, "health: one of http or cmd")
	}
	if c := h.HTTP; c != nil {
		if c.Port < 1 || c.Port > 65535 {
			return errStatus(400, "health: http port %d: 1 to 65535", c.Port)
		}
		if c.Path == "" {
			c.Path = "/"
		}
		if !strings.HasPrefix(c.Path, "/") {
			return errStatus(400, "health: http path %q: starts with /", c.Path)
		}
		if c.Status == "" {
			c.Status = "200-399"
		}
		if _, err := parseStatus(c.Status); err != nil {
			return errStatus(400, "health: http status: %v", err)
		}
	}
	if h.Interval == 0 {
		h.Interval = Duration(10 * time.Second)
	}
	if time.Duration(h.Interval) < minProbeInterval {
		return errStatus(400, "health: interval %s: %s or more", time.Duration(h.Interval), minProbeInterval)
	}
	if h.Timeout == 0 {
		h.Timeout = Duration(min(2*time.Second, time.Duration(h.Interval)))
	}
	if h.Timeout < 0 || h.Timeout > h.Interval {
		return errStatus(400, "health: timeout %s: more than 0 and at most the interval (%s)", time.Duration(h.Timeout), time.Duration(h.Interval))
	}
	if h.Failures == 0 {
		h.Failures = 3
	}
	if h.Failures < 0 {
		return errStatus(400, "health: failures: 1 or more")
	}
	if h.Grace == 0 {
		h.Grace = Duration(30 * time.Second)
	}
	if h.Grace < 0 {
		return errStatus(400, "health: grace: 0 or more")
	}
	if h.Drain == 0 {
		h.Drain = Duration(30 * time.Second)
	}
	if h.Drain < 0 {
		return errStatus(400, "health: drain: 0 or more")
	}
	switch h.Heal {
	case "":
		h.Heal = HealReplace
	case HealNone, HealDrain, HealReplace:
	case HealHook:
		if h.HealCmd == "" {
			return errStatus(400, "health: heal hook: needs heal_cmd, the command it runs")
		}
	default:
		return errStatus(400, "health: heal %q: none, drain, hook or replace", h.Heal)
	}
	if h.HealCmd != "" && h.Heal != HealHook {
		return errStatus(400, "health: heal_cmd: only with heal hook")
	}
	return nil
}

// describe is a health check in a few words, after a comma ("" without one).
func (h *Health) describe() string {
	if h == nil {
		return ""
	}
	what := "cmd"
	if h.HTTP != nil {
		what = fmt.Sprintf("GET :%d%s", h.HTTP.Port, h.HTTP.Path)
	}
	return fmt.Sprintf(", checked by %s every %s, heal %s", what, time.Duration(h.Interval), h.Heal)
}

// parseStatus reads "200-399" or "200,204,300-399" as ranges.
func parseStatus(spec string) ([][2]int, error) {
	var out [][2]int
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		lo, hi, isRange := strings.Cut(part, "-")
		a, err := strconv.Atoi(strings.TrimSpace(lo))
		b := a
		if err == nil && isRange {
			b, err = strconv.Atoi(strings.TrimSpace(hi))
		}
		if err != nil || a < 100 || b > 599 || a > b {
			return nil, fmt.Errorf("%q: codes (100 to 599) or ranges of them, like 200-399", part)
		}
		out = append(out, [2]int{a, b})
	}
	return out, nil
}

func statusOK(spec string, code int) bool {
	rs, _ := parseStatus(spec)
	for _, r := range rs {
		if code >= r[0] && code <= r[1] {
			return true
		}
	}
	return false
}

// check runs one health check on replica m: whether it passed, and what it found.
func check(h Health, m Machine) (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(h.Timeout))
	defer cancel()
	if h.HTTP != nil {
		return checkHTTP(ctx, m.Socket, *h.HTTP)
	}
	return checkCmd(ctx, m, h.Cmd, time.Duration(h.Timeout))
}

func checkHTTP(ctx context.Context, sock string, c HTTPCheck) (bool, string) {
	what := fmt.Sprintf("GET :%d%s", c.Port, c.Path)
	tr := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return connectGuest(ctx, sock, c.Port)
		},
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://localhost:%d%s", c.Port, c.Path), nil)
	if err != nil {
		return false, fmt.Sprintf("%s: %v", what, err)
	}
	req.Header.Set("User-Agent", "snowglobe-health")
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return false, what + ": no answer in time"
		}
		return false, fmt.Sprintf("%s: %v", what, err)
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	return statusOK(c.Status, resp.StatusCode), fmt.Sprintf("%s: %d", what, resp.StatusCode)
}

// connectGuest is control.Connect, given up when ctx is.
func connectGuest(ctx context.Context, sock string, port int) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, 1)
	go func() {
		c, err := control.Connect(sock, port)
		ch <- result{c, err}
	}()
	select {
	case r := <-ch:
		return r.c, r.err
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.c != nil {
				r.c.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

func checkCmd(ctx context.Context, m Machine, cmd string, timeout time.Duration) (bool, string) {
	// Straight to the machine, not runJob: a check is not a job anyone ran (no metrics, no events)
	r, err := control.JobLimited(ctx, m.Socket, m.Name, control.JobRequest{Cmd: cmd, Timeout: timeout.Seconds()}, 4<<10)
	switch {
	case err != nil && ctx.Err() != nil, err == nil && r.TimedOut:
		return false, "cmd: no answer in time"
	case err != nil:
		return false, fmt.Sprintf("cmd: %v", err)
	case r.Status == nil:
		return false, "cmd: no exit status"
	}
	msg := fmt.Sprintf("cmd: exit %d", *r.Status)
	if last := lastLine(r.Output); last != "" {
		msg += ": " + last
	}
	return *r.Status == 0, msg
}

// lastLine is the last line of output with something on it, cut to 200 bytes.
func lastLine(out []byte) string {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	l := strings.TrimSpace(lines[len(lines)-1])
	if len(l) > 200 {
		l = l[:200] + "…"
	}
	return l
}

// watched is what a health check is on: a service (each of its replicas) or a machine.
type watched struct {
	kind   string // KindService or KindMachine
	name   string
	health Health
	// A service's own record
	svc Service
	// A machine about to expire (ttl) isn't checked any more
	expires *time.Time
	// Its supervisor restarts it when it fails, rather than its own heal
	supervised bool
}

// key is its heals' key: a service's name, or machine:NAME (a name has no colon).
func (w watched) key() string {
	if w.kind == KindMachine {
		return "machine:" + w.name
	}
	return w.name
}

func (w watched) subject() string { return w.kind + " " + w.name }

// event is the kind of an event about one of its replicas (a service's) or about it (a machine).
func (w watched) event(what string) string {
	if w.kind == KindMachine {
		return "machine." + what
	}
	return "service.replica_" + what
}

// who names the machine checked in an event's message.
func (w watched) who(m string) string {
	if w.kind == KindMachine {
		return "machine " + m
	}
	return "replica " + m
}

// copyHealth is a copy of h that shares nothing with it.
func copyHealth(h *Health) *Health {
	if h == nil {
		return nil
	}
	c := *h
	if h.HTTP != nil {
		hc := *h.HTTP
		c.HTTP = &hc
	}
	return &c
}

// machineHealth is a machine's own health check, checked and filled in: heal none by default,
// and none or hook only (a machine isn't one of many to replace: its supervisor restarts it).
func machineHealth(h *Health) (*Health, error) {
	c := copyHealth(h)
	switch c.Heal {
	case "":
		c.Heal = HealNone
	case HealDrain, HealReplace:
		return nil, errStatus(400, "health: heal %s: a machine heals by none or hook; put it under a supervisor to have it restarted", c.Heal)
	}
	if err := checkHealth(c); err != nil {
		return nil, err
	}
	return c, nil
}

// NormalHealth is a health check as the daemon keeps it, its defaults filled in, for a service or
// template (kind service or template) or a machine: what to compare one in a file with.
func NormalHealth(kind string, h *Health) (*Health, error) {
	if h == nil {
		return nil, nil
	}
	if kind == KindMachine {
		return machineHealth(h)
	}
	c := copyHealth(h)
	if err := checkHealth(c); err != nil {
		return nil, err
	}
	return c, nil
}

// serviceHealthLocked is the health check a service's replicas have: its own, else its
// template's. s.mu is held.
func (s *Server) serviceHealthLocked(svc *Service) *Health {
	if svc.Health != nil {
		return svc.Health
	}
	if t := s.st.Templates[svc.Template]; t != nil {
		return t.Health
	}
	return nil
}

// machineHealthLocked is the health check a machine (not a replica) has: its own, else its
// template's, healed by hook or none (a template's replace and drain are for its services'
// replicas). s.mu is held.
func (s *Server) machineHealthLocked(m *Machine) *Health {
	if m.Labels[serviceLabel] != "" {
		return nil
	}
	if m.Health != nil {
		return m.Health
	}
	t := s.st.Templates[m.Template]
	if t == nil || t.Health == nil {
		return nil
	}
	c := copyHealth(t.Health)
	if c.Heal != HealHook {
		c.Heal, c.HealCmd = HealNone, ""
	}
	return c
}

// watch starts keeping a new replica's health (its service checks it), and checks it at once.
func (s *Server) watch(svc Service, m Machine) {
	s.mu.Lock()
	h := s.serviceHealthLocked(&svc)
	supervised := s.supervisorOfLocked(KindService, svc.Name) != nil
	s.mu.Unlock()
	if h == nil {
		return
	}
	w := watched{kind: KindService, name: svc.Name, health: *h, svc: svc, supervised: supervised}
	s.svc.mu.Lock()
	rh := s.newHealthLocked(svc.Name, m.Name)
	rh.probing = true
	s.svc.mu.Unlock()
	go s.runProbe(w, m, rh)
}

// newHealthLocked starts a replica's (or machine's) health record. s.svc.mu is held.
func (s *Server) newHealthLocked(service, machine string) *replicaHealth {
	now := time.Now()
	h := &replicaHealth{ReplicaHealth: ReplicaHealth{State: Starting, Since: now}, service: service, started: now, ready: make(chan struct{})}
	s.svc.health[machine] = h
	return h
}

// forget drops a stopped replica's activity and health (whatever waits for it to be ready goes on).
func (s *Server) forget(machine string) {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	delete(s.svc.activity, machine)
	if h := s.svc.health[machine]; h != nil {
		h.markReady()
		delete(s.svc.health, machine)
	}
}

// out says whether a replica is out of service (draining): nothing more goes to it, and it
// doesn't count towards its service's replicas. s.svc.mu is held.
func (s *Server) outLocked(machine string) bool {
	h := s.svc.health[machine]
	return h != nil && h.State == Draining
}

// inService are a service's replicas that aren't out of it.
func (s *Server) inService(rs []Machine) (in, out []Machine) {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	for _, m := range rs {
		if s.outLocked(m.Name) {
			out = append(out, m)
		} else {
			in = append(in, m)
		}
	}
	return in, out
}

// unsaved says whether a replica failed its check: its state is not to be kept.
func (s *Server) unsaved(machine string) bool {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	h := s.svc.health[machine]
	return h != nil && (h.State == Unhealthy || h.State == Draining)
}

// waitReady waits (up to its service's grace) for a new replica to pass a check, when its
// service says to.
func (s *Server) waitReady(h *Health, machine string) {
	if h == nil || !h.WaitReady {
		return
	}
	s.svc.mu.Lock()
	rh := s.svc.health[machine]
	s.svc.mu.Unlock()
	if rh == nil {
		return
	}
	select {
	case <-rh.ready:
	case <-time.After(time.Duration(h.Grace)):
	}
}

// startsFresh says whether a service's next replica starts from its template, its last save
// having failed its check (state keep).
func (s *Server) startsFresh(service string) bool {
	s.svc.mu.Lock()
	defer s.svc.mu.Unlock()
	st := s.svc.heals[service]
	return st != nil && st.fresh
}

// probe checks the replicas and machines that are due, in the background, and heals the
// unhealthy ones that may be healed now (a supervised one is its supervisor's). It forgets what
// is gone.
func (s *Server) probe() {
	type target struct {
		w  watched
		rs []Machine
	}
	var targets []target
	s.mu.Lock()
	var svcs []watched
	for _, svc := range s.st.Services {
		if h := s.serviceHealthLocked(svc); h != nil {
			svcs = append(svcs, watched{kind: KindService, name: svc.Name, health: *h, svc: *svc,
				supervised: s.supervisorOfLocked(KindService, svc.Name) != nil})
		}
	}
	for _, m := range s.st.Machines {
		if h := s.machineHealthLocked(m); h != nil {
			targets = append(targets, target{w: watched{kind: KindMachine, name: m.Name, health: *h, expires: m.Expires,
				supervised: s.supervisorOfLocked(KindMachine, m.Name) != nil}, rs: []Machine{*m}})
		}
	}
	s.mu.Unlock()
	for _, w := range svcs {
		targets = append(targets, target{w: w, rs: s.replicas(w.name)})
	}
	now := time.Now()
	type job struct {
		w watched
		m Machine
		h *replicaHealth
	}
	var probes, heals []job
	live := map[string]bool{}
	keys := map[string]bool{}
	for _, t := range targets {
		w, rs := t.w, t.rs
		keys[w.key()] = true
		hc := w.health
		s.svc.mu.Lock()
		in := 0
		for _, m := range rs {
			if !s.outLocked(m.Name) {
				in++
			}
		}
		st := s.svc.heals[w.key()]
		for _, m := range rs {
			live[m.Name] = true
			h := s.svc.health[m.Name]
			if h == nil {
				// One the daemon didn't start (it came back with it), or a machine: from now
				h = s.newHealthLocked(w.svc.Name, m.Name)
			}
			a := s.svc.activity[m.Name]
			if h.probing || h.healing || h.State == Draining || a != nil && a.stopping {
				continue
			}
			if h.State == Unhealthy && !w.supervised && hc.Heal != HealNone && (st == nil || !st.degraded && !now.Before(st.next)) {
				h.healing = true
				heals = append(heals, job{w, m, h})
				// One heal at a time: what is left waits for this one's backoff
				if st == nil {
					st = &serviceHeal{}
					s.svc.heals[w.key()] = st
				}
				st.next = now.Add(time.Hour)
				continue
			}
			every := time.Duration(hc.Interval)
			if h.State == Starting {
				// Not yet passed: checked often, so that it is known (and waited for) soon
				every = min(every, time.Second)
			}
			if now.Sub(h.Checked) < every {
				continue
			}
			// About to stop for being idle (above the minimum), or at its ttl: left alone
			if w.kind == KindService && in > w.svc.Min && a != nil && a.active == 0 && now.Sub(a.last) > time.Duration(w.svc.Idle)-every {
				continue
			}
			if w.expires != nil && w.expires.Sub(now) < every {
				continue
			}
			h.probing = true
			probes = append(probes, job{w, m, h})
		}
		s.svc.mu.Unlock()
	}
	s.svc.mu.Lock()
	for n, h := range s.svc.health {
		if !live[n] {
			h.markReady()
			delete(s.svc.health, n)
		}
	}
	for n := range s.svc.heals {
		if !keys[n] {
			delete(s.svc.heals, n)
		}
	}
	s.svc.mu.Unlock()
	for _, j := range probes {
		go s.runProbe(j.w, j.m, j.h)
	}
	for _, j := range heals {
		go s.heal(j.w, j.m, j.h)
	}
}

// runProbe checks a replica (or machine) once and takes in what it found.
func (s *Server) runProbe(w watched, m Machine, h *replicaHealth) {
	ok, msg := check(w.health, m)
	now := time.Now()
	s.svc.mu.Lock()
	h.probing = false
	if s.svc.health[m.Name] != h || h.State == Draining {
		// Gone, or out of service, meanwhile
		s.svc.mu.Unlock()
		return
	}
	h.Checked, h.Last = now, msg
	var event, detail string
	failed := false
	if ok {
		h.Failures = 0
		if h.State != Healthy {
			if h.State == Unhealthy {
				event, detail = w.event("healthy"), fmt.Sprintf("%s healthy again: %s", w.who(m.Name), msg)
			} else {
				event, detail = w.event("healthy"), fmt.Sprintf("%s healthy in %d ms: %s", w.who(m.Name), now.Sub(h.started).Milliseconds(), msg)
			}
			h.State, h.Since = Healthy, now
		}
		h.markReady()
		// One that works: its heals start over
		if st := s.svc.heals[w.key()]; st != nil {
			if st.degraded {
				kind := "service.healthy"
				if w.kind == KindMachine {
					kind = "machine.healthy"
				}
				event, detail = kind, fmt.Sprintf("%s passed its check: healing again", w.who(m.Name))
			}
			delete(s.svc.heals, w.key())
		}
	} else {
		inGrace := h.State == Starting && now.Sub(h.started) < time.Duration(w.health.Grace)
		if !inGrace {
			h.markReady()
			h.Failures++
			if h.Failures >= w.health.Failures && h.State != Unhealthy {
				h.State, h.Since = Unhealthy, now
				event, detail = w.event("unhealthy"), fmt.Sprintf("%s failed %d checks in a row: %s", w.who(m.Name), h.Failures, msg)
				failed = true
			}
		}
	}
	s.svc.mu.Unlock()
	if event != "" {
		s.note(event, w.subject(), "%s", detail)
	}
	if failed && w.supervised {
		replica := ""
		if w.kind == KindService {
			replica = m.Name
		}
		s.childFailed(w.kind, w.name, failUnhealthy, msg, replica, nil)
	}
}

// heal does what a health check says to an unhealthy replica (or machine), unless it has healed
// too often in a row: then it gives up (degraded) until one passes a check.
func (s *Server) heal(w watched, m Machine, h *replicaHealth) {
	hc := w.health
	s.svc.mu.Lock()
	st := s.svc.heals[w.key()]
	if st == nil {
		// Another passed meanwhile (which starts heals over): this one is still unhealthy
		st = &serviceHeal{}
		s.svc.heals[w.key()] = st
	}
	st.attempts++
	if st.attempts > maxHeals {
		st.degraded = true
		h.healing = false
		s.svc.mu.Unlock()
		kind := "service.degraded"
		if w.kind == KindMachine {
			kind = "machine.degraded"
		}
		s.note(kind, w.subject(), "healed %d times in a row with no check passing: healing stopped until one does", maxHeals)
		return
	}
	backoff := time.Duration(hc.Interval) << (st.attempts - 1)
	st.next = time.Now().Add(min(backoff, maxHealBackoff))
	if w.kind == KindService && w.svc.State == "keep" && st.attempts >= 2 {
		// Its last save failed too: the next one starts from the template
		st.fresh = true
	}
	strategy := hc.Heal
	if strategy == HealHook && h.hooked {
		// Its hook didn't help: a replica is replaced, a machine stays as it is
		strategy = HealReplace
		if w.kind == KindMachine {
			strategy = HealNone
		}
	}
	switch strategy {
	case HealHook:
		h.hooked = true
	case HealDrain, HealReplace:
		h.State, h.Since = Draining, time.Now()
	case HealNone:
		h.healing = false
	}
	attempt := st.attempts
	s.svc.mu.Unlock()

	switch strategy {
	case HealNone:
		s.note("machine.unhealthy", w.subject(), "its heal command didn't help: it stays as it is (a supervisor would restart it)")
	case HealHook:
		ctx, cancel := context.WithTimeout(context.Background(), healTimeout)
		r, err := control.JobLimited(ctx, m.Socket, m.Name, control.JobRequest{Cmd: hc.HealCmd, Timeout: healTimeout.Seconds()}, 4<<10)
		cancel()
		result := ""
		switch {
		case err != nil:
			result = err.Error()
		case r.Status != nil:
			result = fmt.Sprintf("exit %d", *r.Status)
		default:
			result = "no exit status"
		}
		s.svc.mu.Lock()
		// Checked again from the start, with a grace of its own
		now := time.Now()
		h.State, h.Since, h.Failures, h.started, h.Checked, h.healing = Starting, now, 0, now, time.Time{}, false
		s.svc.mu.Unlock()
		s.note(w.event("healing"), w.subject(), "%s: ran its heal command (%s), checking it again (heal %d of %d)", w.who(m.Name), result, attempt, maxHeals)
	case HealDrain:
		// Its idle time starts now: there is that long to look at it
		s.touch(m.Name, 0)
		s.note("service.replica_drained", w.subject(), "replica %s out of service, kept to be looked at until it is idle (heal %d of %d)", m.Name, attempt, maxHeals)
		s.svc.mu.Lock()
		h.healing = false
		s.svc.mu.Unlock()
		s.healTopUp(w.svc)
	case HealReplace:
		s.note("service.replica_draining", w.subject(), "replica %s out of service, replacing it (heal %d of %d)", m.Name, attempt, maxHeals)
		// Below its minimum without it: another at once, before this one goes
		s.healTopUp(w.svc)
		s.drainReplica(m.Name, time.Duration(hc.Drain))
		if s.stopReplica(w.svc, m, true) {
			s.note("service.replica_replaced", w.subject(), "replica %s stopped, not saved", m.Name)
		}
		s.svc.mu.Lock()
		h.healing = false
		s.svc.mu.Unlock()
		s.healTopUp(w.svc)
	}
}

// drainReplica waits (up to d) for a replica's connections to end.
func (s *Server) drainReplica(machine string, d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		s.svc.mu.Lock()
		a := s.svc.activity[machine]
		busy := a != nil && a.active > 0
		s.svc.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// HealService starts a service's healing over, as a replica passing its check would: it is no
// longer degraded, its backoff is gone, its replicas' hooks are tried again and a keep service
// starts from its snapshot again. Its unhealthy replicas are healed on the next tick.
func (s *Server) HealService(name string) error {
	s.mu.Lock()
	svc, ok := s.st.Services[name]
	var health *Health
	if ok {
		health = s.serviceHealthLocked(svc)
	}
	s.mu.Unlock()
	if !ok {
		return errStatus(404, "no service called %s", name)
	}
	if health == nil {
		return errStatus(400, "service %s has no health check to heal by", name)
	}
	s.svc.mu.Lock()
	st := s.svc.heals[name]
	was := st != nil && st.degraded
	delete(s.svc.heals, name)
	unhealthy := 0
	for _, h := range s.svc.health {
		if h.service == name {
			h.hooked = false
			if h.State == Unhealthy {
				unhealthy++
			}
		}
	}
	s.svc.mu.Unlock()
	state := "not degraded"
	if was {
		state = "was degraded"
	}
	s.note("service.heal_reset", "service "+name, "healing started over (%s), %d unhealthy replicas to heal", state, unhealthy)
	return nil
}

func (s *Server) healTopUp(svc Service) {
	if svc.Min == 0 {
		// At zero, the next use starts one
		return
	}
	if err := s.topUp(svc.Name, svc.Min, true); err != nil {
		s.o.Logf("%v", err)
	}
}

// serviceHealth sums up a service's replicas' health.
func serviceHealth(rs []Replica, degraded bool) string {
	if degraded {
		return ServiceDegraded
	}
	if len(rs) == 0 {
		return ServiceIdle
	}
	state := Healthy
	for _, r := range rs {
		if r.Health == nil {
			continue
		}
		switch r.Health.State {
		case Unhealthy, Draining:
			return Unhealthy
		case Starting:
			state = Starting
		}
	}
	return state
}

// CheckHealth says what is wrong with a health check, as adding a service with it would (it is
// left as it is: the defaults are filled in on a copy).
func CheckHealth(h *Health) error {
	if h == nil {
		return nil
	}
	c := *h
	if h.HTTP != nil {
		hc := *h.HTTP
		c.HTTP = &hc
	}
	return checkHealth(&c)
}
