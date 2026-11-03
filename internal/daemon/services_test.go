package daemon

import (
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// fastScaling looks for idle replicas every 50 ms
func fastScaling(t *testing.T) {
	old := scaleEvery
	scaleEvery = 50 * time.Millisecond
	t.Cleanup(func() { scaleEvery = old })
}

// echo sends s to a service's host port and reads back what comes (the fake machines echo).
func echo(t *testing.T, port int, s string) string {
	t.Helper()
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	c.Write([]byte(s))
	c.(*net.TCPConn).CloseWrite()
	got, _ := io.ReadAll(c)
	return string(got)
}

func running(t *testing.T, c *Client, svc string) []Replica {
	t.Helper()
	s, err := c.Service(svc)
	if err != nil {
		t.Fatal(err)
	}
	return s.Replicas
}

func serviceDaemon(t *testing.T) (*daemonUnderTest, *Template) {
	t.Helper()
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	d := startDaemon(t, shortTemp(t), Options{})
	t.Cleanup(func() { d.stop(t) })
	tpl, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	if err != nil {
		t.Fatal(err)
	}
	return d, tpl
}

func TestAServiceScalesToZeroAndWakesOnAConnection(t *testing.T) {
	d, _ := serviceDaemon(t)
	c := d.c
	svc, err := c.AddService(Service{Name: "web", Template: "t", Ports: []Port{{IP: "127.0.0.1", Guest: 80}}, Idle: Duration(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	port := svc.Ports[0].Host
	if port == 0 || svc.Min != 0 || svc.Max != 1 || svc.State != "discard" || svc.Concurrency != 10 || len(svc.Replicas) != 0 {
		t.Fatalf("service: %+v", svc)
	}

	// At zero: a connection starts a replica and reaches it
	if got := echo(t, port, "ping"); got != "ping" {
		t.Fatalf("first connection: %q", got)
	}
	first := running(t, c, "web")
	if len(first) != 1 {
		t.Fatalf("replicas: %+v", first)
	}
	// Idle a second: back to zero
	waitFor(t, func() bool { return len(running(t, c, "web")) == 0 })
	// Woken again: a new replica, started from the template (discard): nothing of the last one
	if got := echo(t, port, "pong"); got != "pong" {
		t.Errorf("after zero: %q", got)
	}
	if out := output(t)(c.ServiceJob("web", control.JobRequest{Cmd: "x"})); out != "x: 1\n" {
		t.Errorf("a job on it: %q", out)
	}
	if again := running(t, c, "web"); len(again) != 1 || again[0].Machine == first[0].Machine {
		t.Errorf("woken: %+v (was %+v)", again, first)
	}
	// Removed: its port is let go and its replicas stop
	if err := c.RemoveService("web"); err != nil {
		t.Fatal(err)
	}
	if _, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
		t.Error("its port still answers")
	}
	if ms, _ := c.Machines(nil); len(ms) != 0 {
		t.Errorf("machines left: %+v", ms)
	}
}

func TestAServiceThatKeepsStateCarriesItAcrossZero(t *testing.T) {
	d, _ := serviceDaemon(t)
	c := d.c
	if _, err := c.AddService(Service{Name: "db", Template: "t", Idle: Duration(time.Second), State: "keep"}); err != nil {
		t.Fatal(err)
	}
	// Woken by a job, no port needed
	for want := 1; want <= 2; want++ {
		if out := output(t)(c.ServiceJob("db", control.JobRequest{Cmd: "x"})); out != fmt.Sprintf("x: %d\n", want) {
			t.Fatalf("job %d: %q", want, out)
		}
	}
	waitFor(t, func() bool { return len(running(t, c, "db")) == 0 })
	s, _ := c.Service("db")
	if s.Saved == "" {
		t.Fatal("scaled to zero without saving")
	}
	// The next replica carries on from the save
	if out := output(t)(c.ServiceJob("db", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Errorf("after zero: %q", out)
	}
	// Twice to zero: one save kept, the latest
	waitFor(t, func() bool { return len(running(t, c, "db")) == 0 })
	waitFor(t, func() bool { s2, _ := c.Service("db"); return s2.Saved != "" && s2.Saved != s.Saved })
	if ss, _ := c.Snapshots(); len(ss) != 1 {
		t.Errorf("snapshots: %+v", ss)
	}
	if out := output(t)(c.ServiceJob("db", control.JobRequest{Cmd: "x"})); out != "x: 4\n" {
		t.Errorf("after zero again: %q", out)
	}
	// Removed with its save
	c.RemoveService("db")
	if ss, _ := c.Snapshots(); len(ss) != 0 {
		t.Errorf("snapshots after rm: %+v", ss)
	}
}

func TestAServiceKeepsItsMinimumAndGrowsToItsMaximum(t *testing.T) {
	d, _ := serviceDaemon(t)
	c := d.c
	svc, err := c.AddService(Service{Name: "api", Template: "t", Ports: []Port{{IP: "127.0.0.1", Guest: 80}},
		Min: 1, Max: 2, Concurrency: 1, Idle: Duration(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if len(svc.Replicas) != 1 {
		t.Fatalf("min 1: %+v", svc.Replicas)
	}
	// A connection held open fills the first replica's one place: the next starts a second
	port := svc.Ports[0].Host
	hold := func() net.Conn {
		conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		conn.Write([]byte("x"))
		buf := make([]byte, 1)
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		conn.Read(buf)
		return conn
	}
	a := hold()
	b := hold()
	if rs := running(t, c, "api"); len(rs) != 2 {
		t.Errorf("under load: %+v", rs)
	}
	// At its max, a third goes to one of the two
	cc := hold()
	if rs := running(t, c, "api"); len(rs) != 2 {
		t.Errorf("at max: %+v", rs)
	}
	for _, conn := range []net.Conn{a, b, cc} {
		conn.Close()
	}
	// Idle: back down to its min, not below
	waitFor(t, func() bool { return len(running(t, c, "api")) == 1 })
	time.Sleep(1500 * time.Millisecond)
	rs := running(t, c, "api")
	if len(rs) != 1 {
		t.Fatalf("below min: %+v", rs)
	}
	// A replica that dies below the min is replaced
	m, _ := c.Machine(rs[0].Machine)
	syscall.Kill(m.Pid, syscall.SIGKILL)
	waitFor(t, func() bool { now := running(t, c, "api"); return len(now) == 1 && now[0].Machine != m.Name })
}

func TestAServiceIsCheckedAndHoldsItsTemplate(t *testing.T) {
	d, _ := serviceDaemon(t)
	c := d.c
	for what, req := range map[string]Service{
		"no template":        {Name: "a", Template: "nope"},
		"a path for a name":  {Name: "../a", Template: "t"},
		"negative min":       {Name: "a", Template: "t", Min: -1},
		"max under min":      {Name: "a", Template: "t", Min: 3, Max: 2},
		"keep with replicas": {Name: "a", Template: "t", State: "keep", Max: 2},
		"an unknown state":   {Name: "a", Template: "t", State: "sometimes"},
		"too short an idle":  {Name: "a", Template: "t", Idle: Duration(time.Millisecond)},
	} {
		if _, err := c.AddService(req); err == nil {
			t.Errorf("%s: no error", what)
		}
	}
	if _, err := c.AddService(Service{Name: "a", Template: "t"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddService(Service{Name: "a", Template: "t"}); statusOf(err) != 409 {
		t.Errorf("the same name twice: %v", err)
	}
	if err := c.RemoveTemplate("t"); statusOf(err) != 409 || !strings.Contains(err.Error(), "service a") {
		t.Errorf("its template removed under it: %v", err)
	}
	if _, err := c.ServiceJob("nope", control.JobRequest{Cmd: "x"}); !NotFound(err) {
		t.Errorf("a job on no service: %v", err)
	}
	if ss, _ := c.Services(); len(ss) != 1 || ss[0].Name != "a" {
		t.Errorf("services: %+v", ss)
	}
}

func TestAServiceOutlivesItsDaemon(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	tpl, _ := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer syscall.Kill(-tpl.Pid, syscall.SIGKILL)
	svc, err := d.c.AddService(Service{Name: "web", Template: "t", Ports: []Port{{IP: "127.0.0.1", Guest: 80}}, Idle: Duration(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	d.stop(t)
	// Started again: the service holds its port again, and wakes on it
	d = startDaemon(t, dir, Options{})
	defer d.stop(t)
	if got := echo(t, svc.Ports[0].Host, "back"); got != "back" {
		t.Errorf("after a restart: %q", got)
	}
}

func TestDurationsAreReadableJSON(t *testing.T) {
	var d Duration
	for in, want := range map[string]time.Duration{`"5m"`: 5 * time.Minute, `"1h30m"`: 90 * time.Minute, `1000000000`: time.Second} {
		if err := d.UnmarshalJSON([]byte(in)); err != nil || time.Duration(d) != want {
			t.Errorf("%s: %v %v", in, time.Duration(d), err)
		}
	}
	if err := d.UnmarshalJSON([]byte(`"soon"`)); err == nil {
		t.Error("a bad duration read")
	}
	if b, _ := Duration(5 * time.Minute).MarshalJSON(); string(b) != `"5m0s"` {
		t.Errorf("written: %s", b)
	}
}
