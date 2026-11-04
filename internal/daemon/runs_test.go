package daemon

import (
	"strings"
	"testing"
)

func TestARunIsFireAndForget(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")

	r, err := d.c.SubmitRun(SubmitRun{Template: "t", Cmd: "make report"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != "running" || r.ID == "" || r.Template != "t" {
		t.Fatalf("as submitted: %+v", r)
	}
	var got *Run
	waitFor(t, func() bool { got, _ = d.c.Run(r.ID); return got != nil && got.Status != "running" })
	// The fake server answers a job on a fresh fork with "fresh: 1"
	if got.Status != "done" || got.Exit == nil || *got.Exit != 0 || string(got.Output) != "fresh: 1\n" || got.Ended == nil {
		t.Errorf("ended: %+v", got)
	}
	// It left no machine behind
	if ms, _ := d.c.Machines(nil); len(ms) != 0 {
		t.Errorf("machines after a run: %+v", ms)
	}
	list, _ := d.c.Runs()
	if len(list) != 1 || list[0].ID != r.ID || list[0].Output != nil {
		t.Errorf("listed (no output): %+v", list)
	}
	evs := strings.Join(kinds(d.s.Recent()), " ")
	if !strings.Contains(evs, "run.started") || !strings.Contains(evs, "run.done") {
		t.Errorf("events: %s", evs)
	}
	if _, err := d.c.SubmitRun(SubmitRun{Template: "nope", Cmd: "x"}); statusOf(err) != 404 {
		t.Errorf("no template: %v", err)
	}
	if _, err := d.c.SubmitRun(SubmitRun{Template: "t"}); statusOf(err) != 400 {
		t.Errorf("no command: %v", err)
	}
	if _, err := d.c.Run("run-nope"); statusOf(err) != 404 {
		t.Errorf("no run: %v", err)
	}
}

func TestOnlyTheNewestRunsAreKept(t *testing.T) {
	old := keptRuns
	keptRuns = 2
	t.Cleanup(func() { keptRuns = old })
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")
	for i := 0; i < 4; i++ {
		r, _ := d.c.SubmitRun(SubmitRun{Template: "t", Cmd: "x"})
		waitFor(t, func() bool { got, _ := d.c.Run(r.ID); return got != nil && got.Status != "running" })
	}
	if list, _ := d.c.Runs(); len(list) > 3 {
		t.Errorf("%d runs kept", len(list))
	}
}
