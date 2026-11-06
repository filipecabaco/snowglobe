package daemon

import (
	"context"
	"sync"
	"testing"
	"time"
)

// collect gathers the daemon's events from after seq after, in the background.
func collect(t *testing.T, c *Client, after int64) (func() []Event, context.CancelFunc) {
	t.Helper()
	var mu sync.Mutex
	var got []Event
	ctx, cancel := context.WithCancel(context.Background())
	go c.Events(ctx, after, func(ev Event) bool {
		mu.Lock()
		got = append(got, ev)
		mu.Unlock()
		return true
	})
	return func() []Event {
		mu.Lock()
		defer mu.Unlock()
		return append([]Event(nil), got...)
	}, cancel
}

func kinds(evs []Event) []string {
	var out []string
	for _, ev := range evs {
		out = append(out, ev.Kind)
	}
	return out
}

func has(evs []Event, kind, subject string) bool {
	for _, ev := range evs {
		if ev.Kind == kind && ev.Subject == subject {
			return true
		}
	}
	return false
}

func TestEventsStreamWhatTheDaemonDoes(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	got, cancel := collect(t, d.c, 0)
	defer cancel()

	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	d.c.Up(Up{Template: "t", Name: "m"})
	d.c.Snapshot("m", "s")
	d.c.RemoveMachine("m")
	d.c.RemoveSnapshot("s")
	d.c.RemoveTemplate("t")
	want := []struct{ kind, subject string }{
		{"template.added", "template t"}, {"machine.up", "machine m"}, {"snapshot.saved", "snapshot s"},
		{"machine.removed", "machine m"}, {"snapshot.removed", "snapshot s"}, {"template.removed", "template t"},
	}
	waitFor(t, func() bool { return len(got()) >= len(want) })
	evs := got()
	for i, w := range want {
		if evs[i].Kind != w.kind || evs[i].Subject != w.subject {
			t.Errorf("event %d: %+v, want %s %s (all: %v)", i, evs[i], w.kind, w.subject, kinds(evs))
		}
		if i > 0 && evs[i].Seq != evs[i-1].Seq+1 {
			t.Errorf("event %d: seq %d after %d", i, evs[i].Seq, evs[i-1].Seq)
		}
	}

	// A listener that comes later gets what was kept after the seq it gives, then what follows
	late, cancelLate := collect(t, d.c, evs[2].Seq)
	defer cancelLate()
	waitFor(t, func() bool { return len(late()) >= 3 })
	if first := late()[0]; first.Seq != evs[3].Seq || first.Kind != "machine.removed" {
		t.Errorf("replayed from: %+v", first)
	}
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "u"})
	defer d.c.RemoveTemplate("u")
	waitFor(t, func() bool { return has(late(), "template.added", "template u") })
	// Each listener gets it in its own time: the first may still be one behind the late one
	waitFor(t, func() bool { return has(got(), "template.added", "template u") })
	if r := d.s.Recent(); len(r) != len(got()) {
		t.Errorf("kept %d, streamed %d", len(r), len(got()))
	}
}

func TestEventsSayWhatLimitsAndLifecycleDid(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	machineCost := func(pid int) int64 { return 100 << 20 }
	d := startDaemon(t, shortTemp(t), Options{Memory: 150 << 20, Wait: 200 * time.Millisecond, memOf: machineCost})
	defer d.stop(t)
	got, cancel := collect(t, d.c, 0)
	defer cancel()
	// The template server alone (100 MB here) leaves no room for a machine guessed at 64 MB
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t", Idle: Duration(time.Second)})
	d.c.Up(Up{Template: "t", Name: "m"})
	waitFor(t, func() bool { return has(got(), "admission.refused", "template t") })
	waitFor(t, func() bool { return has(got(), "template.asleep", "template t") })
	d.c.RemoveTemplate("t")
}

func TestStatsCountAndMeasure(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	cost := func(pid int) int64 { return 10 << 20 }
	d := startDaemon(t, shortTemp(t), Options{Memory: 1 << 30, memOf: cost})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")
	d.c.Up(Up{Template: "t", Name: "a"})
	d.c.Up(Up{Template: "t", Name: "b"})
	d.c.Snapshot("a", "s")
	defer d.c.RemoveSnapshot("s")
	st, err := d.c.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if st.Templates != 1 || st.TemplatesAwake != 1 || st.Machines != 2 || st.Snapshots != 1 || st.Services != 0 {
		t.Errorf("counts: %+v", st)
	}
	if st.MemoryUsed != 30<<20 || st.MemoryBudget != 1<<30 || st.Memory["a"] != 10<<20 || st.Memory["template/t"] != 10<<20 {
		t.Errorf("memory: %+v", st)
	}
}
