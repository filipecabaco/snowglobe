package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/lifeline"
)

// BuildRequest asks the daemon to build a site and make it a template: from a directory on this
// host with a Dockerfile (Source), an image reference (Source), or a Dockerfile written out here
// (Dockerfile, which then can't COPY anything).
type BuildRequest struct {
	// The template's name (and the build's); made up when empty
	Name       string `json:"name"`
	Source     string `json:"source,omitempty"`
	Dockerfile string `json:"dockerfile,omitempty"`
	// "fetch" for a guest with a network (needed for ports); empty for none
	Network string `json:"network,omitempty"`
	Memory  int    `json:"memory_mb,omitempty"`
	CPUs    int    `json:"cpus,omitempty"`
	// docker or native; empty: Docker when it is there, else native (images only)
	Builder string `json:"builder,omitempty"`
	// Don't make it a template once built
	NoTemplate bool `json:"no_template,omitempty"`
}

// Build is a build of a site, running or done.
type Build struct {
	ID      string     `json:"id"`
	Name    string     `json:"name"`
	Kind    string     `json:"kind"` // dir, image or dockerfile
	Source  string     `json:"source,omitempty"`
	Network string     `json:"network,omitempty"`
	Memory  int        `json:"memory_mb,omitempty"`
	CPUs    int        `json:"cpus,omitempty"`
	Builder string     `json:"builder"`
	Status  string     `json:"status"` // queued, running, done, failed, cancelled, interrupted
	Created time.Time  `json:"created"`
	Started *time.Time `json:"started,omitempty"`
	Ended   *time.Time `json:"ended,omitempty"`
	// The built site, and the template made of it
	Site       string `json:"site,omitempty"`
	Template   string `json:"template,omitempty"`
	Error      string `json:"error,omitempty"`
	noTemplate bool
	dir        string
}

func (b *Build) finished() bool {
	switch b.Status {
	case "done", "failed", "cancelled", "interrupted":
		return true
	}
	return false
}

// How many builds run at once; the others wait their turn
var maxBuilds = 2

type builds struct {
	mu    sync.Mutex
	all   map[string]*Build
	procs map[string]*os.Process
	slots chan struct{}
	dir   string
}

func newBuilds(dir string) *builds {
	bs := &builds{all: map[string]*Build{}, procs: map[string]*os.Process{}, slots: make(chan struct{}, maxBuilds), dir: dir}
	// Those of earlier runs: a build that was running then is no more
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(dir, e.Name(), "build.json"))
		if err != nil {
			continue
		}
		var b Build
		if json.Unmarshal(data, &b) != nil || b.ID != e.Name() {
			continue
		}
		b.dir = filepath.Join(dir, b.ID)
		if !b.finished() {
			b.Status, b.Error = "interrupted", "the daemon stopped while it ran"
			now := time.Now()
			b.Ended = &now
			bs.write(&b)
		}
		bs.all[b.ID] = &b
	}
	return bs
}

// write keeps b's record in its directory.
func (bs *builds) write(b *Build) {
	data, _ := json.MarshalIndent(b, "", "  ")
	tmp := filepath.Join(b.dir, "build.json.tmp")
	if os.WriteFile(tmp, data, 0o600) == nil {
		os.Rename(tmp, filepath.Join(b.dir, "build.json"))
	}
}

func (s *Server) buildsRunning() int {
	s.builds.mu.Lock()
	defer s.builds.mu.Unlock()
	n := 0
	for _, b := range s.builds.all {
		if b.Status == "running" {
			n++
		}
	}
	return n
}

