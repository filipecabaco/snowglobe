package daemon

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// What a machine of a template is guessed to cost before one has been measured
const defaultMachineCost = 64 << 20

// ParseSize reads "512M", "8G", "1.5G" or bytes.
func ParseSize(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToUpper(s))
	mult := int64(1)
	for suffix, m := range map[string]int64{"K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40} {
		if strings.HasSuffix(s, suffix) || strings.HasSuffix(s, suffix+"B") || strings.HasSuffix(s, suffix+"IB") {
			s = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(s, "IB"), "B"), suffix)
			mult = m
			break
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("size %q: bytes, or a number with K, M, G or T", s)
	}
	return int64(f * float64(mult)), nil
}

func mb(n int64) string { return fmt.Sprintf("%d MB", n>>20) }

// lifecycleState is the daemon's bookkeeping for limits and lifecycle.
type lifecycleState struct {
	// One admission at a time, in the order they came: each holds it until its machine is up
	admit sync.Mutex
	// Templates being woken, one start each
	waking map[string]*sync.Mutex
	// When each template last had a machine or a job
	lastUsed map[string]time.Time
	mu       sync.Mutex
}

func newLifecycle() *lifecycleState {
	return &lifecycleState{waking: map[string]*sync.Mutex{}, lastUsed: map[string]time.Time{}}
}

func (s *Server) used(template string) {
	s.life.mu.Lock()
	s.life.lastUsed[template] = time.Now()
	s.life.mu.Unlock()
}

// MemoryUsed is what the daemon's template servers and machines take now.
func (s *Server) MemoryUsed() int64 {
	var total int64
	for _, t := range s.Templates() {
		if !t.Asleep {
			total += s.memOf(t.Pid)
		}
	}
	for _, m := range s.Machines(nil) {
		total += s.memOf(m.Pid)
	}
	return total
}

// estimate is what a new machine of t is guessed to cost: the median of its machines now, else
// defaultMachineCost.
func (s *Server) estimate(t string) int64 {
	var costs []int64
	for _, m := range s.Machines(nil) {
		if m.Template == t {
			if c := s.memOf(m.Pid); c > 0 {
				costs = append(costs, c)
			}
		}
	}
	if len(costs) == 0 {
		return defaultMachineCost
	}
	sort.Slice(costs, func(i, j int) bool { return costs[i] < costs[j] })
	return costs[len(costs)/2]
}

// admit waits (up to Options.Wait) until a machine of t fits the memory budget, and holds
// admissions until release is called (once the machine is up), so that two never both take the
// last room. With no budget it admits at once.
func (s *Server) admit(t string) (release func(), err error) {
	if s.o.Memory <= 0 {
		return func() {}, nil
	}
	begun := time.Now()
	s.life.admit.Lock()
	for {
		used, need := s.MemoryUsed(), s.estimate(t)
		if used+need <= s.o.Memory {
			if waited := time.Since(begun); waited > 100*time.Millisecond {
				s.note("admission.waited", "template "+t, "a machine admitted after waiting %s for memory", waited.Round(time.Millisecond))
			}
			return s.life.admit.Unlock, nil
		}
		if time.Since(begun) >= s.o.Wait {
			s.life.admit.Unlock()
			s.note("admission.refused", "template "+t, "no room for a machine: %s used of %s, about %s needed", mb(used), mb(s.o.Memory), mb(need))
			return nil, errStatus(429, "no room in the memory budget: %s used of %s, and a machine of %s takes about %s (waited %s)",
				mb(used), mb(s.o.Memory), t, mb(need), s.o.Wait)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// awake is template name with its server running: started again first if it was asleep.
func (s *Server) awake(name string) (*Template, error) {
	s.life.mu.Lock()
	lock := s.life.waking[name]
	if lock == nil {
		lock = &sync.Mutex{}
		s.life.waking[name] = lock
	}
	s.life.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	s.mu.Lock()
	t, ok := s.st.Templates[name]
	var c Template
	if ok {
		c = *t
	}
	s.mu.Unlock()
	if !ok {
		return nil, errStatus(404, "no template called %s", name)
	}
	if !c.Asleep {
		return &c, nil
	}
	begun := time.Now()
	if err := s.startServer(&c); err != nil {
		return nil, err
	}
	c.Asleep = false
	s.mu.Lock()
	if t, ok := s.st.Templates[name]; ok {
		*t = c
		s.save()
	}
	s.mu.Unlock()
	s.used(name)
	s.note("template.awake", "template "+name, "awake in %d ms", time.Since(begun).Milliseconds())
	return &c, nil
}

// lifecycle stops machines past their time to live, and the servers of templates that have had no
// machine or job for their idle time.
func (s *Server) lifecycle() {
	now := time.Now()
	for _, m := range s.Machines(nil) {
		if m.Expires != nil && now.After(*m.Expires) {
			s.RemoveMachine(m.Name)
			s.note("machine.expired", "machine "+m.Name, "its time to live is up")
		}
	}
	busy := map[string]bool{}
	for _, m := range s.Machines(nil) {
		busy[m.Template] = true
	}
	for _, t := range s.Templates() {
		if t.Idle <= 0 || t.Asleep || busy[t.Name] {
			continue
		}
		s.life.mu.Lock()
		last, seen := s.life.lastUsed[t.Name]
		if !seen {
			// Taken back by a daemon started again, or never used: idle from now
			s.life.lastUsed[t.Name] = now
			last = now
		}
		s.life.mu.Unlock()
		if now.Sub(last) >= time.Duration(t.Idle) {
			s.sleep(t.Name)
		}
	}
}

// sleep stops an idle template's server; its next use starts it again.
func (s *Server) sleep(name string) {
	s.life.mu.Lock()
	lock := s.life.waking[name]
	if lock == nil {
		lock = &sync.Mutex{}
		s.life.waking[name] = lock
	}
	s.life.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	s.mu.Lock()
	t, ok := s.st.Templates[name]
	if !ok || t.Asleep {
		s.mu.Unlock()
		return
	}
	for _, m := range s.st.Machines {
		if m.Template == name {
			// A machine came meanwhile
			s.mu.Unlock()
			return
		}
	}
	pid, dir := t.Pid, t.SocketDir
	t.Asleep, t.Pid, t.Ready = true, 0, ""
	s.save()
	s.mu.Unlock()
	syscall.Kill(-pid, syscall.SIGTERM)
	if !gone(pid, stopGrace) {
		syscall.Kill(-pid, syscall.SIGKILL)
	}
	os.RemoveAll(dir)
	s.note("template.asleep", "template "+name, "asleep, idle %s", time.Duration(t.Idle))
}
