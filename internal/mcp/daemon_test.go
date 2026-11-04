package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// fakeDaemon keeps templates, machines and builds in memory and records the jobs it is sent.
type fakeDaemon struct {
	templates []daemon.Template
	machines  map[string]daemon.Machine
	services  []daemon.ServiceStatus
	snapshots []daemon.Snapshot
	builds    map[string]*daemon.Build
	jobs      []string // where:cmd
	files     map[string][]byte
	events    []daemon.Event
}

func newFake() *fakeDaemon {
	return &fakeDaemon{machines: map[string]daemon.Machine{}, builds: map[string]*daemon.Build{}, files: map[string][]byte{}}
}

func ok(out string) *control.JobResult {
	z := 0
	return &control.JobResult{Status: &z, Output: []byte(out)}
}

func (f *fakeDaemon) Templates() ([]daemon.Template, error) { return f.templates, nil }
func (f *fakeDaemon) Snapshots() ([]daemon.Snapshot, error) { return f.snapshots, nil }
func (f *fakeDaemon) Services() ([]daemon.ServiceStatus, error) {
	return f.services, nil
}
func (f *fakeDaemon) Machines(labels map[string]string) ([]daemon.Machine, error) {
	var out []daemon.Machine
	for _, m := range f.machines {
		if labels["app"] == "" || m.Labels["app"] == labels["app"] {
			out = append(out, m)
		}
	}
	return out, nil
}
func (f *fakeDaemon) AddTemplate(r daemon.AddTemplate) (*daemon.Template, error) {
	t := daemon.Template{Name: r.Name, Site: r.Site, Idle: r.Idle}
	f.templates = append(f.templates, t)
	return &t, nil
}
func (f *fakeDaemon) RemoveTemplate(name string) error { return nil }
func (f *fakeDaemon) SnapshotWith(m, name string, l map[string]string) (*daemon.Snapshot, error) {
	s := daemon.Snapshot{Name: name, Machine: m}
	f.snapshots = append(f.snapshots, s)
	return &s, nil
}
func (f *fakeDaemon) RemoveSnapshot(string) error { return nil }
func (f *fakeDaemon) AddService(s daemon.Service) (*daemon.ServiceStatus, error) {
	st := daemon.ServiceStatus{Service: s}
	f.services = append(f.services, st)
	return &st, nil
}
func (f *fakeDaemon) RemoveService(string) error { return nil }
func (f *fakeDaemon) Up(u daemon.Up) (*daemon.Machine, error) {
	if u.Template == "" {
		return nil, fmt.Errorf("no template called %q", u.Template)
	}
	m := daemon.Machine{Name: u.Name, Template: u.Template, Labels: u.Labels}
	f.machines[u.Name] = m
	return &m, nil
}
func (f *fakeDaemon) RemoveMachine(name string) error { delete(f.machines, name); return nil }
func (f *fakeDaemon) Job(name string, req control.JobRequest) (*control.JobResult, error) {
	f.jobs = append(f.jobs, "machine "+name+": "+req.Cmd)
	switch {
	case req.Files["payload"] != nil:
		f.files[name] = req.Files["payload"]
		return ok(""), nil
	case strings.HasPrefix(req.Cmd, "cp "):
		r := ok("")
		r.Out = map[string][]byte{"file": f.files[name]}
		return r, nil
	case req.Cmd == "false":
		one := 1
		return &control.JobResult{Status: &one, Output: []byte("nope\n")}, nil
	}
	return ok(req.Cmd + " ran\n"), nil
}
func (f *fakeDaemon) TemplateJob(name string, req control.JobRequest) (*control.JobResult, error) {
	f.jobs = append(f.jobs, "template "+name+": "+req.Cmd)
	return ok("fresh\n"), nil
}
func (f *fakeDaemon) ServiceJob(name string, req control.JobRequest) (*control.JobResult, error) {
	f.jobs = append(f.jobs, "service "+name+": "+req.Cmd)
	return ok("replica\n"), nil
}
func (f *fakeDaemon) Stats() (*daemon.Stats, error) {
	return &daemon.Stats{Machines: len(f.machines), MemoryUsed: 852 << 20}, nil
}
func (f *fakeDaemon) Metrics(since time.Time) (*daemon.Metrics, error) {
	return &daemon.Metrics{Samples: []daemon.Sample{{Jobs: 3, Ups: 1, JobMsP95: 40}, {Jobs: 2, JobMsP95: 61}}, Totals: daemon.Totals{Jobs: 99}}, nil
}
func (f *fakeDaemon) Builds() ([]daemon.Build, error) { return nil, nil }
func (f *fakeDaemon) StartBuild(r daemon.BuildRequest) (*daemon.Build, error) {
	b := &daemon.Build{ID: "build-1", Name: r.Name, Status: "running"}
	if strings.Contains(r.Source, "fail") {
		b.ID = "build-2"
	}
	f.builds[b.ID] = b
	return b, nil
}
func (f *fakeDaemon) Build(id string) (*daemon.Build, error) {
	b := f.builds[id]
	if b == nil {
		return nil, fmt.Errorf("no build called %s", id)
	}
	// It finishes on the next look
	if b.Status == "running" {
		b.Status = "done"
		if id == "build-2" {
			b.Status, b.Error = "failed", "snowglobe build exited 3"
		}
	}
	c := *b
	return &c, nil
}
func (f *fakeDaemon) RemoveBuild(string) error { return nil }
func (f *fakeDaemon) BuildLog(id string, offset int64) (string, error) {
	log := "==> building\n==> done\n"
	return log[min(int(offset), len(log)):], nil
}
func (f *fakeDaemon) Events(ctx context.Context, after int64, fn func(daemon.Event) bool) error {
	for _, ev := range f.events {
		if ev.Seq > after && !fn(ev) {
			return nil
		}
	}
	<-ctx.Done()
	return nil
}

