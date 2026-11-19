package daemon

import (
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

func TestATemplatesMachinesRunItsStartCommandsBeforeTheyAreHandedOver(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "web", Start: []StartCommand{{Cmd: "first"}, {Cmd: "second", Timeout: Duration(time.Minute)}}}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("web")
	tpl, err := d.c.Templates()
	if err != nil || len(tpl) != 1 || len(tpl[0].Start) != 2 || tpl[0].Start[1].Timeout != Duration(time.Minute) {
		t.Fatalf("the template keeps its start: %+v %v", tpl, err)
	}
	events, cancel := collect(t, d.c, 0)
	defer cancel()

	// Up returns once both ran: the fake machine counts its jobs, so the next is its third
	if _, err := d.c.Up(Up{Template: "web", Name: "m"}); err != nil {
		t.Fatal(err)
	}
	if out := output(t)(d.c.Job("m", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Errorf("a job after the start commands: %q", out)
	}
	waitFor(t, func() bool { return has(events(), "machine.started", "machine m") })

	// Each machine runs them, its own: a second machine's next job is its third too
	if _, err := d.c.Up(Up{Template: "web", Name: "n"}); err != nil {
		t.Fatal(err)
	}
	if out := output(t)(d.c.Job("n", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Errorf("another machine's job after its start commands: %q", out)
	}

	// A template without start: a machine's first job is its first
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "plain"}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("plain")
	if _, err := d.c.Up(Up{Template: "plain", Name: "p"}); err != nil {
		t.Fatal(err)
	}
	if out := output(t)(d.c.Job("p", control.JobRequest{Cmd: "x"})); out != "x: 1\n" {
		t.Errorf("a job with no start commands: %q", out)
	}
}

func TestAMachineWhoseStartCommandFailsGoesAndSaysWhy(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	// "false" exits 1 and says "no" on the fake machine: the command after it never runs
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "broken", Start: []StartCommand{{Cmd: "first"}, {Cmd: "false"}, {Cmd: "never"}}}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("broken")
	events, cancel := collect(t, d.c, 0)
	defer cancel()
	_, err := d.c.Up(Up{Template: "broken", Name: "m"})
	if statusOf(err) != 422 || !strings.Contains(err.Error(), "start command 2 of 3 (false) exited 1: no") {
		t.Fatalf("up with a failing start command: %v", err)
	}
	if ms, _ := d.c.Machines(nil); len(ms) != 0 {
		t.Errorf("machines after its start failed: %+v", ms)
	}
	waitFor(t, func() bool { return has(events(), "machine.start_failed", "machine m") })
	// The name is free again
	if _, err := d.c.Up(Up{Template: "broken", Name: "m"}); statusOf(err) != 422 {
		t.Errorf("up again: %v", err)
	}

	for what, start := range map[string][]StartCommand{
		"an empty command": {{Cmd: "  "}},
		"a negative time":  {{Cmd: "x", Timeout: Duration(-time.Second)}},
	} {
		if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "bad", Start: start}); statusOf(err) != 400 {
			t.Errorf("%s: %v", what, err)
			d.c.RemoveTemplate("bad")
		}
	}
}
