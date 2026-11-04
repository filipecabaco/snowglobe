package daemon

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Sample is the daemon at one moment, with what it did since the sample before: for charts
// (/v1/metrics) and for scraping (/metrics).
type Sample struct {
	Time           time.Time `json:"time"`
	MemoryUsed     int64     `json:"memory_used"`
	MemoryBudget   int64     `json:"memory_budget"`
	Templates      int       `json:"templates"`
	TemplatesAwake int       `json:"templates_awake"`
	Machines       int       `json:"machines"`
	Services       int       `json:"services"`
	Replicas       int       `json:"replicas"`
	Snapshots      int       `json:"snapshots"`
	Builds         int       `json:"builds_running"`
	// Since the sample before
	Jobs       int     `json:"jobs"`
	JobErrors  int     `json:"job_errors"`
	Ups        int     `json:"ups"`
	JobMsP50   float64 `json:"job_ms_p50"`
	JobMsP95   float64 `json:"job_ms_p95"`
	UpMsP50    float64 `json:"up_ms_p50"`
	UpMsP95    float64 `json:"up_ms_p95"`
	WakeMsLast float64 `json:"wake_ms_last,omitempty"`
}

// Totals counts what the daemon did since it started.
type Totals struct {
	Started   time.Time `json:"started"`
	Jobs      int64     `json:"jobs"`
	JobErrors int64     `json:"job_errors"`
	Ups       int64     `json:"ups"`
	Wakes     int64     `json:"wakes"`
	Builds    int64     `json:"builds"`
}

// Metrics is the kept samples, oldest first, and the totals.
type Metrics struct {
	EveryMs int64    `json:"every_ms"`
	Samples []Sample `json:"samples"`
	Totals  Totals   `json:"totals"`
}

// How often a sample is taken, and how many are kept (an hour of them)
var (
	metricsEvery = 5 * time.Second
	keptSamples  = 720
)

// meter is the samples taken and what happened since the last.
type meter struct {
	mu      sync.Mutex
	samples []Sample
	totals  Totals
	// Since the last sample
	jobs, jobErrors, ups int
	jobMs, upMs          []float64
	wakeMs               float64
}

func newMeter() *meter {
	return &meter{totals: Totals{Started: time.Now()}}
}

func (m *meter) job(d time.Duration, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.jobs++
	m.totals.Jobs++
	if err != nil {
		m.jobErrors++
		m.totals.JobErrors++
	}
	m.jobMs = append(m.jobMs, ms(d))
}

func (m *meter) up(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ups++
	m.totals.Ups++
	m.upMs = append(m.upMs, ms(d))
}

func (m *meter) wake(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.totals.Wakes++
	m.wakeMs = ms(d)
}

func (m *meter) build() {
	m.mu.Lock()
	m.totals.Builds++
	m.mu.Unlock()
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// percentile of xs (sorted here), 0 when there are none.
func percentile(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sort.Float64s(xs)
	i := int(p * float64(len(xs)-1))
	return xs[i]
}

// sample takes a sample of the daemon now and starts counting afresh.
func (s *Server) sample() Sample {
	st := s.Stats()
	sm := Sample{
		Time: time.Now(), MemoryUsed: st.MemoryUsed, MemoryBudget: st.MemoryBudget,
		Templates: st.Templates, TemplatesAwake: st.TemplatesAwake, Machines: st.Machines,
		Services: st.Services, Snapshots: st.Snapshots, Builds: s.buildsRunning(),
	}
	for _, svc := range s.Services() {
		sm.Replicas += len(svc.Replicas)
	}
	m := s.meter
	m.mu.Lock()
	sm.Jobs, sm.JobErrors, sm.Ups, sm.WakeMsLast = m.jobs, m.jobErrors, m.ups, m.wakeMs
	sm.JobMsP50, sm.JobMsP95 = percentile(m.jobMs, .5), percentile(m.jobMs, .95)
	sm.UpMsP50, sm.UpMsP95 = percentile(m.upMs, .5), percentile(m.upMs, .95)
	m.jobs, m.jobErrors, m.ups, m.jobMs, m.upMs, m.wakeMs = 0, 0, 0, nil, nil, 0
	m.samples = append(m.samples, sm)
	if len(m.samples) > keptSamples {
		m.samples = m.samples[len(m.samples)-keptSamples:]
	}
	m.mu.Unlock()
	return sm
}

// sampler takes a sample every metricsEvery until ctx is done.
func (s *Server) sampler(ctx context.Context) {
	t := time.NewTicker(s.metricsEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sample()
		}
	}
}

// Metrics is the samples taken after since (all of them when zero) and the totals.
func (s *Server) Metrics(since time.Time) Metrics {
	m := s.meter
	m.mu.Lock()
	defer m.mu.Unlock()
	out := Metrics{EveryMs: s.metricsEvery.Milliseconds(), Totals: m.totals, Samples: []Sample{}}
	// To the millisecond, as the API has it
	for _, sm := range m.samples {
		if since.IsZero() || sm.Time.UnixMilli() > since.UnixMilli() {
			out.Samples = append(out.Samples, sm)
		}
	}
	return out
}

// serveMetrics answers /v1/metrics?since=UNIX_MS.
func (s *Server) serveMetrics(w http.ResponseWriter, r *http.Request) {
	var since time.Time
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			reply(w, nil, errStatus(400, "since: milliseconds since 1970"))
			return
		}
		since = time.UnixMilli(n)
	}
	reply(w, s.Metrics(since), nil)
}

// servePrometheus answers /metrics in Prometheus's text format: the daemon now and its totals.
func (s *Server) servePrometheus(w http.ResponseWriter, r *http.Request) {
	st := s.Stats()
	m := s.Metrics(time.Now())
	replicas := 0
	for _, svc := range s.Services() {
		replicas += len(svc.Replicas)
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	gauge := func(name, help string, v any) {
		fmt.Fprintf(w, "# HELP snowglobe_%s %s\n# TYPE snowglobe_%s gauge\nsnowglobe_%s %v\n", name, help, name, name, v)
	}
	counter := func(name, help string, v int64) {
		fmt.Fprintf(w, "# HELP snowglobe_%s_total %s\n# TYPE snowglobe_%s_total counter\nsnowglobe_%s_total %d\n", name, help, name, name, v)
	}
	gauge("memory_used_bytes", "Memory the template servers and machines take.", st.MemoryUsed)
	gauge("memory_budget_bytes", "The daemon's memory budget (0: none).", st.MemoryBudget)
	gauge("templates", "Templates kept.", st.Templates)
	gauge("templates_awake", "Templates whose server is running.", st.TemplatesAwake)
	gauge("machines", "Machines running.", st.Machines)
	gauge("services", "Services kept.", st.Services)
	gauge("service_replicas", "Service replicas running.", replicas)
	gauge("snapshots", "Snapshots kept.", st.Snapshots)
	gauge("builds_running", "Builds running.", s.buildsRunning())
	counter("jobs", "Jobs run.", m.Totals.Jobs)
	counter("job_errors", "Jobs that failed to run.", m.Totals.JobErrors)
	counter("ups", "Machines started.", m.Totals.Ups)
	counter("wakes", "Templates woken.", m.Totals.Wakes)
	counter("builds", "Builds started.", m.Totals.Builds)
}