// StartBuild starts building a site: queued until there is room, then `snowglobe build`, its
// output in the build's log; once built, a template of it (unless NoTemplate).
func (s *Server) StartBuild(req BuildRequest) (*Build, error) {
	b := &Build{ID: randomName("build"), Name: req.Name, Network: req.Network, Memory: req.Memory, CPUs: req.CPUs,
		Builder: req.Builder, Status: "queued", Created: time.Now(), noTemplate: req.NoTemplate}
	if b.Name == "" {
		b.Name = b.ID
	}
	if err := validName(b.Name); err != nil {
		return nil, errStatus(400, "%v", err)
	}
	switch req.Network {
	case "", "none", "fetch":
	default:
		return nil, errStatus(400, "network: none or fetch")
	}
	if !b.noTemplate {
		s.mu.Lock()
		_, taken := s.st.Templates[b.Name]
		s.mu.Unlock()
		if taken {
			return nil, errStatus(409, "a template called %s exists already", b.Name)
		}
	}
	b.dir = filepath.Join(s.builds.dir, b.ID)
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		return nil, err
	}
	switch {
	case strings.TrimSpace(req.Dockerfile) != "" && req.Source != "":
		os.RemoveAll(b.dir)
		return nil, errStatus(400, "a source or a Dockerfile, not both")
	case strings.TrimSpace(req.Dockerfile) != "":
		b.Kind = "dockerfile"
		src := filepath.Join(b.dir, "src")
		if err := os.MkdirAll(src, 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(src, "Dockerfile"), []byte(req.Dockerfile), 0o600); err != nil {
			return nil, err
		}
		b.Source = src
	case req.Source == "":
		os.RemoveAll(b.dir)
		return nil, errStatus(400, "a source (a directory with a Dockerfile, or an image) or a Dockerfile")
	default:
		b.Source = req.Source
		if fi, err := os.Stat(req.Source); err == nil {
			if !filepath.IsAbs(req.Source) {
				os.RemoveAll(b.dir)
				return nil, errStatus(400, "a directory must be given by its full path (the daemon's working directory is not yours)")
			}
			if !fi.IsDir() {
				os.RemoveAll(b.dir)
				return nil, errStatus(400, "%s is not a directory", req.Source)
			}
			b.Kind = "dir"
		} else {
			b.Kind = "image"
		}
	}
	if b.Builder == "" {
		b.Builder = "docker"
		if !s.dockerThere() {
			if b.Kind != "image" {
				os.RemoveAll(b.dir)
				return nil, errStatus(400, "building from a Dockerfile needs Docker, which isn't running here (an image reference builds without it)")
			}
			b.Builder = "native"
		}
	}
	if b.Builder != "docker" && b.Builder != "native" {
		os.RemoveAll(b.dir)
		return nil, errStatus(400, "builder: docker or native")
	}
	if b.Builder == "native" && b.Kind != "image" {
		os.RemoveAll(b.dir)
		return nil, errStatus(400, "the native builder builds from an image reference: a Dockerfile needs Docker")
	}
	b.Site = filepath.Join(b.dir, "site")
	s.builds.mu.Lock()
	s.builds.all[b.ID] = b
	s.builds.write(b)
	c := *b
	s.builds.mu.Unlock()
	s.meter.build()
	s.note("build.queued", "build "+b.ID, "%s from %s (%s)", b.Name, b.Source, b.Kind)
	go s.runBuild(b)
	return &c, nil
}

// dockerThere says whether Docker can build here.
func (s *Server) dockerThere() bool {
	if s.o.dockerThere != nil {
		return s.o.dockerThere()
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return false
	}
	return exec.Command("docker", "info", "--format", "{{.ServerVersion}}").Run() == nil
}

