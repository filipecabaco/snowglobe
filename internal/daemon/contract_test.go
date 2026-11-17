package daemon

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// What exclave relies on (docs/design/exclave-contract.md), against a daemon whose VM is the fake
// fork server: what reaches the machine, and what comes back.

// lastAsked is the last request of a mode the fake fork server of template t was sent.
func lastAsked(t *testing.T, d *daemonUnderTest, template, mode string) map[string]any {
	t.Helper()
	tpl := templateNamed(t, d, template)
	data, err := os.ReadFile(tpl.Server + "." + mode)
	if err != nil {
		t.Fatalf("no %s request: %v", mode, err)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func templateNamed(t *testing.T, d *daemonUnderTest, name string) Template {
	t.Helper()
	ts, err := d.c.Templates()
	if err != nil {
		t.Fatal(err)
	}
	for _, tpl := range ts {
		if tpl.Name == name {
			return tpl
		}
	}
	t.Fatalf("no template %s", name)
	return Template{}
}

// A job's workdir, limits and labels reach its fork as the runtime reads them; what ended it
// comes back
func TestAJobCarriesItsWorkdirLimitsAndLabelsToItsFork(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "exclave-jq"}); err != nil {
		t.Fatal(err)
	}
	req := control.JobRequest{Cmd: "oom", Workdir: "/workspace", Files: map[string][]byte{"assigns.json": []byte("{}")},
		MemoryLimitMB: 64, CPUsLimit: 0.5, PidsLimit: 16, DiskLimitMB: 32, MaxRSSMB: 256, CPUTimeS: 5, OutputLimit: 4096,
		CopyLimitMB: 8, Egress: "https", ReadOnlyIn: true, Labels: map[string]string{"exclave.team": "t1", "exclave.execution": "e1"}}
	res, err := d.c.TemplateJob("exclave-jq", req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status == nil || *res.Status != 137 || !res.OOM || string(res.Output) != "partial" {
		t.Errorf("result: %+v", res)
	}
	got := lastAsked(t, d, "exclave-jq", "job")
	want := map[string]any{"mode": "job", "cmd": "oom", "workdir": "/workspace", "memory_limit_mb": 64.0, "cpus_limit": 0.5,
		"pids_limit": 16.0, "disk_limit_mb": 32.0, "max_rss_mb": 256.0, "cpu_time_s": 5.0, "output_limit": 4096.0,
		"copy_limit_mb": 8.0, "egress": "https", "read_only_in": true}
	for k, v := range want {
		if fmt.Sprint(got[k]) != fmt.Sprint(v) {
			t.Errorf("%s: %v, want %v", k, got[k], v)
		}
	}
	if l, _ := got["labels"].(map[string]any); l["exclave.team"] != "t1" || l["exclave.execution"] != "e1" {
		t.Errorf("labels: %v", got["labels"])
	}
	// The job's end is an event, with its labels
	d.s.ev.mu.Lock()
	var ended *Event
	for i := range d.s.ev.ring {
		if d.s.ev.ring[i].Kind == "job.ended" {
			ended = &d.s.ev.ring[i]
		}
	}
	d.s.ev.mu.Unlock()
	if ended == nil || ended.Labels["exclave.team"] != "t1" || !strings.Contains(ended.Message, "status 137 (out of memory)") {
		t.Errorf("job.ended: %+v", ended)
	}
}

// A job its machine can't run (a limit it can't enforce) is the job's failure, not the API's: 200,
// with the error in the result
func TestAJobThatCantRunIsAnsweredWithItsError(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"}); err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("unix", filepath.Join(dir, "daemon.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	body := `{"cmd":"unenforceable","memory_limit_mb":64}`
	fmt.Fprintf(conn, "POST /v1/templates/t/jobs HTTP/1.1\r\nHost: d\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	var res control.JobResult
	json.NewDecoder(resp.Body).Decode(&res)
	if resp.StatusCode != 200 || !strings.Contains(res.Error, "memory_limit_mb") || res.Status != nil {
		t.Errorf("%d %+v", resp.StatusCode, res)
	}
	// The Go client still has it as its error
	if _, err := d.c.TemplateJob("t", control.JobRequest{Cmd: "unenforceable"}); err == nil || !strings.Contains(err.Error(), "memory_limit_mb") {
		t.Errorf("client: %v", err)
	}
	// An unknown template is still the API's 404
	if _, err := d.c.TemplateJob("nope", control.JobRequest{Cmd: "x"}); statusOf(err) != 404 {
		t.Errorf("unknown template: %v", err)
	}
}

// The client closing its connection cancels the job: the daemon notices, and closes its own to
// the fork, which ends it
func TestAJobEndsWhenItsClientDisconnects(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"}); err != nil {
		t.Fatal(err)
	}
	server := templateNamed(t, d, "t").Server
	conn, err := net.Dial("unix", filepath.Join(dir, "daemon.sock"))
	if err != nil {
		t.Fatal(err)
	}
	body := `{"cmd":"sleep 20s","timeout":30}`
	fmt.Fprintf(conn, "POST /v1/templates/t/jobs HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
	// Running on its fork
	waitFor(t, func() bool { _, err := os.Stat(server + ".job"); return err == nil })
	time.Sleep(200 * time.Millisecond)
	begun := time.Now()
	conn.Close()
	waitFor(t, func() bool { _, err := os.Stat(server + ".cancelled"); return err == nil })
	if waited := time.Since(begun); waited > 3*time.Second {
		t.Errorf("noticed after %s", waited)
	}
	// And what it held is let go
	waitFor(t, func() bool {
		d.s.life.mu.Lock()
		defer d.s.life.mu.Unlock()
		return d.s.life.inUse["t"] == 0
	})
}

// A machine asks for its own egress and gets a directory of its own under the jobs root, which
// is where its snapshots are written; it goes with the machine
func TestAMachineHasItsEgressAndADirectoryOfItsOwn(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "exclave-node"}); err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{"exclave.team": "t1", "exclave.build": "b1"}
	m, err := d.c.Up(Up{Template: "exclave-node", Name: "build-1", Egress: "https", Labels: labels})
	if err != nil {
		t.Fatal(err)
	}
	spawn := lastAsked(t, d, "exclave-node", "spawn")
	tpl := templateNamed(t, d, "exclave-node")
	own := filepath.Join(tpl.JobsRoot, ".machines", "build-1")
	if spawn["egress"] != "https" || spawn["dir"] != own || m.Egress != "https" || m.Dir != own {
		t.Errorf("spawn %v, machine %+v", spawn, m)
	}
	if fi, err := os.Stat(own); err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o700 {
		t.Errorf("its directory: %v %v", fi, err)
	}
	// A snapshot is written there, then kept by the daemon
	snap, err := d.c.SnapshotWith("build-1", "exclave-t1-v1", labels)
	if err != nil {
		t.Fatal(err)
	}
	if saved, _ := os.ReadFile(m.Socket + ".saved"); !strings.HasPrefix(string(saved), own+"/") {
		t.Errorf("saved outside its directory: %s", saved)
	}
	if snap.SizeBytes <= 0 {
		t.Errorf("snapshot size: %d", snap.SizeBytes)
	}
	if err := d.c.RemoveMachine("build-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Errorf("its directory outlived it: %v", err)
	}
	// Egress: one of the four
	if _, err := d.c.Up(Up{Template: "exclave-node", Egress: "sometimes"}); statusOf(err) != 400 {
		t.Errorf("a bad egress: %v", err)
	}
}

