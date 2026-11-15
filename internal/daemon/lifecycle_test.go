package daemon

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

func TestMachinesWaitForRoomInTheMemoryBudget(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	var mu sync.Mutex
	servers := map[int]bool{}
	// Every machine takes 100 MB; template servers nothing
	cost := func(pid int) int64 {
		mu.Lock()
		defer mu.Unlock()
		if servers[pid] || !alive(pid) {
			return 0
		}
		return 100 << 20
	}
	d := startDaemon(t, shortTemp(t), Options{Memory: 250 << 20, Wait: time.Second, memOf: cost})
	defer d.stop(t)
	tpl, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("t")
	mu.Lock()
	servers[tpl.Pid] = true
	mu.Unlock()

	// Two fit (the first guessed at 64 MB, the second at the first's 100)
	for _, n := range []string{"a", "b"} {
		if _, err := d.c.Up(Up{Template: "t", Name: n}); err != nil {
			t.Fatalf("%s: %v", n, err)
		}
	}
	// A third waits for room: a's going makes it
	go func() { time.Sleep(300 * time.Millisecond); d.c.RemoveMachine("a") }()
	begun := time.Now()
	if _, err := d.c.Up(Up{Template: "t", Name: "c"}); err != nil {
		t.Fatalf("c, once a went: %v", err)
	}
	if waited := time.Since(begun); waited < 250*time.Millisecond {
		t.Errorf("c didn't wait: %s", waited)
	}
	// A fourth finds none within the wait: refused, saying why
	_, err = d.c.Up(Up{Template: "t", Name: "d"})
	if statusOf(err) != 429 || !strings.Contains(err.Error(), "200 MB used of 250 MB") || !strings.Contains(err.Error(), "about 100 MB") {
		t.Errorf("over the budget: %v", err)
	}
	if ms, _ := d.c.Machines(nil); len(ms) != 2 {
		t.Errorf("machines: %+v", ms)
	}
}

func TestAMachineStopsWhenItsTimeToLiveIsUp(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")
	m, err := d.c.Up(Up{Template: "t", Name: "brief", TTL: Duration(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if m.Expires == nil || m.Expires.Sub(m.Created) != time.Second {
		t.Fatalf("expires: %+v", m)
	}
	lasting, _ := d.c.Up(Up{Template: "t", Name: "lasting"})
	waitFor(t, func() bool { _, err := d.c.Machine("brief"); return NotFound(err) })
	if control.Alive(m.Socket) {
		t.Error("brief still answers")
	}
	if _, err := d.c.Machine("lasting"); err != nil || lasting.Expires != nil {
		t.Errorf("a machine without a ttl: %v %+v", err, lasting)
	}
	if _, err := d.c.Up(Up{Template: "t", TTL: Duration(-time.Second)}); statusOf(err) != 400 {
		t.Errorf("a negative ttl: %v", err)
	}
}

func TestAnIdleTemplateSleepsAndWakesOnItsNextUse(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	tpl, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t", Idle: Duration(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	asleep := func() bool {
		ts, _ := d.c.Templates()
		return len(ts) == 1 && ts[0].Asleep
	}
	// Nothing on it for a second: its server stops
	waitFor(t, asleep)
	if !gone(tpl.Pid, 5*time.Second) {
		t.Error("its server still runs")
	}
	// Woken by a machine: a new server, and the machine works
	m, err := d.c.Up(Up{Template: "t", Name: "m"})
	if err != nil {
		t.Fatal(err)
	}
	ts, _ := d.c.Templates()
	if ts[0].Asleep || ts[0].Pid == tpl.Pid || !alive(ts[0].Pid) {
		t.Fatalf("woken: %+v", ts[0])
	}
	if out := output(t)(d.c.Job("m", control.JobRequest{Cmd: "x"})); out != "x: 1\n" {
		t.Errorf("a machine of it: %q", out)
	}
	// Not while it has a machine
	time.Sleep(1500 * time.Millisecond)
	if asleep() {
		t.Error("asleep with a machine on it")
	}
	d.c.RemoveMachine(m.Name)
	waitFor(t, asleep)
	// A template job wakes it too
	if out := output(t)(d.c.TemplateJob("t", control.JobRequest{Cmd: "x"})); out != "fresh: 1\n" {
		t.Errorf("a template job: %q", out)
	}
	waitFor(t, asleep)
	// A daemon started again keeps it asleep, and wakes it
	d.stop(t)
	d = startDaemon(t, dir, Options{})
	defer d.stop(t)
	if !asleep() {
		t.Error("woken by a restart")
	}
	if _, err := d.c.Up(Up{Template: "t", Name: "again"}); err != nil {
		t.Errorf("woken after a restart: %v", err)
	}
	d.c.RemoveTemplate("t")
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "x", Idle: Duration(time.Millisecond)}); statusOf(err) != 400 {
		t.Errorf("too short an idle: %v", err)
	}
}

