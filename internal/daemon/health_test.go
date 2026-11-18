package daemon

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// fastProbes lets checks run every 100 ms
func fastProbes(t *testing.T) {
	old := minProbeInterval
	minProbeInterval = 10 * time.Millisecond
	t.Cleanup(func() { minProbeInterval = old })
}

// quick is a health check for the tests: checked every 100 ms, unhealthy after 2 failures, no
// grace to speak of.
func quick(h Health) *Health {
	h.Interval, h.Timeout, h.Failures, h.Grace = Duration(100*time.Millisecond), Duration(100*time.Millisecond), 2, Duration(time.Millisecond)
	if h.Drain == 0 {
		h.Drain = Duration(time.Millisecond)
	}
	return &h
}

// socketOf is a replica's control socket: what the fake machine keeps its health files beside.
func socketOf(t *testing.T, c *Client, machine string) string {
	t.Helper()
	m, err := c.Machine(machine)
	if err != nil {
		t.Fatal(err)
	}
	return m.Socket
}

func healthOf(t *testing.T, c *Client, svc string) (string, []Replica) {
	t.Helper()
	s, err := c.Service(svc)
	if err != nil {
		t.Fatal(err)
	}
	return s.ServiceHealth, s.Replicas
}

func onlyReplica(t *testing.T, c *Client, svc, state string) bool {
	t.Helper()
	_, rs := healthOf(t, c, svc)
	return len(rs) == 1 && rs[0].Health != nil && rs[0].Health.State == state
}

func TestAHealthCheckIsCheckedAndFilledIn(t *testing.T) {
	fastProbes(t)
	h := Health{HTTP: &HTTPCheck{Port: 8080}}
	if err := checkHealth(&h); err != nil {
		t.Fatal(err)
	}
	if h.HTTP.Path != "/" || h.HTTP.Status != "200-399" || h.Interval != Duration(10*time.Second) || h.Timeout != Duration(2*time.Second) ||
		h.Failures != 3 || h.Grace != Duration(30*time.Second) || h.Heal != HealReplace || h.Drain != Duration(30*time.Second) {
		t.Errorf("defaults: %+v %+v", h, *h.HTTP)
	}
	for name, bad := range map[string]Health{
		"neither":             {},
		"both":                {HTTP: &HTTPCheck{Port: 80}, Cmd: "true"},
		"no port":             {HTTP: &HTTPCheck{}},
		"a path without /":    {HTTP: &HTTPCheck{Port: 80, Path: "up"}},
		"a status that isn't": {HTTP: &HTTPCheck{Port: 80, Status: "2xx"}},
		"a status backwards":  {HTTP: &HTTPCheck{Port: 80, Status: "399-200"}},
		"too often":           {Cmd: "true", Interval: Duration(time.Millisecond)},
		"a timeout too long":  {Cmd: "true", Interval: Duration(time.Second), Timeout: Duration(2 * time.Second)},
		"a heal it hasn't":    {Cmd: "true", Heal: "reboot"},
		"a hook with no cmd":  {Cmd: "true", Heal: HealHook},
		"a heal_cmd unused":   {Cmd: "true", Heal: HealReplace, HealCmd: "x"},
	} {
		if err := checkHealth(&bad); err == nil {
			t.Errorf("%s: taken", name)
		}
	}
	for spec, want := range map[string]map[int]bool{
		"200-399":     {200: true, 302: true, 399: true, 400: false, 500: false},
		"200, 204":    {200: true, 204: true, 201: false},
		"200,500-503": {502: true, 504: false},
	} {
		for code, ok := range want {
			if statusOK(spec, code) != ok {
				t.Errorf("%s %d: %v", spec, code, !ok)
			}
		}
	}
}