func (s *Server) runBuild(b *Build) {
	s.builds.slots <- struct{}{}
	defer func() { <-s.builds.slots }()
	s.builds.mu.Lock()
	if b.Status != "queued" {
		s.builds.mu.Unlock()
		return
	}
	now := time.Now()
	b.Status, b.Started = "running", &now
	s.builds.write(b)
	args := []string{"build", b.Source, "--out", b.Site, "--sandbox", "--builder", b.Builder}
	if b.Network == "fetch" {
		args = append(args, "--network", "fetch")
	}
	if b.Memory > 0 {
		args = append(args, "--memory", strconv.Itoa(b.Memory))
	}
	if b.CPUs > 0 {
		args = append(args, "--cpus", strconv.Itoa(b.CPUs))
	}
	log, err := os.OpenFile(filepath.Join(b.dir, "build.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	var cmd *exec.Cmd
	if err == nil {
		fmt.Fprintf(log, "$ snowglobe %s\n", strings.Join(args, " "))
		cmd = exec.Command(s.snowglobe(), args...)
		cmd.Stdout, cmd.Stderr = log, log
		// Its log is read as text, by people and agents: no colour codes in it
		cmd.Env = append(os.Environ(), "NO_COLOR=1", "TERM=dumb")
		// Its own process group: a cancel, or the daemon stopping, stops what it started too
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		// And it ends with the daemon, however that ends (its snapshot with it, by a lifeline of
		// its own)
		if err = lifeline.Pass(cmd); err == nil {
			err = cmd.Start()
		}
	}
	if err == nil {
		s.builds.procs[b.ID] = cmd.Process
	}
	s.builds.mu.Unlock()
	s.note("build.started", "build "+b.ID, "%s: snowglobe build %s", b.Name, b.Source)
	if err == nil {
		err = cmd.Wait()
	}
	if log != nil {
		log.Close()
	}

	s.builds.mu.Lock()
	delete(s.builds.procs, b.ID)
	// Cancelled, or interrupted by the daemon stopping (stopAll): it says so already
	cancelled := b.Status == "cancelled" || b.Status == "interrupted"
	s.builds.mu.Unlock()
	if !cancelled && err == nil && !b.noTemplate {
		if _, terr := s.AddTemplate(AddTemplate{Site: b.Site, Name: b.Name}); terr != nil {
			err = fmt.Errorf("built, but its template: %w", terr)
		}
	}
	s.builds.mu.Lock()
	end := time.Now()
	b.Ended = &end
	switch {
	case cancelled:
	case err != nil:
		b.Status = "failed"
		var x *exec.ExitError
		if errors.As(err, &x) {
			b.Error = fmt.Sprintf("snowglobe build exited %d: %s", x.ExitCode(), lastLines(filepath.Join(b.dir, "build.log"), 1))
		} else {
			b.Error = err.Error()
		}
	default:
		b.Status = "done"
		if !b.noTemplate {
			b.Template = b.Name
		}
	}
	s.builds.write(b)
	c := *b
	s.builds.mu.Unlock()
	switch c.Status {
	case "done":
		s.note("build.done", "build "+c.ID, "%s built in %s", c.Name, end.Sub(*c.Started).Round(time.Second))
	case "failed":
		s.note("build.failed", "build "+c.ID, "%s: %s", c.Name, c.Error)
	}
}

// snowglobe is the snowglobe command that builds: Options.Snowglobe, else this program.
func (s *Server) snowglobe() string {
	if s.o.Snowglobe != "" {
		return s.o.Snowglobe
	}
	self, err := os.Executable()
	if err != nil {
		return "snowglobe"
	}
	return self
}

// Builds is every build, newest first.
func (s *Server) Builds() []Build {
	s.builds.mu.Lock()
	defer s.builds.mu.Unlock()
	out := []Build{}
	for _, b := range s.builds.all {
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out
}

// Build is the build called id.
func (s *Server) Build(id string) (*Build, error) {
	s.builds.mu.Lock()
	defer s.builds.mu.Unlock()
	b, ok := s.builds.all[id]
	if !ok {
		return nil, errStatus(404, "no build called %s", id)
	}
	c := *b
	return &c, nil
}

// RemoveBuild cancels a build that is queued or running; one that is done goes with its site,
// unless a template still runs from it.
func (s *Server) RemoveBuild(id string) error {
	s.builds.mu.Lock()
	b, ok := s.builds.all[id]
	if !ok {
		s.builds.mu.Unlock()
		return errStatus(404, "no build called %s", id)
	}
	if !b.finished() {
		b.Status = "cancelled"
		now := time.Now()
		b.Ended = &now
		if p := s.builds.procs[id]; p != nil {
			syscall.Kill(-p.Pid, syscall.SIGTERM)
		}
		s.builds.write(b)
		s.builds.mu.Unlock()
		s.note("build.cancelled", "build "+id, "%s", b.Name)
		return nil
	}
	site := b.Site
	s.builds.mu.Unlock()
	s.mu.Lock()
	for _, t := range s.st.Templates {
		if t.Site == site {
			s.mu.Unlock()
			return errStatus(409, "template %s runs from build %s: remove it first", t.Name, id)
		}
	}
	s.mu.Unlock()
	s.builds.mu.Lock()
	delete(s.builds.all, id)
	s.builds.mu.Unlock()
	return os.RemoveAll(b.dir)
}

// serveBuildLog answers /v1/builds/{id}/log: the log from ?offset= on; with ?follow=1, kept open
// with what comes until the build ends.
func (s *Server) serveBuildLog(w http.ResponseWriter, r *http.Request) {
	b, err := s.Build(r.PathValue("id"))
	if err != nil {
		reply(w, nil, err)
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	follow := r.URL.Query().Get("follow") == "1"
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, _ := w.(http.Flusher)
	path := filepath.Join(b.dir, "build.log")
	for {
		if f, err := os.Open(path); err == nil {
			f.Seek(offset, io.SeekStart)
			n, _ := io.Copy(w, f)
			f.Close()
			offset += n
			if flusher != nil && n > 0 {
				flusher.Flush()
			}
		}
		if !follow {
			return
		}
		cur, err := s.Build(b.ID)
		if err != nil || cur.finished() {
			// What was written as it ended
			if f, err := os.Open(path); err == nil {
				f.Seek(offset, io.SeekStart)
				io.Copy(w, f)
				f.Close()
			}
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *Server) buildRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/builds", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Builds(), nil)
	})
	mux.HandleFunc("POST /v1/builds", func(w http.ResponseWriter, r *http.Request) {
		var req BuildRequest
		if err := decode(r, &req); err != nil {
			reply(w, nil, err)
			return
		}
		v, err := s.StartBuild(req)
		reply(w, v, err)
	})
	mux.HandleFunc("GET /v1/builds/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.Build(r.PathValue("id"))
		reply(w, v, err)
	})
	mux.HandleFunc("DELETE /v1/builds/{id}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"removed": r.PathValue("id")}, s.RemoveBuild(r.PathValue("id")))
	})
	mux.HandleFunc("GET /v1/builds/{id}/log", s.serveBuildLog)
}