func TestParseSize(t *testing.T) {
	for in, want := range map[string]int64{"512M": 512 << 20, "8G": 8 << 30, "1.5G": 3 << 29, "2gb": 2 << 30, "64MiB": 64 << 20, "1024": 1024} {
		if got, err := ParseSize(in); err != nil || got != want {
			t.Errorf("%s: %d %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "lots", "-1G", "G"} {
		if _, err := ParseSize(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

// A job on a fresh fork of a template is a machine as far as the budget goes: it waits for room,
// and holds its room while it runs
func TestATemplateJobIsAdmittedToTheMemoryBudget(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	var mu sync.Mutex
	servers := map[int]bool{}
	cost := func(pid int) int64 {
		mu.Lock()
		defer mu.Unlock()
		if servers[pid] || !alive(pid) {
			return 0
		}
		return 100 << 20
	}
	d := startDaemon(t, shortTemp(t), Options{Memory: 100 << 20, Wait: 500 * time.Millisecond, memOf: cost})
	defer d.stop(t)
	tpl, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("t")
	mu.Lock()
	servers[tpl.Pid] = true
	mu.Unlock()
	// A job running holds its 64 MB (the guess, with no machine measured): a second doesn't fit
	running := make(chan error, 1)
	go func() {
		_, err := d.c.TemplateJob("t", control.JobRequest{Cmd: "sleep 2s"})
		running <- err
	}()
	time.Sleep(300 * time.Millisecond)
	if _, err := d.c.TemplateJob("t", control.JobRequest{Cmd: "x"}); statusOf(err) != 429 {
		t.Errorf("a job past the budget: %v", err)
	}
	if err := <-running; err != nil {
		t.Fatal(err)
	}
	// Ended: its room is back
	if _, err := d.c.TemplateJob("t", control.JobRequest{Cmd: "x"}); err != nil {
		t.Errorf("once the first ended: %v", err)
	}
	// A machine takes 100 MB: a job no longer fits beside it
	if _, err := d.c.Up(Up{Template: "t", Name: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.c.TemplateJob("t", control.JobRequest{Cmd: "x"}); statusOf(err) != 429 {
		t.Errorf("a job beside a machine: %v", err)
	}
}

// A template doesn't sleep while a job runs on it, however long it takes
func TestATemplateDoesNotSleepUnderAJob(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t", Idle: Duration(time.Second)}); err != nil {
		t.Fatal(err)
	}
	if out := output(t)(d.c.TemplateJob("t", control.JobRequest{Cmd: "sleep 2500ms"})); out != "fresh: 1\n" {
		t.Errorf("a job longer than the idle time: %q", out)
	}
	// Then it sleeps
	waitFor(t, func() bool { ts, _ := d.c.Templates(); return len(ts) == 1 && ts[0].Asleep })
}

// A job whose caller has gone is given up: the daemon stops waiting, and what it held goes
func TestAJobIsGivenUpWhenItsCallerGoes(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	begun := time.Now()
	if _, err := d.s.TemplateJob(ctx, "t", control.JobRequest{Cmd: "sleep 5s"}); err == nil {
		t.Error("no error")
	}
	if waited := time.Since(begun); waited > 2*time.Second {
		t.Errorf("waited %s", waited)
	}
	d.s.life.mu.Lock()
	inUse := d.s.life.inUse["t"]
	d.s.life.mu.Unlock()
	if inUse != 0 {
		t.Errorf("still in use: %d", inUse)
	}
}
