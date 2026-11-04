package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/daemon"
	"github.com/filipecabaco/snowglobe/internal/fleet"
)

// DaemonAPI is what the daemon's MCP server needs of a daemon (daemon.Client).
type DaemonAPI interface {
	fleet.API
	Stats() (*daemon.Stats, error)
	Metrics(since time.Time) (*daemon.Metrics, error)
	TemplateJob(name string, req control.JobRequest) (*control.JobResult, error)
	ServiceJob(name string, req control.JobRequest) (*control.JobResult, error)
	Builds() ([]daemon.Build, error)
	StartBuild(daemon.BuildRequest) (*daemon.Build, error)
	Build(id string) (*daemon.Build, error)
	RemoveBuild(id string) error
	BuildLog(id string, offset int64) (string, error)
	Events(ctx context.Context, after int64, f func(daemon.Event) bool) error
}

// Daemon serves a snowglobe daemon to an agent: its templates, machines, snapshots, services,
// builds, fleets and metrics as MCP tools.
type Daemon struct {
	API     DaemonAPI
	Version string
	// Build builds a fleet's Dockerfile directories (snowglobe build --sandbox)
	Build fleet.Builder
	// How long build waits at most when asked to wait (default 20 minutes)
	BuildWait time.Duration
}

// Serve answers requests from r on w until r ends.
func (d *Daemon) Serve(r io.Reader, w io.Writer) error {
	return serveRPC(r, w, d.Version, d)
}

// Stdio serves on this process's stdin and stdout.
func (d *Daemon) Stdio() error { return d.Serve(os.Stdin, os.Stdout) }

func (d *Daemon) instructions() string {
	return "A snowglobe daemon: it restores sites (Docker images packaged by snowglobe) once as templates and forks " +
		"emulated arm64 Linux machines from them in milliseconds, with no Docker, KVM or root. Typical flow: " +
		"list_templates (or build to make one from a Dockerfile or image), then run_command with a template for a " +
		"throwaway fork, or up for a machine that lasts and run_command / write_file / read_file on it, " +
		"snapshot_machine to save one set up, add_service for machines behind a port that scale to zero, and " +
		"fleet_diff / fleet_apply for a whole snowglobe.toml. status shows memory, counts and latencies."
}

func obj(props map[string]any, required ...string) map[string]any {
	o := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func num(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }
func boolean(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}
func strs(desc string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": desc}
}
func labels() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "Labels, key to value"}
}

func tool(name, desc string, schema map[string]any) map[string]any {
	return map[string]any{"name": name, "description": desc, "inputSchema": schema}
}