// call runs one tool through the protocol and returns its text and whether it is an error.
func call(t *testing.T, d *Daemon, name string, a map[string]any) (string, bool) {
	t.Helper()
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": a}})
	var out bytes.Buffer
	if err := d.Serve(bytes.NewReader(append(req, '\n')), &out); err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Result struct {
			Content []struct{ Text string } `json:"content"`
			IsError bool                    `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil {
		t.Fatalf("%s: %v", out.String(), err)
	}
	return reply.Result.Content[0].Text, reply.Result.IsError
}

func TestTheDaemonsToolsAreListedWithSchemas(t *testing.T) {
	var out bytes.Buffer
	(&Daemon{API: newFake(), Version: "v"}).Serve(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`+"\n"+`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`+"\n"), &out)
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if !strings.Contains(lines[0], "snowglobe daemon") {
		t.Errorf("instructions: %s", lines[0])
	}
	var list struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	json.Unmarshal([]byte(lines[1]), &list)
	names := map[string]bool{}
	for _, tl := range list.Result.Tools {
		names[tl.Name] = true
		if tl.InputSchema["type"] != "object" {
			t.Errorf("%s: schema %v", tl.Name, tl.InputSchema)
		}
	}
	for _, want := range []string{"status", "up", "run_command", "write_file", "read_file", "snapshot_machine", "add_service", "build", "build_status", "recent_events", "fleet_diff", "fleet_apply"} {
		if !names[want] {
			t.Errorf("no %s tool", want)
		}
	}
}

func TestMachinesAreUpRunAndStoppedThroughTools(t *testing.T) {
	f := newFake()
	d := &Daemon{API: f, Version: "v"}
	if text, isErr := call(t, d, "up", map[string]any{"template": "py", "name": "w", "ttl": "1h", "labels": map[string]any{"app": "etl"}}); isErr || !strings.Contains(text, `"name": "w"`) {
		t.Fatalf("up: %s", text)
	}
	if _, isErr := call(t, d, "up", map[string]any{"template": "py", "ttl": "soon"}); !isErr {
		t.Error("a bad ttl")
	}
	if text, isErr := call(t, d, "run_command", map[string]any{"machine": "w", "command": "ls"}); isErr || text != "ls ran\n[exit 0]" {
		t.Errorf("on a machine: %q %v", text, isErr)
	}
	if text, isErr := call(t, d, "run_command", map[string]any{"machine": "w", "command": "false"}); !isErr || !strings.Contains(text, "[exit 1]") {
		t.Errorf("a failing command: %q %v", text, isErr)
	}
	call(t, d, "run_command", map[string]any{"template": "py", "command": "x"})
	call(t, d, "run_command", map[string]any{"service": "web", "command": "y"})
	if _, isErr := call(t, d, "run_command", map[string]any{"machine": "w", "template": "py", "command": "z"}); !isErr {
		t.Error("two targets at once")
	}
	if strings.Join(f.jobs, "|") != "machine w: ls|machine w: false|template py: x|service web: y" {
		t.Errorf("jobs: %v", f.jobs)
	}
	if text, isErr := call(t, d, "write_file", map[string]any{"machine": "w", "path": "/root/a.txt", "content": "hello"}); isErr || text != "wrote 5 bytes to /root/a.txt" {
		t.Errorf("write: %q", text)
	}
	if text, _ := call(t, d, "read_file", map[string]any{"machine": "w", "path": "/root/a.txt"}); text != "hello" {
		t.Errorf("read: %q", text)
	}
	if _, isErr := call(t, d, "write_file", map[string]any{"machine": "w", "path": "rel", "content": ""}); !isErr {
		t.Error("a relative path")
	}
	if text, _ := call(t, d, "list_machines", map[string]any{"labels": map[string]any{"app": "etl"}}); !strings.Contains(text, `"w"`) {
		t.Errorf("by label: %s", text)
	}
	call(t, d, "stop_machine", map[string]any{"name": "w"})
	if len(f.machines) != 0 {
		t.Error("not stopped")
	}
}

