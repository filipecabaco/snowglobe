package daemon

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// supervised is a daemon for supervisor tests: fast checks, fast reaping, template t.
func supervised(t *testing.T) *daemonUnderTest {
	t.Helper()
	old := reapEvery
	reapEvery = 50 * time.Millisecond
	t.Cleanup(func() { reapEvery = old })
	d, _ := serviceDaemon(t)
	fastProbes(t)
	return d
}

// upChecked ups machines checked by checkpid (each fails while its SOCK.fail-PID is there).
func upChecked(t *testing.T, c *Client, names ...string) {
	t.Helper()
	for _, n := range names {
		if _, err := c.Up(Up{Template: "t", Name: n, Health: quick(Health{Cmd: "checkpid"})}); err != nil {
			t.Fatal(err)
		}
	}
}

func pidOf(t *testing.T, c *Client, name string) int {
	t.Helper()
	m, err := c.Machine(name)
	if err != nil {
		return 0
	}
	return m.Pid
}

func machineState(t *testing.T, c *Client, name string) string {
	t.Helper()
	m, err := c.Machine(name)
	if err != nil || m.Checks == nil {
		return ""
	}
	return m.Checks.State
}

// failMachine makes a machine's present process fail its checkpid check.
func failMachine(t *testing.T, c *Client, name string) {
	t.Helper()
	m, err := c.Machine(name)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(fmt.Sprintf("%s.fail-%d", m.Socket, m.Pid), nil, 0o600)
}

func children(cs ...string) []Child {
	var out []Child
	for _, c := range cs {
		kind, rest, _ := strings.Cut(c, "/")
		name, restart, _ := strings.Cut(rest, ":")
		out = append(out, Child{Kind: kind, Name: name, Restart: restart})
	}
	return out
}

// strategyRestarts fails child failed of a supervisor with strategy over machines a, b, c, and
// says which were restarted.
func strategyRestarts(t *testing.T, strategy, failed string) map[string]bool {
	d := supervised(t)
	c := d.c
	upChecked(t, c, "a", "b", "c")
	for _, n := range []string{"a", "b", "c"} {
		waitFor(t, func() bool { return machineState(t, c, n) == Healthy })
	}
	if _, err := c.AddSupervisor(Supervisor{Name: "app", Strategy: strategy, Children: children("machine/a", "machine/b", "machine/c")}); err != nil {
		t.Fatal(err)
	}
	before := map[string]int{}
	for _, n := range []string{"a", "b", "c"} {
		before[n] = pidOf(t, c, n)
	}
	failMachine(t, c, failed)
	waitFor(t, func() bool { p := pidOf(t, c, failed); return p != 0 && p != before[failed] })
	// Each restarted one is up again, and healthy: its new process passes
	for _, n := range []string{"a", "b", "c"} {
		waitFor(t, func() bool { return machineState(t, c, n) == Healthy })
	}
	got := map[string]bool{}
	for _, n := range []string{"a", "b", "c"} {
		got[n] = pidOf(t, c, n) != before[n]
	}
	if st, err := c.Supervisor("app"); err != nil || st.State != SupervisorRunning || st.Restarts != 1 {
		t.Errorf("supervisor: %+v %v", st, err)
	}
	return got
}

func TestOneForOneRestartsTheFailedChildAlone(t *testing.T) {
	got := strategyRestarts(t, OneForOne, "b")
	if !got["b"] || got["a"] || got["c"] {
		t.Errorf("restarted: %v", got)
	}
}

func TestRestForOneRestartsTheFailedChildAndThoseAfterIt(t *testing.T) {
	got := strategyRestarts(t, RestForOne, "b")
	if got["a"] || !got["b"] || !got["c"] {
		t.Errorf("restarted: %v", got)
	}
}

func TestOneForAllRestartsEveryChild(t *testing.T) {
	got := strategyRestarts(t, OneForAll, "c")
	if !got["a"] || !got["b"] || !got["c"] {
		t.Errorf("restarted: %v", got)
	}
}