var daemonTools = []map[string]any{
	tool("status", "The daemon at a glance: memory used against its budget, templates (awake), machines, services, snapshots, builds running, and jobs, machines started and job latency over the last minutes.", obj(map[string]any{})),
	tool("list_templates", "Templates: sites restored once, which machines fork from.", obj(map[string]any{})),
	tool("add_template", "Restore a built site once as a template (a directory, a tarball, or a deployed site's URL), or make one from a snapshot.", obj(map[string]any{
		"site": str("The built site (omit with snapshot)"), "name": str("Its name"), "snapshot": str("Start it from this snapshot instead"),
		"idle": str("Stop its server after this long without a machine, e.g. 30m"), "max_machines": num("Most machines at once"), "labels": labels(),
	})),
	tool("remove_template", "Remove a template and every machine forked from it.", obj(map[string]any{"name": str("The template")}, "name")),
	tool("list_machines", "Machines: lasting forks of templates, with their ports, labels and expiry.", obj(map[string]any{"labels": labels()})),
	tool("up", "Fork a machine that lasts from a template, in tens of milliseconds. It keeps what it writes until stopped.", obj(map[string]any{
		"template": str("The template"), "name": str("Its name (made up when omitted)"), "ports": strs("Ports to forward, [HOST:]GUEST (the site needs a network)"),
		"ttl": str("Stop it after this long, e.g. 1h"), "snapshot": str("Start from this snapshot of the template's site"), "labels": labels(),
	}, "template")),
	tool("stop_machine", "Stop a machine and throw it away.", obj(map[string]any{"name": str("The machine")}, "name")),
	tool("run_command", "Run a shell command (/bin/sh) and return its output and exit status: on a machine (it keeps what the command does), on a fresh fork of a template (thrown away after), or on a service's replica. Give exactly one of machine, template or service.", obj(map[string]any{
		"command": str("The command line"), "machine": str("A machine"), "template": str("A template: a fresh fork, thrown away after"), "service": str("A service: one of its replicas"),
		"timeout_seconds": num("Kill it, and everything it started, after this long (default 300)"), "env": labels(),
	}, "command")),
	tool("write_file", "Write a text file on a machine (an absolute path; directories are made).", obj(map[string]any{
		"machine": str("The machine"), "path": str("Absolute path"), "content": str("The text"),
	}, "machine", "path", "content")),
	tool("read_file", "Read a file from a machine (an absolute path).", obj(map[string]any{"machine": str("The machine"), "path": str("Absolute path")}, "machine", "path")),
	tool("snapshot_machine", "Save a running machine whole (memory, processes, files), to start machines or a template from it.", obj(map[string]any{
		"machine": str("The machine"), "name": str("The snapshot's name"), "labels": labels(),
	}, "machine")),
	tool("list_snapshots", "Snapshots of machines.", obj(map[string]any{})),
	tool("remove_snapshot", "Remove a snapshot.", obj(map[string]any{"name": str("The snapshot")}, "name")),
	tool("list_services", "Services: a template's machines behind host ports, with their replicas now.", obj(map[string]any{})),
	tool("add_service", "Put a template's machines behind host ports: each connection goes to a replica started on demand; with min 0 it scales to zero when idle.", obj(map[string]any{
		"name": str("Its name"), "template": str("The template (its site needs a network)"), "ports": strs("[IP:]HOST:GUEST"),
		"min": num("Replicas kept running (0: scale to zero)"), "max": num("Most replicas (default 1)"), "idle": str("Stop a replica idle this long, e.g. 5m"),
		"concurrency": num("Connections a replica takes before another starts"), "state": str("discard (default) or keep: carry a replica's state across zero"), "labels": labels(),
	}, "name", "template", "ports")),
	tool("remove_service", "Remove a service and its replicas.", obj(map[string]any{"name": str("The service")}, "name")),
	tool("build", "Build a site from a Dockerfile directory on the daemon's host (full path), an image reference, or a Dockerfile's text, and make it a template. Waits for it unless wait is false.", obj(map[string]any{
		"name": str("The template's name"), "source": str("A directory with a Dockerfile (full path) or an image reference"), "dockerfile": str("A Dockerfile's text (it can't COPY anything)"),
		"network": str("fetch for a guest with a network (needed for ports), or none"), "memory_mb": num("Guest RAM"), "cpus": num("Guest CPUs"),
		"no_template": boolean("Don't make it a template"), "wait": boolean("Wait until it is done (default true)"),
	})),
	tool("build_status", "A build's state and its log (from log_offset on).", obj(map[string]any{"id": str("The build"), "log_offset": num("Where to read the log from")}, "id")),
	tool("list_builds", "Builds, newest first.", obj(map[string]any{})),
	tool("cancel_build", "Cancel a running build, or remove a finished one.", obj(map[string]any{"id": str("The build")}, "id")),
	tool("recent_events", "What the daemon did lately: machines up and stopped, replicas, templates asleep and awake, builds, refusals.", obj(map[string]any{"after": num("Only events after this sequence number")})),
	tool("fleet_diff", "What applying a fleet file (snowglobe.toml) would change.", obj(map[string]any{"file": str("Path to the fleet file on the daemon's host")}, "file")),
	tool("fleet_apply", "Get the daemon to what a fleet file (snowglobe.toml) says: build, create, replace and remove.", obj(map[string]any{"file": str("Path to the fleet file on the daemon's host")}, "file")),
}

func (d *Daemon) list() []map[string]any { return daemonTools }

// args reads a tool's arguments.
type args map[string]any