func TestAnHTTPCheckGoesByTheStatusNotTheConnection(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	// Heal none: said, nothing done
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Health: quick(Health{HTTP: &HTTPCheck{Port: 8080, Path: "/healthz"}, Heal: HealNone})}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) })
	if h, _ := healthOf(t, c, "api"); h != Healthy {
		t.Errorf("service: %s", h)
	}
	_, rs := healthOf(t, c, "api")
	sock := socketOf(t, c, rs[0].Machine)
	if !strings.Contains(rs[0].Health.Last, "GET :8080/healthz: 200") {
		t.Errorf("last: %q", rs[0].Health.Last)
	}
	// The server answers, with a 500: unhealthy
	os.WriteFile(sock+".status", []byte("500"), 0o600)
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Unhealthy) })
	h, rs := healthOf(t, c, "api")
	if h != Unhealthy || rs[0].Health.Failures < 2 || !strings.Contains(rs[0].Health.Last, ": 500") {
		t.Errorf("after a 500: %s %+v", h, rs[0].Health)
	}
	// A redirect is fine by the default status
	os.WriteFile(sock+".status", []byte("302"), 0o600)
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) })
	if _, again := healthOf(t, c, "api"); again[0].Machine != rs[0].Machine {
		t.Errorf("heal none replaced it: %s, was %s", again[0].Machine, rs[0].Machine)
	}
}

func TestHealthChecksLeaveScaleToZeroAlone(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	svc, err := c.AddService(Service{Name: "web", Template: "t", Ports: []Port{{IP: "127.0.0.1", Guest: 80}}, Idle: Duration(time.Second),
		Health: quick(Health{Cmd: "check"})})
	if err != nil {
		t.Fatal(err)
	}
	// At zero, nothing is checked and nothing is started for it
	time.Sleep(300 * time.Millisecond)
	if h, rs := healthOf(t, c, "web"); len(rs) != 0 || h != ServiceIdle {
		t.Fatalf("at zero: %s %+v", h, rs)
	}
	if got := echo(t, svc.Ports[0].Host, "ping"); got != "ping" {
		t.Fatalf("connection: %q", got)
	}
	_, rs := healthOf(t, c, "web")
	sock := socketOf(t, c, rs[0].Machine)
	waitFor(t, func() bool { return onlyReplica(t, c, "web", Healthy) })
	// Checked many times over its idle second, and still stopped by it
	checked := map[string]bool{}
	waitFor(t, func() bool {
		if data, err := os.ReadFile(sock + ".checks"); err == nil {
			checked[string(data)] = true
		}
		return len(running(t, c, "web")) == 0
	})
	if len(checked) < 3 {
		t.Errorf("checked %d times while it ran", len(checked))
	}
	time.Sleep(300 * time.Millisecond)
	if rs := running(t, c, "web"); len(rs) != 0 {
		t.Errorf("started again at zero: %+v", rs)
	}
}

func TestAnUnhealthyReplicaIsReplaced(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Health: quick(Health{Cmd: "check"})}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) })
	_, rs := healthOf(t, c, "api")
	old := rs[0].Machine
	os.WriteFile(socketOf(t, c, old)+".fail", nil, 0o600)
	// Another, kept at the minimum, and the old one gone
	waitFor(t, func() bool {
		_, rs := healthOf(t, c, "api")
		return len(rs) == 1 && rs[0].Machine != old && rs[0].Health != nil && rs[0].Health.State == Healthy
	})
	if _, err := c.Machine(old); !NotFound(err) {
		t.Errorf("the unhealthy replica: %v", err)
	}
	if h, _ := healthOf(t, c, "api"); h != Healthy {
		t.Errorf("service: %s", h)
	}
}