func TestAMachineWhoseProcessEndsIsStartedAgainWithItsLinks(t *testing.T) {
	d := supervised(t)
	c := d.c
	for _, n := range []string{"db", "job", "web"} {
		if _, err := c.Up(Up{Template: "t", Name: n}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.AddLink(Link{From: "web", FromKind: KindMachine, To: "db", ToKind: KindMachine, Port: 5432}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddSupervisor(Supervisor{Name: "app", Children: children("machine/db", "machine/job:transient")}); err != nil {
		t.Fatal(err)
	}
	db, job := pidOf(t, c, "db"), pidOf(t, c, "job")
	syscall.Kill(db, syscall.SIGKILL)
	syscall.Kill(job, syscall.SIGKILL)
	// Permanent: up again, as it was, and still linked to
	waitFor(t, func() bool { p := pidOf(t, c, "db"); return p != 0 && p != db })
	ls, err := c.Links()
	if err != nil || len(ls) != 1 || ls[0].To != "db" {
		t.Errorf("links: %+v %v", ls, err)
	}
	// Transient: its process ending is a normal exit
	waitFor(t, func() bool { _, err := c.Machine("job"); return NotFound(err) })
	time.Sleep(300 * time.Millisecond)
	if _, err := c.Machine("job"); !NotFound(err) {
		t.Errorf("job started again: %v", err)
	}
}

func TestATemporaryChildFailingRestartsNothing(t *testing.T) {
	d := supervised(t)
	c := d.c
	upChecked(t, c, "a", "b")
	waitFor(t, func() bool { return machineState(t, c, "a") == Healthy && machineState(t, c, "b") == Healthy })
	if _, err := c.AddSupervisor(Supervisor{Name: "app", Strategy: OneForAll, Children: children("machine/a:temporary", "machine/b")}); err != nil {
		t.Fatal(err)
	}
	a, b := pidOf(t, c, "a"), pidOf(t, c, "b")
	failMachine(t, c, "a")
	waitFor(t, func() bool { return machineState(t, c, "a") == Unhealthy })
	time.Sleep(300 * time.Millisecond)
	if pidOf(t, c, "a") != a || pidOf(t, c, "b") != b {
		t.Errorf("restarted: a %d→%d, b %d→%d", a, pidOf(t, c, "a"), b, pidOf(t, c, "b"))
	}
}

func TestTooManyRestartsEscalateThenDegrade(t *testing.T) {
	d := supervised(t)
	c := d.c
	// x fails every check, whatever process it is
	if _, err := c.Up(Up{Template: "t", Name: "x", Health: quick(Health{Cmd: "false"})}); err != nil {
		t.Fatal(err)
	}
	upChecked(t, c, "y")
	waitFor(t, func() bool { return machineState(t, c, "y") == Healthy })
	if _, err := c.AddSupervisor(Supervisor{Name: "inner", Children: children("machine/x"), MaxRestarts: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddSupervisor(Supervisor{Name: "outer", Strategy: OneForAll, Children: children("supervisor/inner", "machine/y"), MaxRestarts: 1}); err != nil {
		t.Fatal(err)
	}
	if st, _ := c.Supervisor("inner"); st.Parent != "outer" {
		t.Errorf("inner's parent: %q", st.Parent)
	}
	y := pidOf(t, c, "y")
	// inner restarts x once, then fails: outer restarts all it has (y too), once; then it gives up
	waitFor(t, func() bool { p := pidOf(t, c, "y"); return p != 0 && p != y })
	waitFor(t, func() bool { st, _ := c.Supervisor("outer"); return st.State == SupervisorDegraded })
	// Restarted by hand: no longer degraded, and at it again
	st, err := c.RestartSupervisor("outer")
	if err != nil || st.State != SupervisorRunning {
		t.Fatalf("restart: %+v %v", st, err)
	}
	waitFor(t, func() bool { st, _ := c.Supervisor("outer"); return st.State == SupervisorDegraded })
}

func TestASupervisedServiceHasItsFailedReplicaRestarted(t *testing.T) {
	d := supervised(t)
	c := d.c
	// heal none: had the service healed it, nothing would happen
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1, Health: quick(Health{Cmd: "checkpid", Heal: HealNone})}); err != nil {
		t.Fatal(err)
	}
	upChecked(t, c, "after")
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) && machineState(t, c, "after") == Healthy })
	if _, err := c.AddSupervisor(Supervisor{Name: "app", Strategy: RestForOne, Children: children("service/api", "machine/after")}); err != nil {
		t.Fatal(err)
	}
	if s, _ := c.Service("api"); s.Supervisor != "app" {
		t.Errorf("service's supervisor: %q", s.Supervisor)
	}
	old := running(t, c, "api")[0].Machine
	after := pidOf(t, c, "after")
	failMachine(t, c, old)
	// Its replica replaced, and what comes after it restarted
	waitFor(t, func() bool { rs := running(t, c, "api"); return len(rs) == 1 && rs[0].Machine != old })
	waitFor(t, func() bool { p := pidOf(t, c, "after"); return p != 0 && p != after })
}

