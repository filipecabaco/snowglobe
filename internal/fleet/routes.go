package fleet

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// PlanView is a plan as the API shows it: the fleet, its file, and each step with its key.
type PlanView struct {
	Fleet     string `json:"fleet"`
	Instance  string `json:"instance"`
	File      string `json:"file"`
	Steps     []Step `json:"steps"`
	Unchanged int    `json:"unchanged"`
}

// FleetView is one fleet: its file's text and its plan (or why there is none).
type FleetView struct {
	daemon.FleetInfo
	Text  string    `json:"text,omitempty"`
	Plan  *PlanView `json:"plan,omitempty"`
	Error string    `json:"error,omitempty"`
}

// ApplyResult is what applying did: its log, and the plan after it.
type ApplyResult struct {
	Log      []string  `json:"log"`
	Plan     *PlanView `json:"plan,omitempty"`
	Instance string    `json:"instance,omitempty"`
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Routes serves the fleets the daemon knows on its API, like compose projects:
//
//	GET    /v1/fleets                  every fleet: added ones, and ones only labels name
//	POST   /v1/fleets {file}           add a fleet file from where it is
//	POST   /v1/fleets {name, text}     write a new fleet file (in the daemon's directory)
//	GET    /v1/fleets/{name}           its file's text and its plan
//	PUT    /v1/fleets/{name} {text}    check and write its file
//	DELETE /v1/fleets/{name}           forget it (?down=1: remove what it made first)
//	POST   /v1/fleets/{name}/apply     {step, instance}: one step by its key, or all of them
//	POST   /v1/fleets/{name}/down      remove what it made
//	POST   /v1/fleets/{name}/instances {instance}: start an instance (named, or numbered)
//	DELETE /v1/fleets/{name}/instances/{instance}   remove an instance (what they share stays)
//
// api reaches the daemon (its own client); build builds Dockerfile directories. One fleet
// changes at a time.
//
// api is the daemon to apply through, for a request (one from another host gets a client that
// says so, and is held to the daemon's policy); policy is that policy, for what the routes do
// themselves: the fleet files they read, and the directories they build.
func Routes(mux daemon.Router, reg *Registry, api func(*http.Request) (API, error), build Builder, policy daemon.Policy) {
	var mu sync.Mutex
	answer := func(w http.ResponseWriter, v any, err error) {
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			status := http.StatusBadRequest
			if daemon.NotFound(err) {
				status = http.StatusNotFound
			}
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "result": v})
			return
		}
		json.NewEncoder(w).Encode(v)
	}
	read := func(r *http.Request, v any) error {
		if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(v); err != nil {
			return fmt.Errorf("request: %v", err)
		}
		return nil
	}
	// The fleet's file, loaded and planned
	// The builds a request may make: from another host, of a directory under a site root only
	builder := func(r *http.Request) Builder {
		if !daemon.IsRemote(r) {
			return build
		}
		return func(dir, out, network string) error {
			if err := policy.Path(dir, ""); err != nil {
				return err
			}
			return build(dir, out, network)
		}
	}
	planOf := func(r *http.Request, name, inst string) (*File, API, *Plan, error) {
		path, ok := reg.File(name)
		if !ok {
			return nil, nil, nil, daemon.ErrNotFound("fleet file for " + name + " (add it, or write one)")
		}
		f, err := Load(path)
		if err != nil {
			return nil, nil, nil, err
		}
		a, err := api(r)
		if err != nil {
			return nil, nil, nil, err
		}
		p, err := f.PlanInstance(a, inst)
		return f, a, p, err
	}
	view := func(file string, f *File, p *Plan) *PlanView {
		steps := p.Steps
		if steps == nil {
			steps = []Step{}
		}
		return &PlanView{Fleet: f.Name, Instance: p.Instance, File: file, Steps: steps, Unchanged: p.Unchanged}
	}
	mux.HandleFunc("GET /v1/fleets", func(w http.ResponseWriter, r *http.Request) {
		a, err := api(r)
		if err != nil {
			answer(w, nil, err)
			return
		}
		v, err := reg.Fleets(a)
		answer(w, v, err)
	})
	mux.HandleFunc("POST /v1/fleets", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			File string `json:"file"`
			Name string `json:"name"`
			Text string `json:"text"`
		}
		if err := read(r, &req); err != nil {
			answer(w, nil, err)
			return
		}
		if req.File != "" {
			// A file of this host's: from another, only under a site root (it is read back)
			if daemon.IsRemote(r) {
				if err := policy.Path(req.File, ""); err != nil {
					answer(w, nil, err)
					return
				}
			}
			e, err := reg.Add(req.File)
			answer(w, e, err)
			return
		}
		if _, ok := reg.File(req.Name); ok {
			answer(w, nil, fmt.Errorf("a fleet called %s exists: change its file instead", req.Name))
			return
		}
		e, err := reg.Write(req.Name, req.Text)
		answer(w, e, err)
	})
	mux.HandleFunc("GET /v1/fleets/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		path, ok := reg.File(name)
		v := FleetView{FleetInfo: daemon.FleetInfo{Name: name, File: path}}
		if !ok {
			answer(w, v, nil)
			return
		}
		text, err := readText(path)
		if err != nil {
			answer(w, nil, err)
			return
		}
		v.Text = text
		inst := r.URL.Query().Get("instance")
		if f, a, p, err := planOf(r, name, inst); err != nil {
			v.Error = err.Error()
		} else {
			v.Plan = view(path, f, p)
			v.Instances, _ = Instances(a, name)
		}
		answer(w, v, nil)
	})
	mux.HandleFunc("PUT /v1/fleets/{name}", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text string `json:"text"`
		}
		if err := read(r, &req); err != nil {
			answer(w, nil, err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		e, err := reg.Write(r.PathValue("name"), req.Text)
		answer(w, e, err)
	})
	mux.HandleFunc("DELETE /v1/fleets/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		mu.Lock()
		defer mu.Unlock()
		res := &ApplyResult{Log: []string{}}
		if r.URL.Query().Get("down") != "" {
			a, err := api(r)
			if err == nil {
				_, err = Down(a, name, func(format string, args ...any) { res.Log = append(res.Log, fmt.Sprintf(format, args...)) })
			}
			if err != nil {
				answer(w, res, err)
				return
			}
		}
		if err := reg.Forget(name); err != nil && !(daemon.NotFound(err) && len(res.Log) > 0) {
			answer(w, res, err)
			return
		}
		answer(w, res, nil)
	})
	mux.HandleFunc("POST /v1/fleets/{name}/apply", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Step     string `json:"step"`
			Instance string `json:"instance"`
		}
		if r.ContentLength != 0 {
			if err := read(r, &req); err != nil {
				answer(w, nil, err)
				return
			}
		}
		mu.Lock()
		defer mu.Unlock()
		name := r.PathValue("name")
		f, a, p, err := planOf(r, name, req.Instance)
		if err != nil {
			answer(w, nil, err)
			return
		}
		res := &ApplyResult{Log: []string{}}
		logf := func(format string, args ...any) {
			res.Log = append(res.Log, strings.TrimSpace(fmt.Sprintf(format, args...)))
		}
		if req.Step != "" {
			err = p.ApplyStep(a, builder(r), req.Step, logf)
		} else {
			err = p.Apply(a, builder(r), logf)
		}
		path, _ := reg.File(name)
		if after, perr := f.PlanInstance(a, req.Instance); perr == nil {
			res.Plan = view(path, f, after)
		}
		answer(w, res, err)
	})
	mux.HandleFunc("POST /v1/fleets/{name}/instances", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Instance string `json:"instance"`
		}
		if r.ContentLength != 0 {
			if err := read(r, &req); err != nil {
				answer(w, nil, err)
				return
			}
		}
		mu.Lock()
		defer mu.Unlock()
		name := r.PathValue("name")
		a, err := api(r)
		if err != nil {
			answer(w, nil, err)
			return
		}
		have, err := Instances(a, name)
		if err != nil {
			answer(w, nil, err)
			return
		}
		inst := req.Instance
		if inst == "" {
			// The next number not taken
			for n := 2; ; n++ {
				inst = fmt.Sprint(n)
				if !contains(have, inst) {
					break
				}
			}
		} else if contains(have, inst) {
			answer(w, nil, fmt.Errorf("fleet %s has an instance %s already", name, inst))
			return
		}
		f, a, p, err := planOf(r, name, inst)
		if err != nil {
			answer(w, nil, err)
			return
		}
		res := &ApplyResult{Log: []string{}}
		err = p.Apply(a, builder(r), func(format string, args ...any) {
			res.Log = append(res.Log, strings.TrimSpace(fmt.Sprintf(format, args...)))
		})
		path, _ := reg.File(name)
		if after, perr := f.PlanInstance(a, inst); perr == nil {
			res.Plan = view(path, f, after)
		}
		res.Instance = inst
		answer(w, res, err)
	})
	mux.HandleFunc("DELETE /v1/fleets/{name}/instances/{instance}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		a, err := api(r)
		if err != nil {
			answer(w, nil, err)
			return
		}
		res := &ApplyResult{Log: []string{}, Instance: r.PathValue("instance")}
		_, err = DownInstance(a, r.PathValue("name"), r.PathValue("instance"), func(format string, args ...any) { res.Log = append(res.Log, fmt.Sprintf(format, args...)) })
		answer(w, res, err)
	})
	mux.HandleFunc("POST /v1/fleets/{name}/down", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		a, err := api(r)
		if err != nil {
			answer(w, nil, err)
			return
		}
		res := &ApplyResult{Log: []string{}}
		_, err = Down(a, r.PathValue("name"), func(format string, args ...any) { res.Log = append(res.Log, fmt.Sprintf(format, args...)) })
		answer(w, res, err)
	})
}