func (a args) str(k string) string { v, _ := a[k].(string); return v }
func (a args) num(k string) float64 {
	v, _ := a[k].(float64)
	return v
}
func (a args) bool(k string, dflt bool) bool {
	if v, ok := a[k].(bool); ok {
		return v
	}
	return dflt
}
func (a args) strs(k string) []string {
	var out []string
	if vs, ok := a[k].([]any); ok {
		for _, v := range vs {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func (a args) labels(k string) map[string]string {
	m := map[string]string{}
	if vs, ok := a[k].(map[string]any); ok {
		for key, v := range vs {
			if s, ok := v.(string); ok {
				m[key] = s
			}
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}
func (a args) duration(k string) (daemon.Duration, error) {
	s := a.str(k)
	if s == "" {
		return 0, nil
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%s: a duration such as 30s, 5m or 1h", k)
	}
	return daemon.Duration(v), nil
}

// asJSON is v indented, for an agent to read.
func asJSON(v any) string {
	data, _ := json.MarshalIndent(v, "", "  ")
	return string(data)
}

func (d *Daemon) call(name string, raw map[string]any) (string, bool) {
	text, err := d.do(name, args(raw))
	if err != nil {
		return err.Error(), true
	}
	return text, false
}

func (d *Daemon) do(name string, a args) (string, error) {
	api := d.API
	switch name {
	case "status":
		st, err := api.Stats()
		if err != nil {
			return "", err
		}
		m, err := api.Metrics(time.Now().Add(-5 * time.Minute))
		if err != nil {
			return "", err
		}
		recent := map[string]any{"jobs": 0, "ups": 0}
		jobs, ups := 0, 0
		var p95 float64
		for _, s := range m.Samples {
			jobs += s.Jobs
			ups += s.Ups
			if s.JobMsP95 > p95 {
				p95 = s.JobMsP95
			}
		}
		recent["jobs"], recent["ups"], recent["worst_job_ms_p95"] = jobs, ups, p95
		return asJSON(map[string]any{"now": st, "last_5_minutes": recent, "since_start": m.Totals}), nil
	case "list_templates":
		v, err := api.Templates()
		return asJSON(v), err
	case "add_template":
		idle, err := a.duration("idle")
		if err != nil {
			return "", err
		}
		v, err := api.AddTemplate(daemon.AddTemplate{Site: a.str("site"), Name: a.str("name"), Snapshot: a.str("snapshot"), Idle: idle, MaxMachines: int(a.num("max_machines")), Labels: a.labels("labels")})
		return asJSON(v), err
	case "remove_template":
		return "removed template " + a.str("name"), api.RemoveTemplate(a.str("name"))
	case "list_machines":
		v, err := api.Machines(a.labels("labels"))
		return asJSON(v), err
	case "up":
		ttl, err := a.duration("ttl")
		if err != nil {
			return "", err
		}
		v, err := api.Up(daemon.Up{Template: a.str("template"), Name: a.str("name"), Ports: a.strs("ports"), TTL: ttl, Snapshot: a.str("snapshot"), Labels: a.labels("labels")})
		return asJSON(v), err
	case "stop_machine":
		return "stopped " + a.str("name"), api.RemoveMachine(a.str("name"))
	case "run_command":
		req := control.JobRequest{Cmd: a.str("command"), Timeout: a.num("timeout_seconds"), Env: a.labels("env")}
		res, err := d.job(a, req)
		if err != nil {
			return "", err
		}
		return describeJob(res)
	case "write_file":
		p := a.str("path")
		if !strings.HasPrefix(p, "/") {
			return "", fmt.Errorf("path must be absolute")
		}
		res, err := api.Job(a.str("machine"), control.JobRequest{
			Files: map[string][]byte{"payload": []byte(a.str("content"))},
			Cmd:   fmt.Sprintf(`mkdir -p "$(dirname %s)" && cp payload %s`, quote(p), quote(p)),
		})
		if err != nil {
			return "", err
		}
		if res.Status == nil || *res.Status != 0 {
			return "", fmt.Errorf("%s", strings.TrimSpace(string(res.Output)))
		}
		return fmt.Sprintf("wrote %d bytes to %s", len(a.str("content")), p), nil
	case "read_file":
		p := a.str("path")
		res, err := api.Job(a.str("machine"), control.JobRequest{Cmd: fmt.Sprintf(`cp %s out/file`, quote(p))})
		if err != nil {
			return "", err
		}
		data, ok := res.Out["file"]
		if res.Status == nil || *res.Status != 0 || !ok {
			return "", fmt.Errorf("%s", strings.TrimSpace(string(res.Output)))
		}
		return string(data), nil
	case "snapshot_machine":
		v, err := api.SnapshotWith(a.str("machine"), a.str("name"), a.labels("labels"))
		return asJSON(v), err
	case "list_snapshots":
		v, err := api.Snapshots()
		return asJSON(v), err
	case "remove_snapshot":
		return "removed snapshot " + a.str("name"), api.RemoveSnapshot(a.str("name"))
	case "list_services":
		v, err := api.Services()
		return asJSON(v), err
	case "add_service":
		idle, err := a.duration("idle")
		if err != nil {
			return "", err
		}
		var ports []daemon.Port
		for _, p := range a.strs("ports") {
			port, err := daemon.ParsePort(p)
			if err != nil {
				return "", err
			}
			ports = append(ports, port)
		}
		v, err := api.AddService(daemon.Service{Name: a.str("name"), Template: a.str("template"), Ports: ports, Min: int(a.num("min")), Max: int(a.num("max")),
			Idle: idle, Concurrency: int(a.num("concurrency")), State: a.str("state"), Labels: a.labels("labels")})
		return asJSON(v), err
	case "remove_service":
		return "removed service " + a.str("name"), api.RemoveService(a.str("name"))
	case "build":
		b, err := api.StartBuild(daemon.BuildRequest{Name: a.str("name"), Source: a.str("source"), Dockerfile: a.str("dockerfile"), Network: a.str("network"),
			Memory: int(a.num("memory_mb")), CPUs: int(a.num("cpus")), NoTemplate: a.bool("no_template", false)})
		if err != nil {
			return "", err
		}
		if !a.bool("wait", true) {
			return asJSON(b), nil
		}
		return d.waitBuild(b.ID)
	case "build_status":
		b, err := api.Build(a.str("id"))
		if err != nil {
			return "", err
		}
		log, _ := api.BuildLog(b.ID, int64(a.num("log_offset")))
		return asJSON(b) + "\n\nlog:\n" + tail(log, 4000), nil
	case "list_builds":
		v, err := api.Builds()
		return asJSON(v), err
	case "cancel_build":
		return "cancelled or removed build " + a.str("id"), api.RemoveBuild(a.str("id"))
	case "recent_events":
		var evs []daemon.Event
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		api.Events(ctx, int64(a.num("after")), func(ev daemon.Event) bool { evs = append(evs, ev); return true })
		sort.Slice(evs, func(i, j int) bool { return evs[i].Seq < evs[j].Seq })
		if len(evs) > 50 {
			evs = evs[len(evs)-50:]
		}
		return asJSON(evs), nil
	case "fleet_diff", "fleet_apply":
		file := a.str("file")
		if !filepath.IsAbs(file) {
			return "", fmt.Errorf("file: a full path")
		}
		f, err := fleet.Load(file)
		if err != nil {
			return "", err
		}
		p, err := f.Plan(api)
		if err != nil {
			return "", err
		}
		var out strings.Builder
		if p.Empty() {
			fmt.Fprintf(&out, "fleet %s: as the file says (%d entries)\n", f.Name, p.Unchanged)
			return out.String(), nil
		}
		fmt.Fprintf(&out, "fleet %s:\n", f.Name)
		for _, s := range p.Steps {
			fmt.Fprintf(&out, "  %s\n", s)
		}
		if name == "fleet_diff" {
			return out.String(), nil
		}
		build := d.Build
		if build == nil {
			build = func(dir, out, network string) error {
				return fmt.Errorf("%s: this server can't build a fleet's sites", dir)
			}
		}
		err = p.Apply(api, build, func(format string, args ...any) { fmt.Fprintf(&out, format+"\n", args...) })
		return out.String(), err
	default:
		return "", fmt.Errorf("unknown tool: %s", name)
	}
}

// job runs a job where the arguments say: one machine, a fresh fork of a template, or a service.
func (d *Daemon) job(a args, req control.JobRequest) (*control.JobResult, error) {
	set := 0
	for _, k := range []string{"machine", "template", "service"} {
		if a.str(k) != "" {
			set++
		}
	}
	if set != 1 {
		return nil, fmt.Errorf("give exactly one of machine, template or service")
	}
	switch {
	case a.str("machine") != "":
		return d.API.Job(a.str("machine"), req)
	case a.str("template") != "":
		return d.API.TemplateJob(a.str("template"), req)
	default:
		return d.API.ServiceJob(a.str("service"), req)
	}
}

func describeJob(res *control.JobResult) (string, error) {
	out := strings.TrimRight(string(res.Output), "\n")
	if res.Status == nil {
		how := "timed out"
		if res.Cancelled {
			how = "stopped"
		}
		if res.Killed {
			how += "; everything it started was killed"
		}
		return "", fmt.Errorf("%s\n[%s]", out, how)
	}
	if *res.Status != 0 {
		return "", fmt.Errorf("%s\n[exit %d]", out, *res.Status)
	}
	return fmt.Sprintf("%s\n[exit 0]", out), nil
}

// waitBuild waits for build id to finish (up to BuildWait) and says how it went.
func (d *Daemon) waitBuild(id string) (string, error) {
	limit := d.BuildWait
	if limit <= 0 {
		limit = 20 * time.Minute
	}
	deadline := time.Now().Add(limit)
	for {
		b, err := d.API.Build(id)
		if err != nil {
			return "", err
		}
		switch b.Status {
		case "done", "failed", "cancelled", "interrupted":
			log, _ := d.API.BuildLog(id, 0)
			text := asJSON(b) + "\n\nlog (end):\n" + tail(log, 3000)
			if b.Status != "done" {
				return "", fmt.Errorf("%s", text)
			}
			return text, nil
		}
		if time.Now().After(deadline) {
			return asJSON(b) + fmt.Sprintf("\n\nstill %s after %s: build_status with id %s follows it", b.Status, limit, id), nil
		}
		time.Sleep(time.Second)
	}
}

// tail is the last n bytes of s, at a line boundary.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	return "…\n" + s
}