func TestAnUnhealthyReplicaIsNotSaved(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "db", Template: "t", Idle: Duration(time.Second), State: "keep", Health: quick(Health{Cmd: "check"})}); err != nil {
		t.Fatal(err)
	}
	for want := 1; want <= 2; want++ {
		if out := output(t)(c.ServiceJob("db", control.JobRequest{Cmd: "x"})); out != "x: "+string(rune('0'+want))+"\n" {
			t.Fatalf("job %d: %q", want, out)
		}
	}
	waitFor(t, func() bool { return len(running(t, c, "db")) == 0 })
	s, _ := c.Service("db")
	good := s.Saved
	if good == "" {
		t.Fatal("not saved at zero")
	}
	// From the save, a job more; then it goes bad, and is replaced: not saved
	if out := output(t)(c.ServiceJob("db", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Fatalf("after zero: %q", out)
	}
	bad := running(t, c, "db")[0].Machine
	os.WriteFile(socketOf(t, c, bad)+".fail", nil, 0o600)
	waitFor(t, func() bool { _, err := c.Machine(bad); return NotFound(err) })
	if s, _ := c.Service("db"); s.Saved != good {
		t.Errorf("saved the unhealthy replica: %s, was %s", s.Saved, good)
	}
	// The next carries on from the last good save
	if out := output(t)(c.ServiceJob("db", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Errorf("after the replace: %q", out)
	}
}

func TestAHookHealsAReplicaInPlace(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Health: quick(Health{Cmd: "check", Heal: HealHook, HealCmd: "heal"})}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) })
	_, rs := healthOf(t, c, "api")
	m := rs[0].Machine
	sock := socketOf(t, c, m)
	os.WriteFile(sock+".fail", nil, 0o600)
	waitFor(t, func() bool { _, err := os.Stat(sock + ".fail"); return os.IsNotExist(err) })
	// Its heal command took the fault away: the same replica, healthy again
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) })
	if _, rs := healthOf(t, c, "api"); rs[0].Machine != m {
		t.Errorf("replaced (%s, was %s): the hook should have healed it", rs[0].Machine, m)
	}
}

func TestADrainedReplicaGetsNothingAndStopsWhenIdle(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	svc, err := c.AddService(Service{Name: "web", Template: "t", Ports: []Port{{IP: "127.0.0.1", Guest: 80}}, Idle: Duration(time.Second),
		Health: quick(Health{Cmd: "check", Heal: HealDrain})})
	if err != nil {
		t.Fatal(err)
	}
	port := svc.Ports[0].Host
	echo(t, port, "ping")
	waitFor(t, func() bool { return onlyReplica(t, c, "web", Healthy) })
	drained := running(t, c, "web")[0].Machine
	os.WriteFile(socketOf(t, c, drained)+".fail", nil, 0o600)
	waitFor(t, func() bool { return onlyReplica(t, c, "web", Draining) })
	// Out of service, and not counted towards max 1: the next connection starts another
	if got := echo(t, port, "pong"); got != "pong" {
		t.Fatalf("connection: %q", got)
	}
	rs := running(t, c, "web")
	if len(rs) != 2 {
		t.Fatalf("replicas: %+v", rs)
	}
	// The drained one stops once idle; the new one with it, at zero
	waitFor(t, func() bool { _, err := c.Machine(drained); return NotFound(err) })
	waitFor(t, func() bool { return len(running(t, c, "web")) == 0 })
}

func TestAFirstConnectionCanWaitForAReadyReplica(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	h := quick(Health{HTTP: &HTTPCheck{Port: 8080}, WaitReady: true})
	h.Grace = Duration(5 * time.Second)
	if _, err := c.AddService(Service{Name: "api", Template: "t", Health: h}); err != nil {
		t.Fatal(err)
	}
	if out := output(t)(c.ServiceJob("api", control.JobRequest{Cmd: "x"})); out != "x: 1\n" {
		t.Fatalf("job: %q", out)
	}
	// It ran once the replica had passed: healthy as the job ends
	if _, rs := healthOf(t, c, "api"); len(rs) != 1 || rs[0].Health == nil || rs[0].Health.State != Healthy {
		t.Errorf("replica: %+v", rs)
	}
}

func TestAServiceThatNeverHealsIsDegraded(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Health: quick(Health{Cmd: "false"})}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { h, _ := healthOf(t, c, "api"); return h == ServiceDegraded })
	// Given up: the last replica stays, at the minimum, and nothing more is started
	time.Sleep(500 * time.Millisecond)
	if rs := running(t, c, "api"); len(rs) != 1 {
		t.Errorf("replicas: %+v", rs)
	}
}