func TestServicesStatusAndEvents(t *testing.T) {
	f := newFake()
	f.events = []daemon.Event{{Seq: 1, Kind: "machine.up", Subject: "machine a"}, {Seq: 2, Kind: "build.done", Subject: "build b"}}
	d := &Daemon{API: f, Version: "v"}
	if text, isErr := call(t, d, "add_service", map[string]any{"name": "web", "template": "api", "ports": []any{"8080:8000"}, "min": 0, "max": 3, "idle": "5m"}); isErr || !strings.Contains(text, `"max": 3`) {
		t.Fatalf("service: %s", text)
	}
	if f.services[0].Ports[0].Host != 8080 || f.services[0].Idle != daemon.Duration(5*time.Minute) {
		t.Errorf("as asked: %+v", f.services[0].Service)
	}
	if text, isErr := call(t, d, "add_service", map[string]any{"name": "x", "template": "api", "ports": []any{"nope"}}); !isErr {
		t.Errorf("a bad port: %s", text)
	}
	text, _ := call(t, d, "status", nil)
	if !strings.Contains(text, `"jobs": 5`) || !strings.Contains(text, `"worst_job_ms_p95": 61`) || !strings.Contains(text, `"jobs": 99`) {
		t.Errorf("status: %s", text)
	}
	if text, _ := call(t, d, "recent_events", map[string]any{"after": 1}); !strings.Contains(text, "build.done") || strings.Contains(text, "machine.up") {
		t.Errorf("events after 1: %s", text)
	}
}

func TestBuildsWaitForTheirResult(t *testing.T) {
	f := newFake()
	d := &Daemon{API: f, Version: "v"}
	text, isErr := call(t, d, "build", map[string]any{"name": "app", "source": "/src/app"})
	if isErr || !strings.Contains(text, `"status": "done"`) || !strings.Contains(text, "==> done") {
		t.Errorf("a build that works: %q", text)
	}
	text, isErr = call(t, d, "build", map[string]any{"name": "bad", "source": "/src/fail"})
	if !isErr || !strings.Contains(text, "exited 3") {
		t.Errorf("one that fails: %q", text)
	}
	f.builds["build-1"].Status = "running"
	if text, _ := call(t, d, "build", map[string]any{"name": "app", "source": "/src/app", "wait": false}); !strings.Contains(text, `"status": "running"`) {
		t.Errorf("without waiting: %q", text)
	}
	if text, _ := call(t, d, "build_status", map[string]any{"id": "build-1", "log_offset": 13}); !strings.Contains(text, "log:\n==> done") {
		t.Errorf("status with a log offset: %q", text)
	}
}

func TestAFleetFileIsDiffedThroughTheDaemon(t *testing.T) {
	f := newFake()
	d := &Daemon{API: f, Version: "v"}
	dir := t.TempDir()
	site := filepath.Join(dir, "site")
	os.MkdirAll(site, 0o755)
	file := filepath.Join(dir, "snowglobe.toml")
	os.WriteFile(file, []byte("name = \"demo\"\n[templates.py]\nsite = \"site\"\n[machines.w]\ntemplate = \"py\"\n"), 0o644)
	text, isErr := call(t, d, "fleet_diff", map[string]any{"file": file})
	if isErr || !strings.Contains(text, "fleet demo:") || !strings.Contains(text, "template py") || !strings.Contains(text, "machine w") {
		t.Errorf("diff: %q", text)
	}
	if _, isErr := call(t, d, "fleet_diff", map[string]any{"file": "snowglobe.toml"}); !isErr {
		t.Error("a relative path")
	}
	if len(f.templates) != 0 || len(f.machines) != 0 {
		t.Error("diff changed something")
	}
	text, isErr = call(t, d, "fleet_apply", map[string]any{"file": file})
	if isErr || len(f.templates) != 1 || len(f.machines) != 1 {
		t.Errorf("apply: %q %v %+v", text, isErr, f.machines)
	}
}
