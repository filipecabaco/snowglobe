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

// watch starts keeping a new replica's health (its service checks it), and checks it at once.
func (s *Server) watch(svc Service, m Machine) {
	if svc.Health == nil {
		return
	}
	s.svc.mu.Lock()
	h := s.newHealthLocked(svc.Name, m.Name)
	h.probing = true
	s.svc.mu.Unlock()
	go s.runProbe(svc, m, h)
}

// newHealthLocked starts a replica's health record. s.svc.mu is held.
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

// probe checks the replicas that are due, in the background, and heals the unhealthy ones whose
// service may be healed now. It forgets what is gone.
func (s *Server) probe() {
	s.mu.Lock()
	var svcs []Service
	for _, svc := range s.st.Services {
		if svc.Health != nil {
			svcs = append(svcs, *svc)
		}
	}
	s.mu.Unlock()
	now := time.Now()
	type job struct {
		svc Service
		m   Machine
		h   *replicaHealth
	}
	var probes, heals []job
	live := map[string]bool{}
	services := map[string]bool{}
	for _, svc := range svcs {
		services[svc.Name] = true
		rs := s.replicas(svc.Name)
		hc := *svc.Health
		s.svc.mu.Lock()
		in := 0
		for _, m := range rs {
			if !s.outLocked(m.Name) {
				in++
			}
		}
		st := s.svc.heals[svc.Name]
		for _, m := range rs {
			live[m.Name] = true
			h := s.svc.health[m.Name]
			if h == nil {
				// One the daemon didn't start as a replica (it came back with it): from now
				h = s.newHealthLocked(svc.Name, m.Name)
			}
			a := s.svc.activity[m.Name]
			if h.probing || h.healing || h.State == Draining || a != nil && a.stopping {
				continue
			}
			if h.State == Unhealthy && hc.Heal != HealNone && (st == nil || !st.degraded && !now.Before(st.next)) {
				h.healing = true
				heals = append(heals, job{svc, m, h})
				// One heal at a time: what is left waits for this one's backoff
				if st == nil {
					st = &serviceHeal{}
					s.svc.heals[svc.Name] = st
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
			// About to stop for being idle (above the minimum): left alone
			if in > svc.Min && a != nil && a.active == 0 && now.Sub(a.last) > time.Duration(svc.Idle)-every {
				continue
			}
			h.probing = true
			probes = append(probes, job{svc, m, h})
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
		if !services[n] {
			delete(s.svc.heals, n)
		}
	}
	s.svc.mu.Unlock()
	for _, j := range probes {
		go s.runProbe(j.svc, j.m, j.h)
	}
	for _, j := range heals {
		go s.heal(j.svc, j.m, j.h)
	}
}

// runProbe checks a replica once and takes in what it found.
func (s *Server) runProbe(svc Service, m Machine, h *replicaHealth) {
	ok, msg := check(*svc.Health, m)
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
	if ok {
		h.Failures = 0
		if h.State != Healthy {
			if h.State == Unhealthy {
				event, detail = "service.replica_healthy", fmt.Sprintf("replica %s healthy again: %s", m.Name, msg)
			} else {
				event, detail = "service.replica_healthy", fmt.Sprintf("replica %s healthy in %d ms: %s", m.Name, now.Sub(h.started).Milliseconds(), msg)
			}
			h.State, h.Since = Healthy, now
		}
		h.markReady()
		// A replica that works: the service's heals start over
		if st := s.svc.heals[svc.Name]; st != nil {
			if st.degraded {
				event, detail = "service.healthy", fmt.Sprintf("replica %s passed its check: healing again", m.Name)
			}
			delete(s.svc.heals, svc.Name)
		}
	} else {
		inGrace := h.State == Starting && now.Sub(h.started) < time.Duration(svc.Health.Grace)
		if !inGrace {
			h.markReady()
			h.Failures++
			if h.Failures >= svc.Health.Failures && h.State != Unhealthy {
				h.State, h.Since = Unhealthy, now
				event, detail = "service.replica_unhealthy", fmt.Sprintf("replica %s failed %d checks in a row: %s", m.Name, h.Failures, msg)
			}
		}
	}
	s.svc.mu.Unlock()
	if event != "" {
		s.note(event, "service "+svc.Name, "%s", detail)
	}
}

// heal does what a service's health says to an unhealthy replica, unless it has healed too
// often in a row: then it gives up (degraded) until one of its replicas passes a check.
func (s *Server) heal(svc Service, m Machine, h *replicaHealth) {
	hc := *svc.Health
	s.svc.mu.Lock()
	st := s.svc.heals[svc.Name]
	if st == nil {
		// Another replica passed meanwhile (which starts heals over): this one is still unhealthy
		st = &serviceHeal{}
		s.svc.heals[svc.Name] = st
	}
	st.attempts++
	if st.attempts > maxHeals {
		st.degraded = true
		h.healing = false
		s.svc.mu.Unlock()
		s.note("service.degraded", "service "+svc.Name, "healed %d times in a row with no replica passing its check: healing stopped until one does", maxHeals)
		return
	}
	backoff := time.Duration(hc.Interval) << (st.attempts - 1)
	st.next = time.Now().Add(min(backoff, maxHealBackoff))
	if svc.State == "keep" && st.attempts >= 2 {
		// Its last save failed too: the next one starts from the template
		st.fresh = true
	}
	strategy := hc.Heal
	if strategy == HealHook && h.hooked {
		// Its hook didn't help
		strategy = HealReplace
	}
	switch strategy {
	case HealHook:
		h.hooked = true
	case HealDrain, HealReplace:
		h.State, h.Since = Draining, time.Now()
	}
	attempt := st.attempts
	s.svc.mu.Unlock()

	switch strategy {
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
		s.note("service.replica_healing", "service "+svc.Name, "replica %s: ran its heal command (%s), checking it again (heal %d of %d)", m.Name, result, attempt, maxHeals)
	case HealDrain:
		// Its idle time starts now: there is that long to look at it
		s.touch(m.Name, 0)
		s.note("service.replica_drained", "service "+svc.Name, "replica %s out of service, kept to be looked at until it is idle (heal %d of %d)", m.Name, attempt, maxHeals)
		s.svc.mu.Lock()
		h.healing = false
		s.svc.mu.Unlock()
		s.healTopUp(svc)
	case HealReplace:
		s.note("service.replica_draining", "service "+svc.Name, "replica %s out of service, replacing it (heal %d of %d)", m.Name, attempt, maxHeals)
		// Below its minimum without it: another at once, before this one goes
		s.healTopUp(svc)
		deadline := time.Now().Add(time.Duration(hc.Drain))
		for time.Now().Before(deadline) {
			s.svc.mu.Lock()
			a := s.svc.activity[m.Name]
			busy := a != nil && a.active > 0
			s.svc.mu.Unlock()
			if !busy {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if s.stopReplica(svc, m, true) {
			s.note("service.replica_replaced", "service "+svc.Name, "replica %s stopped, not saved", m.Name)
		}
		s.svc.mu.Lock()
		h.healing = false
		s.svc.mu.Unlock()
		s.healTopUp(svc)
	}
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
