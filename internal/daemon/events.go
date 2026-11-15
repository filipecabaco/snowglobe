package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Event is something the daemon did or saw: a template added, asleep or awake; a machine up,
// stopped or past its time to live; a service's replica started or stopped; a snapshot saved; an
// admission waited for or refused.
type Event struct {
	Seq     int64     `json:"seq"`
	Time    time.Time `json:"time"`
	Kind    string    `json:"kind"`
	Subject string    `json:"subject"`
	Message string    `json:"message"`
}

// How many events the daemon keeps, for those who connect later
const keptEvents = 200

// events is the daemon's recent events and those listening for more.
type events struct {
	mu   sync.Mutex
	seq  int64
	ring []Event
	subs map[chan Event]struct{}
}

func newEvents() *events {
	return &events{subs: map[chan Event]struct{}{}}
}

func (e *events) publish(ev Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seq++
	ev.Seq = e.seq
	e.ring = append(e.ring, ev)
	if len(e.ring) > keptEvents {
		e.ring = e.ring[len(e.ring)-keptEvents:]
	}
	for ch := range e.subs {
		select {
		case ch <- ev:
		default:
			// A listener that doesn't keep up misses events rather than holding the daemon up
		}
	}
}

// subscribe is the kept events after seq, and a channel of those to come.
func (e *events) subscribe(after int64) ([]Event, chan Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var past []Event
	for _, ev := range e.ring {
		if ev.Seq > after {
			past = append(past, ev)
		}
	}
	ch := make(chan Event, 64)
	e.subs[ch] = struct{}{}
	return past, ch
}

func (e *events) unsubscribe(ch chan Event) {
	e.mu.Lock()
	delete(e.subs, ch)
	e.mu.Unlock()
}

// Recent is the kept events, oldest first.
func (s *Server) Recent() []Event {
	past, ch := s.ev.subscribe(0)
	s.ev.unsubscribe(ch)
	return past
}

// note logs what happened to subject and publishes it as an event of kind.
func (s *Server) note(kind, subject, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	s.o.Logf("%s: %s", subject, msg)
	s.ev.publish(Event{Time: time.Now(), Kind: kind, Subject: subject, Message: msg})
}

// serveEvents streams events as server-sent events: the kept ones after ?after= (all of them by
// default), then each as it happens, until the client goes.
func (s *Server) serveEvents(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	flusher, ok := w.(http.Flusher)
	if !ok {
		reply(w, nil, errStatus(500, "streaming is not supported here"))
		return
	}
	past, ch := s.ev.subscribe(after)
	defer s.ev.unsubscribe(ch)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	send := func(ev Event) bool {
		data, _ := json.Marshal(ev)
		_, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Kind, data)
		flusher.Flush()
		return err == nil
	}
	for _, ev := range past {
		if !send(ev) {
			return
		}
	}
	flusher.Flush()
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			if !send(ev) {
				return
			}
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// Stats is the daemon at a glance.
type Stats struct {
	Templates      int              `json:"templates"`
	TemplatesAwake int              `json:"templates_awake"`
	Machines       int              `json:"machines"`
	Services       int              `json:"services"`
	Snapshots      int              `json:"snapshots"`
	MemoryUsed     int64            `json:"memory_used"`
	MemoryBudget   int64            `json:"memory_budget"`
	Memory         map[string]int64 `json:"memory"`
	// The daemon's mode; its builds, those running, and the artifacts it keeps: how many, what
	// they take and the most they may (CacheSize, 0: no bound)
	Mode          string `json:"mode"`
	Builds        int    `json:"builds"`
	BuildsRunning int    `json:"builds_running"`
	Artifacts     int    `json:"artifacts"`
	CacheBytes    int64  `json:"cache_bytes"`
	CacheSize     int64  `json:"cache_size"`
}

// Stats counts what the daemon keeps and measures what it takes: Memory by template server
// ("template/NAME") and machine.
func (s *Server) Stats() Stats {
	st := Stats{MemoryBudget: s.o.Memory, Memory: map[string]int64{}, Mode: s.o.Features.Mode, CacheSize: s.o.CacheSize}
	s.builds.mu.Lock()
	st.Builds = len(s.builds.all)
	for _, b := range s.builds.all {
		if b.Status == "running" {
			st.BuildsRunning++
		}
	}
	st.CacheBytes, st.Artifacts = s.builds.cached()
	s.builds.mu.Unlock()
	// What it keeps for a mode with templates (none run in one without)
	if !s.o.Features.Templates {
		return st
	}
	for _, t := range s.Templates() {
		st.Templates++
		if !t.Asleep {
			st.TemplatesAwake++
			m := s.memOf(t.Pid)
			st.Memory["template/"+t.Name] = m
			st.MemoryUsed += m
		}
	}
	for _, m := range s.Machines(nil) {
		st.Machines++
		c := s.memOf(m.Pid)
		st.Memory[m.Name] = c
		st.MemoryUsed += c
	}
	st.Services = len(s.Services())
	st.Snapshots = len(s.Snapshots())
	return st
}