func TestAnUnhealthyReplicaGetsConnectionsOnlyWhenNoneElseCan(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	// heal none: an unhealthy replica stays, in service
	if _, err := c.AddService(Service{Name: "web", Template: "t", Min: 2, Max: 3, Health: quick(Health{Cmd: "check", Heal: HealNone})}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return count(t, c, "web", Healthy) == 2 })
	rs := running(t, c, "web")
	sick, well := rs[0].Machine, rs[1].Machine
	os.WriteFile(socketOf(t, c, sick)+".fail", nil, 0o600)
	waitFor(t, func() bool { return count(t, c, "web", Unhealthy) == 1 })
	// The one that works takes them all, busier as it gets
	for i := range 3 {
		m, err := d.s.pickReplica("web")
		if err != nil {
			t.Fatal(err)
		}
		defer d.s.touch(m.Name, -1)
		if m.Name != well {
			t.Fatalf("connection %d went to %s, not %s", i, m.Name, well)
		}
	}
	// Both unhealthy, with room under max: a new one rather than either
	os.WriteFile(socketOf(t, c, well)+".fail", nil, 0o600)
	waitFor(t, func() bool { return count(t, c, "web", Unhealthy) == 2 })
	m, err := d.s.pickReplica("web")
	if err != nil {
		t.Fatal(err)
	}
	defer d.s.touch(m.Name, -1)
	if m.Name == sick || m.Name == well {
		t.Fatalf("connection went to unhealthy %s", m.Name)
	}
	// At max: an unhealthy one still beats none
	os.WriteFile(socketOf(t, c, m.Name)+".fail", nil, 0o600)
	waitFor(t, func() bool { return count(t, c, "web", Unhealthy) == 3 })
	again, err := d.s.pickReplica("web")
	if err != nil {
		t.Fatal(err)
	}
	d.s.touch(again.Name, -1)
}

func TestADegradedServiceStartsNoMoreForUnhealthyReplicas(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Max: 3, Health: quick(Health{Cmd: "false"})}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { h, _ := healthOf(t, c, "api"); return h == ServiceDegraded })
	waitFor(t, func() bool { return count(t, c, "api", Unhealthy) == 1 })
	only := running(t, c, "api")[0].Machine
	m, err := d.s.pickReplica("api")
	if err != nil {
		t.Fatal(err)
	}
	d.s.touch(m.Name, -1)
	if m.Name != only {
		t.Errorf("connection went to %s, not the unhealthy %s it has", m.Name, only)
	}
	if rs := running(t, c, "api"); len(rs) != 1 {
		t.Errorf("replicas: %+v", rs)
	}
}

func TestHealingCanBeStartedOver(t *testing.T) {
	d, _ := serviceDaemon(t)
	fastProbes(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Health: quick(Health{Cmd: "false"})}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddService(Service{Name: "plain", Template: "t"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.HealService("nope"); !NotFound(err) {
		t.Errorf("no such service: %v", err)
	}
	if _, err := c.HealService("plain"); err == nil || !strings.Contains(err.Error(), "no health check") {
		t.Errorf("no health check: %v", err)
	}
	waitFor(t, func() bool { h, _ := healthOf(t, c, "api"); return h == ServiceDegraded })
	waitFor(t, func() bool { return count(t, c, "api", Unhealthy) == 1 })
	stuck := running(t, c, "api")[0].Machine
	s, err := c.HealService("api")
	if err != nil {
		t.Fatal(err)
	}
	if s.ServiceHealth == ServiceDegraded {
		t.Errorf("still degraded: %+v", s)
	}
	// Healed again: the stuck replica is replaced
	waitFor(t, func() bool { _, err := c.Machine(stuck); return NotFound(err) })
	// And, failing on, it gives up again
	waitFor(t, func() bool { h, _ := healthOf(t, c, "api"); return h == ServiceDegraded })
}

// count is how many of a service's replicas are in a state.
func count(t *testing.T, c *Client, svc, state string) int {
	t.Helper()
	_, rs := healthOf(t, c, svc)
	n := 0
	for _, r := range rs {
		if r.Health != nil && r.Health.State == state {
			n++
		}
	}
	return n
}