// A machine asking for egress from a template whose site has no network is refused
func TestAMachinesEgressNeedsANetwork(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	site := fakeSite(t)
	os.WriteFile(filepath.Join(site, "run.json"), []byte(`{"network":"none"}`), 0o644)
	if _, err := d.c.AddTemplate(AddTemplate{Site: site, Name: "offline"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.c.Up(Up{Template: "offline", Egress: "https"}); statusOf(err) != 400 {
		t.Errorf("egress without a network: %v", err)
	}
	if _, err := d.c.Up(Up{Template: "offline", Egress: "none"}); err != nil {
		t.Errorf("no egress needs no network: %v", err)
	}
}

// Templates and snapshots say what they hold on disk, and are listed by label
func TestTemplatesAndSnapshotsHaveSizesAndLabels(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	defer d.stop(t)
	site := fakeSite(t)
	os.WriteFile(filepath.Join(site, "system", "filesystem", "blob"), make([]byte, 10000), 0o644)
	if _, err := d.c.AddTemplate(AddTemplate{Site: site, Name: "exclave-jq", Labels: map[string]string{"exclave.toolkit": "jq"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "other"}); err != nil {
		t.Fatal(err)
	}
	if tpl := templateNamed(t, d, "exclave-jq"); tpl.SizeBytes < 10000 {
		t.Errorf("template size: %d", tpl.SizeBytes)
	}
	if _, err := d.c.Up(Up{Template: "exclave-jq", Name: "b"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.c.SnapshotWith("b", "exclave-t1-v1", map[string]string{"exclave.team": "t1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.c.SnapshotWith("b", "exclave-t2-v1", map[string]string{"exclave.team": "t2"}); err != nil {
		t.Fatal(err)
	}
	fromSnap, err := d.c.AddTemplate(AddTemplate{Snapshot: "exclave-t1-v1", Name: "exclave-t1-v1", Labels: map[string]string{"exclave.team": "t1"}})
	if err != nil {
		t.Fatal(err)
	}
	if fromSnap.SizeBytes <= 0 {
		t.Errorf("a template of a snapshot: %d", fromSnap.SizeBytes)
	}
	get := func(path string, v any) {
		t.Helper()
		conn, err := net.Dial("unix", filepath.Join(dir, "daemon.sock"))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n", path)
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	var ts []Template
	get("/v1/templates?label=exclave.toolkit=jq", &ts)
	if len(ts) != 1 || ts[0].Name != "exclave-jq" {
		t.Errorf("templates labelled exclave.toolkit=jq: %+v", ts)
	}
	get("/v1/templates?label=exclave.team=t1", &ts)
	if len(ts) != 1 || ts[0].Name != "exclave-t1-v1" || ts[0].SizeBytes <= 0 {
		t.Errorf("templates labelled exclave.team=t1: %+v", ts)
	}
	var ss []Snapshot
	get("/v1/snapshots?label=exclave.team=t2", &ss)
	if len(ss) != 1 || ss[0].Name != "exclave-t2-v1" || ss[0].SizeBytes <= 0 {
		t.Errorf("snapshots labelled exclave.team=t2: %+v", ss)
	}
	get("/v1/snapshots?label=exclave.team=t3", &ss)
	if len(ss) != 0 {
		t.Errorf("snapshots of nobody's: %+v", ss)
	}
	get("/v1/snapshots", &ss)
	if len(ss) != 2 {
		t.Errorf("every snapshot: %+v", ss)
	}
}