func TestASupervisorIsChecked(t *testing.T) {
	d := supervised(t)
	c := d.c
	upChecked(t, c, "a")
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddSupervisor(Supervisor{Name: "one", Children: children("machine/a")}); err != nil {
		t.Fatal(err)
	}
	replica := running(t, c, "api")[0].Machine
	for name, bad := range map[string]Supervisor{
		"no children":       {Name: "s"},
		"a strategy":        {Name: "s", Strategy: "all_for_none", Children: children("service/api")},
		"a restart type":    {Name: "s", Children: children("service/api:sometimes")},
		"a missing child":   {Name: "s", Children: children("machine/nope")},
		"a taken child":     {Name: "s", Children: children("machine/a")},
		"a replica":         {Name: "s", Children: children("machine/" + replica)},
		"itself":            {Name: "s", Children: children("supervisor/s")},
		"a child twice":     {Name: "s", Children: children("service/api", "service/api")},
		"a kind":            {Name: "s", Children: children("template/t")},
		"a short window":    {Name: "s", Children: children("service/api"), MaxSeconds: Duration(time.Millisecond)},
		"negative restarts": {Name: "s", Children: children("service/api"), MaxRestarts: -1},
	} {
		if _, err := c.AddSupervisor(bad); err == nil {
			t.Errorf("%s: taken", name)
		}
	}
	// A circle, through an update
	if _, err := c.AddSupervisor(Supervisor{Name: "two", Children: children("supervisor/one")}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.UpdateSupervisor("one", Supervisor{Children: children("machine/a", "supervisor/two")}); err == nil {
		t.Error("a circle: taken")
	}
	// Defaults, and a change in place
	st, err := c.UpdateSupervisor("one", Supervisor{Strategy: RestForOne, Children: children("machine/a", "service/api:transient")})
	if err != nil || st.Strategy != RestForOne || st.MaxRestarts != 3 || st.MaxSeconds != Duration(time.Minute) ||
		st.Children[0].Restart != Permanent || st.Children[1].Restart != Transient || len(st.States) != 2 {
		t.Errorf("updated: %+v %v", st, err)
	}
	// Removing it leaves its children be
	if err := c.RemoveSupervisor("two"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Machine("a"); err != nil {
		t.Error(err)
	}
}

func TestHealthChangesInPlaceAndComesFromTheTemplate(t *testing.T) {
	d := supervised(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "api", Template: "t", Min: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Up(Up{Template: "t", Name: "m"}); err != nil {
		t.Fatal(err)
	}
	replica := running(t, c, "api")[0].Machine
	// The template's check: its service and machine have none of their own, so they take it
	if err := c.SetHealth(KindTemplate, "t", quick(Health{Cmd: "check", Heal: HealReplace}), nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return onlyReplica(t, c, "api", Healthy) && machineState(t, c, "m") == Healthy })
	s, _ := c.Service("api")
	if s.Health != nil || s.InheritedHealth == nil || s.InheritedHealth.Cmd != "check" {
		t.Errorf("service: own %+v, inherited %+v", s.Health, s.InheritedHealth)
	}
	// A service's own, changed in place: the same replica, checked anew
	if err := c.SetHealth(KindService, "api", quick(Health{Cmd: "false"}), map[string]string{"k": "v"}); err != nil {
		t.Fatal(err)
	}
	s, _ = c.Service("api")
	if s.Health == nil || s.Health.Cmd != "false" || s.Labels["k"] != "v" || len(s.Replicas) != 1 || s.Replicas[0].Machine != replica {
		t.Errorf("service: %+v", s)
	}
	// A machine's: none and hook only (its supervisor restarts it), none by default
	if err := c.SetHealth(KindMachine, "m", &Health{Cmd: "check", Heal: HealReplace}, nil); err == nil {
		t.Error("a machine healed by replace: taken")
	}
	if err := c.SetHealth(KindMachine, replica, &Health{Cmd: "check"}, nil); err == nil {
		t.Error("a replica's own: taken")
	}
	if err := c.SetHealth(KindMachine, "m", &Health{Cmd: "check"}, nil); err != nil {
		t.Fatal(err)
	}
	m, _ := c.Machine("m")
	if m.Health == nil || m.Health.Heal != HealNone {
		t.Errorf("machine's health: %+v", m.Health)
	}
	if _, err := c.Up(Up{Template: "t", Name: "n", Health: &Health{Cmd: "check", Heal: HealDrain}}); err == nil {
		t.Error("up a machine healed by drain: taken")
	}
	// None
	if err := c.SetHealth(KindService, "api", nil, nil); err != nil {
		t.Fatal(err)
	}
	if s, _ := c.Service("api"); s.Health != nil || s.InheritedHealth == nil {
		t.Errorf("removed: own %+v, inherited %+v", s.Health, s.InheritedHealth)
	}
}
