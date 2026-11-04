package daemon

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

func TestMetricsCountWhatTheDaemonDid(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{Memory: 1 << 30})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")
	d.c.Up(Up{Template: "t", Name: "a"})
	d.c.Up(Up{Template: "t", Name: "b"})
	for i := 0; i < 3; i++ {
		d.c.Job("a", control.JobRequest{Cmd: "x"})
	}
	d.c.Job("gone", control.JobRequest{Cmd: "x"})
	d.c.TemplateJob("t", control.JobRequest{Cmd: "x"})

	first := d.s.sample()
	if first.Machines != 2 || first.Templates != 1 || first.Ups != 2 || first.Jobs != 4 || first.MemoryBudget != 1<<30 {
		t.Errorf("first sample: %+v", first)
	}
	if first.JobMsP50 <= 0 || first.JobMsP95 < first.JobMsP50 || first.UpMsP50 <= 0 {
		t.Errorf("latencies: %+v", first)
	}
	// What a sample counts starts afresh
	second := d.s.sample()
	if second.Jobs != 0 || second.Ups != 0 || second.JobMsP50 != 0 {
		t.Errorf("second sample: %+v", second)
	}
	m, err := d.c.Metrics(time.Time{})
	if err != nil || len(m.Samples) != 2 || m.Totals.Jobs != 4 || m.Totals.Ups != 2 || m.EveryMs != 5000 {
		t.Fatalf("metrics: %+v %v", m, err)
	}
	if m, _ := d.c.Metrics(first.Time); len(m.Samples) != 1 {
		t.Errorf("since the first: %d samples", len(m.Samples))
	}

	resp, err := d.c.http.Get(d.c.base + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, want := range []string{
		"# TYPE snowglobe_machines gauge\nsnowglobe_machines 2\n",
		"snowglobe_jobs_total 4\n",
		"snowglobe_ups_total 2\n",
		"snowglobe_memory_budget_bytes 1073741824\n",
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("no %q in\n%s", want, body)
		}
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") || resp.StatusCode != http.StatusOK {
		t.Errorf("%d %s", resp.StatusCode, ct)
	}
}

func TestOnlyTheLastHourOfSamplesIsKept(t *testing.T) {
	old := keptSamples
	keptSamples = 3
	t.Cleanup(func() { keptSamples = old })
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	for i := 0; i < 5; i++ {
		d.s.sample()
	}
	if m := d.s.Metrics(time.Time{}); len(m.Samples) != 3 {
		t.Errorf("%d samples", len(m.Samples))
	}
	if p := percentile([]float64{5, 1, 3, 2, 4}, .5); p != 3 {
		t.Errorf("median: %v", p)
	}
}
