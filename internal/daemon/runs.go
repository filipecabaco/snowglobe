package daemon

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// A run is fire and forget: a command submitted to a template runs once, on a fresh fork that is
// thrown away when it ends, while the caller goes on; its result is kept to read later.

// SubmitRun asks for a run.
type SubmitRun struct {
	Template string            `json:"template"`
	Cmd      string            `json:"cmd"`
	Env      map[string]string `json:"env,omitempty"`
	Files    map[string][]byte `json:"files,omitempty"`
	// Seconds before it is killed (0: the job default, 300)
	Timeout float64 `json:"timeout,omitempty"`
}

// Run is a submitted command and, once it ended, how.
type Run struct {
	ID       string     `json:"id"`
	Template string     `json:"template"`
	Cmd      string     `json:"cmd"`
	Status   string     `json:"status"` // running, done, failed (it couldn't run)
	Created  time.Time  `json:"created"`
	Ended    *time.Time `json:"ended,omitempty"`
	// Its exit status (nil: out of time, or it couldn't run), output and out/
	Exit     *int              `json:"exit,omitempty"`
	Output   []byte            `json:"output,omitempty"`
	Out      map[string][]byte `json:"out,omitempty"`
	TimedOut bool              `json:"timed_out,omitempty"`
	Error    string            `json:"error,omitempty"`
	Ms       int64             `json:"ms,omitempty"`
}

// How many runs are kept, the oldest finished ones going first; and how much of their output
// (each run's is cut at maxJobOutput), past which the oldest finished ones lose theirs
var (
	keptRuns      = 500
	keptRunOutput = int64(256 << 20)
)

type runs struct {
	mu  sync.Mutex
	all map[string]*Run
}

func newRuns() *runs { return &runs{all: map[string]*Run{}} }

// SubmitRun starts a run and answers at once.
func (s *Server) SubmitRun(req SubmitRun) (*Run, error) {
	if req.Cmd == "" {
		return nil, errStatus(400, "cmd: the command to run")
	}
	s.mu.Lock()
	_, ok := s.st.Templates[req.Template]
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no template called %s", req.Template)
	}
	r := &Run{ID: randomName("run"), Template: req.Template, Cmd: req.Cmd, Status: "running", Created: time.Now()}
	s.runs.mu.Lock()
	s.runs.all[r.ID] = r
	s.pruneRuns()
	c := *r
	s.runs.mu.Unlock()
	s.note("run.started", "run "+r.ID, "on a fresh fork of %s: %s", r.Template, short(r.Cmd))
	go func() {
		// (Nobody waits on it: it runs to its own time limit)
		res, err := s.TemplateJob(context.Background(), req.Template, control.JobRequest{Cmd: req.Cmd, Env: req.Env, Files: req.Files, Timeout: req.Timeout})
		end := time.Now()
		s.runs.mu.Lock()
		r.Ended, r.Ms = &end, end.Sub(r.Created).Milliseconds()
		switch {
		case err != nil:
			r.Status, r.Error = "failed", err.Error()
		default:
			r.Status, r.Exit, r.Output, r.Out, r.TimedOut = "done", res.Status, res.Output, res.Out, res.TimedOut
		}
		s.pruneRuns()
		done := *r
		s.runs.mu.Unlock()
		switch {
		case done.Error != "":
			s.note("run.failed", "run "+done.ID, "%s", done.Error)
		case done.Exit == nil:
			s.note("run.done", "run "+done.ID, "out of time after %d ms", done.Ms)
		default:
			s.note("run.done", "run "+done.ID, "exit %d in %d ms", *done.Exit, done.Ms)
		}
	}()
	return &c, nil
}

// pruneRuns drops the oldest finished runs past keptRuns, and the output of the oldest past
// keptRunOutput (runs.mu held).
func (s *Server) pruneRuns() {
	var done []*Run
	var held int64
	for _, r := range s.runs.all {
		if r.Ended != nil {
			done = append(done, r)
			held += runOutput(r)
		}
	}
	sort.Slice(done, func(i, j int) bool { return done[i].Created.Before(done[j].Created) })
	n := max(0, min(len(done), len(s.runs.all)-keptRuns))
	for _, r := range done[:n] {
		held -= runOutput(r)
		delete(s.runs.all, r.ID)
	}
	for _, r := range done[n:] {
		if held <= keptRunOutput {
			break
		}
		if o := runOutput(r); o > 0 {
			held -= o
			r.Output, r.Out = nil, nil
			r.Error = "its output was dropped: newer runs' took the room the daemon keeps for them"
		}
	}
}

// runOutput is how much of a run's output (and out/) is kept.
func runOutput(r *Run) int64 {
	n := int64(len(r.Output))
	for _, f := range r.Out {
		n += int64(len(f))
	}
	return n
}

// Runs is the kept runs, newest first, without their output.
func (s *Server) Runs() []Run {
	s.runs.mu.Lock()
	defer s.runs.mu.Unlock()
	out := []Run{}
	for _, r := range s.runs.all {
		c := *r
		c.Output, c.Out = nil, nil
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out
}

// GetRun is the run called id, with its output.
func (s *Server) GetRun(id string) (*Run, error) {
	s.runs.mu.Lock()
	defer s.runs.mu.Unlock()
	r, ok := s.runs.all[id]
	if !ok {
		return nil, errStatus(404, "no run called %s", id)
	}
	c := *r
	return &c, nil
}

func short(s string) string {
	if len(s) > 80 {
		return s[:77] + "..."
	}
	return s
}

func (s *Server) runRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		var req SubmitRun
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.SubmitRun(req)
		reply(w, v, err)
	})
	mux.HandleFunc("GET /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Runs(), nil)
	})
	mux.HandleFunc("GET /v1/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.GetRun(r.PathValue("id"))
		reply(w, v, err)
	})
}
