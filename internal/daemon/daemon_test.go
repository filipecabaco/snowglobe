package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/filipecabaco/snowglobe/internal/lifeline"
)

// With SNOWGLOBE_FAKE_VM=serve this test binary is a fork server (`run SITE --serve SOCK ...`):
// a spawn starts a machine (this binary again, with SNOWGLOBE_FAKE_MACHINE) whose socket answers
// jobs with how many it has run (what a machine keeps from one job to the next) and connects to
// an echo server. A job sent to the server runs on a fresh machine: always the first. As
// snowglobe-vm does, the server ends when the daemon's lifeline breaks, and its machines when
// the server's does. With SNOWGLOBE_FAKE_DAEMON=DIR it is a daemon serving DIR, to be killed.
// SNOWGLOBE_FAKE_RESTORE_DELAY and SNOWGLOBE_FAKE_SPAWN_DELAY slow a server's restore and spawns;
// a job "sleep DURATION" takes that long.
func TestMain(m *testing.M) {
	switch {
	case os.Getenv("SNOWGLOBE_FAKE_DAEMON") != "":
		fakeDaemon(os.Getenv("SNOWGLOBE_FAKE_DAEMON"))
	case len(os.Args) > 1 && os.Args[1] == "build" && os.Getenv("SNOWGLOBE_FAKE_BUILD") != "":
		fakeBuild()
	case os.Getenv("SNOWGLOBE_FAKE_MACHINE") != "":
		fakeMachine(os.Getenv("SNOWGLOBE_FAKE_MACHINE"))
	case os.Getenv("SNOWGLOBE_FAKE_VM") == "serve":
		fakeServer()
	case os.Getenv("SNOWGLOBE_FAKE_VM") == "fail":
		fmt.Println("snowglobe-vm: boom: no such site")
		os.Exit(1)
	default:
		os.Exit(m.Run())
	}
}

// fakeBuild plays `snowglobe build SRC --out OUT ...`: a source with "fail" in it fails, one with
// "slow" takes a minute, anything else is a site in OUT a moment later.
func fakeBuild() {
	src, out := os.Args[2], flagOf("out")
	fmt.Println("==> building", src, "with", flagOf("builder"))
	switch {
	case strings.Contains(src, "fail"):
		fmt.Println("error: no such image")
		os.Exit(3)
	case strings.Contains(src, "slow"):
		time.Sleep(time.Minute)
	}
	os.MkdirAll(filepath.Join(out, "system", "filesystem"), 0o755)
	os.WriteFile(filepath.Join(out, "run.json"), fmt.Appendf(nil, `{"network":%q}`, flagOf("network")), 0o644)
	fmt.Println("==> done")
	os.Exit(0)
}

func flagOf(name string) string {
	for i, a := range os.Args {
		if a == "--"+name && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

func readLine(c net.Conn) map[string]any {
	line, _ := bufio.NewReader(c).ReadBytes('\n')
	var v map[string]any
	json.Unmarshal(line, &v)
	return v
}

func send(c net.Conn, v any) {
	data, _ := json.Marshal(v)
	c.Write(append(data, '\n'))
}

// fakeDaemon serves dir until it is killed.
func fakeDaemon(dir string) {
	// Not for the servers it starts
	os.Unsetenv("SNOWGLOBE_FAKE_DAEMON")
	self, _ := os.Executable()
	s, err := New(Options{Dir: dir, VM: self})
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	s.Serve(context.Background())
}

func fakeServer() {
	sock := flagOf("serve")
	lifeline.Watch(func() { os.Remove(sock); os.Exit(143) })
	l, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	delay("SNOWGLOBE_FAKE_RESTORE_DELAY")
	fmt.Printf("restored fake in 0.1s, serving jobs on %s\n", sock)
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		req := readLine(c)
		switch req["mode"] {
		case "spawn":
			delay("SNOWGLOBE_FAKE_SPAWN_DELAY")
			name, _ := req["name"].(string)
			msock := filepath.Join(filepath.Dir(sock), name+".sock")
			if _, err := net.Dial("unix", msock); err == nil {
				send(c, map[string]any{"error": "a machine is running on " + msock + " already"})
				break
			}
			self, _ := os.Executable()
			cmd := exec.Command(self)
			cmd.Env = append(os.Environ(), "SNOWGLOBE_FAKE_MACHINE="+msock)
			if st, _ := req["state"].(string); st != "" {
				cmd.Env = append(cmd.Env, "SNOWGLOBE_FAKE_STATE="+st)
			} else if st := flagOf("state"); st != "" {
				cmd.Env = append(cmd.Env, "SNOWGLOBE_FAKE_STATE="+st)
			}
			lifeline.Pass(cmd)
			cmd.Start()
			go cmd.Wait()
			for i := 0; i < 200 && !control.Alive(msock); i++ {
				time.Sleep(10 * time.Millisecond)
			}
			send(c, map[string]any{"pid": cmd.Process.Pid, "socket": msock})
		case "job":
			// On a fork of its own: others go on meanwhile
			go func() {
				sleepFor(req)
				send(c, control.JobResult{Status: new(int), Output: []byte("fresh: 1\n")})
				c.Close()
			}()
			continue
		}
		c.Close()
	}
}

func fakeMachine(sock string) {
	lifeline.Watch(func() { os.Remove(sock); os.Exit(143) })
	os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		os.Exit(1)
	}
	jobs := 0
	// Started from a saved machine: its count
	if st := os.Getenv("SNOWGLOBE_FAKE_STATE"); st != "" {
		data, _ := os.ReadFile(st)
		fmt.Sscan(string(data), &jobs)
	}
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		r := bufio.NewReader(c)
		line, _ := r.ReadBytes('\n')
		var req map[string]any
		json.Unmarshal(line, &req)
		switch req["mode"] {
		case "job":
			sleepFor(req)
			jobs++
			send(c, control.JobResult{Status: new(int), Output: fmt.Appendf(nil, "%s: %d\n", req["cmd"], jobs)})
			c.Close()
		case "save":
			path, _ := req["path"].(string)
			if err := os.WriteFile(path, fmt.Append(nil, jobs), 0o600); err != nil {
				send(c, map[string]any{"error": err.Error()})
			} else {
				send(c, map[string]any{"bytes": 1, "ms": 1})
			}
			c.Close()
		case "links":
			// Kept beside the socket, for the test to read
			data, _ := json.Marshal(req["links"])
			os.WriteFile(sock+".links", data, 0o600)
			n := 0
			if l, ok := req["links"].([]any); ok {
				n = len(l)
			}
			send(c, map[string]any{"links": n})
			c.Close()
		case "connect":
			send(c, map[string]any{"connected": req["port"]})
			go func() { io.Copy(c, r); c.Close() }()
		case "attach":
			// The screen, then what is typed in, echoed
			fmt.Fprintf(c, "screen %vx%v\r\n", req["rows"], req["cols"])
			go func() { io.Copy(c, r); c.Close() }()
		default:
			c.Close()
		}
	}
}

// delay sleeps for the duration in environment variable v, if any.
func delay(v string) {
	if d, err := time.ParseDuration(os.Getenv(v)); err == nil {
		time.Sleep(d)
	}
}

// sleepFor sleeps for a job "sleep DURATION".
func sleepFor(req map[string]any) {
	cmd, _ := req["cmd"].(string)
	if rest, ok := strings.CutPrefix(cmd, "sleep "); ok {
		if d, err := time.ParseDuration(rest); err == nil {
			time.Sleep(d)
		}
	}
}

// daemonUnderTest is a daemon serving in the background, its VM this binary playing a fork server.
type daemonUnderTest struct {
	s      *Server
	c      *Client
	dir    string
	cancel context.CancelFunc
	done   chan error
}

func startDaemon(t *testing.T, dir string, o Options) *daemonUnderTest {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	o.Dir, o.VM, o.Logf = dir, self, t.Logf
	s, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &daemonUnderTest{s: s, dir: dir, cancel: cancel, done: make(chan error, 1)}
	go func() { d.done <- s.Serve(ctx) }()
	sock := filepath.Join(dir, "daemon.sock")
	for i := 0; i < 200 && !control.Alive(sock); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if d.c, err = NewClient("unix://"+sock, ""); err != nil {
		t.Fatal(err)
	}
	return d
}

func (d *daemonUnderTest) stop(t *testing.T) {
	d.cancel()
	if err := <-d.done; err != nil {
		t.Error(err)
	}
}

// A short directory: sockets go in it
func shortTemp(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "sgd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// A site with what AddTemplate checks for: run.json and system/filesystem
func fakeSite(t *testing.T) string {
	t.Helper()
	site := filepath.Join(t.TempDir(), "py")
	os.MkdirAll(filepath.Join(site, "system", "filesystem"), 0o755)
	os.WriteFile(filepath.Join(site, "run.json"), []byte(`{"network":"fetch"}`), 0o644)
	return site
}

func output(t *testing.T) func(*control.JobResult, error) string {
	return func(res *control.JobResult, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return string(res.Output)
	}
}

func TestTemplatesAndMachinesLiveAndDie(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	c := d.c

	tpl, err := c.AddTemplate(AddTemplate{Site: fakeSite(t)})
	if err != nil {
		t.Fatal(err)
	}
	if tpl.Name != "py" || !strings.Contains(tpl.Ready, "serving jobs") || !alive(tpl.Pid) {
		t.Fatalf("template: %+v", tpl)
	}
	if _, err := c.AddTemplate(AddTemplate{Site: tpl.Site}); statusOf(err) != 409 {
		t.Errorf("the same name twice: %v", err)
	}

	a, err := c.Up(Up{Template: "py", Name: "a", Ports: []string{"0:80"}, Labels: map[string]string{"app": "web"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Up(Up{Template: "py"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(b.Name, "py-") || a.Pid == b.Pid || a.Ports[0].Host == 0 {
		t.Fatalf("machines: %+v %+v", a, b)
	}

	// Each keeps its own state from one job to the next; a template job is a fresh machine's
	if out := output(t)(c.Job("a", control.JobRequest{Cmd: "x"})); out != "x: 1\n" {
		t.Errorf("a: %q", out)
	}
	if out := output(t)(c.Job("a", control.JobRequest{Cmd: "x"})); out != "x: 2\n" {
		t.Errorf("a again: %q", out)
	}
	if out := output(t)(c.Job(b.Name, control.JobRequest{Cmd: "y"})); out != "y: 1\n" {
		t.Errorf("b: %q", out)
	}
	if out := output(t)(c.TemplateJob("py", control.JobRequest{Cmd: "z"})); out != "fresh: 1\n" {
		t.Errorf("template job: %q", out)
	}

	// A host port forwarded through the control socket, both ways
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", a.Ports[0].Host))
	if err != nil {
		t.Fatal(err)
	}
	conn.Write([]byte("ping"))
	conn.(*net.TCPConn).CloseWrite()
	got, _ := io.ReadAll(conn)
	conn.Close()
	if string(got) != "ping" {
		t.Errorf("forwarded: %q", got)
	}

	// Listed, by label too
	if ms, _ := c.Machines(nil); len(ms) != 2 {
		t.Errorf("machines: %+v", ms)
	}
	if ms, _ := c.Machines(map[string]string{"app": "web"}); len(ms) != 1 || ms[0].Name != "a" {
		t.Errorf("by label: %+v", ms)
	}

	// Refused: a name in use, a template that isn't, a name that is a path, a bad port
	for what, req := range map[string]Up{
		"in use":      {Template: "py", Name: "a"},
		"no template": {Template: "nope"},
		"a path":      {Template: "py", Name: "../x"},
		"a bad port":  {Template: "py", Ports: []string{"http"}},
		"a used port": {Template: "py", Ports: []string{fmt.Sprintf("%d:80", a.Ports[0].Host)}},
	} {
		if _, err := c.Up(req); err == nil {
			t.Errorf("%s: no error", what)
		}
	}
	if _, err := c.Job("nope", control.JobRequest{Cmd: "x"}); !NotFound(err) {
		t.Errorf("a job on no machine: %v", err)
	}

	// Removed: its process and socket go, its port closes
	if err := c.RemoveMachine("a"); err != nil {
		t.Fatal(err)
	}
	if control.Alive(a.Socket) {
		t.Error("a still answers")
	}
	if _, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", a.Ports[0].Host)); err == nil {
		t.Error("a's port still forwards")
	}
	if err := c.RemoveMachine("a"); !NotFound(err) {
		t.Errorf("removed twice: %v", err)
	}

	// A template removed takes its machines with it
	if err := c.RemoveTemplate("py"); err != nil {
		t.Fatal(err)
	}
	if ms, _ := c.Machines(nil); len(ms) != 0 || control.Alive(b.Socket) || !gone(tpl.Pid, time.Second) {
		t.Errorf("after rm: %+v", ms)
	}
}

// started is what a daemon has running: its servers' and machines' pids.
func started(t *testing.T, c *Client) []int {
	t.Helper()
	var pids []int
	ts, err := c.Templates()
	if err != nil {
		t.Fatal(err)
	}
	for _, tpl := range ts {
		if tpl.Pid > 0 {
			pids = append(pids, tpl.Pid)
		}
	}
	ms, _ := c.Machines(nil)
	for _, m := range ms {
		pids = append(pids, m.Pid)
	}
	return pids
}

// withEverything gives a daemon a template, a machine on it with a port, and a service with a
// replica always running: what it starts; their pids.
func withEverything(t *testing.T, c *Client, site string) []int {
	t.Helper()
	if _, err := c.AddTemplate(AddTemplate{Site: site, Name: "t1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Up(Up{Template: "t1", Name: "m", Ports: []string{"0:80"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddService(Service{Name: "web", Template: "t1", Min: 1, Ports: []Port{{IP: "127.0.0.1", Guest: 80}}}); err != nil {
		t.Fatal(err)
	}
	pids := started(t, c)
	if len(pids) != 3 {
		t.Fatalf("a server, a machine and a replica: %v", pids)
	}
	for _, p := range pids {
		if !alive(p) {
			t.Fatalf("pid %d isn't running", p)
		}
	}
	return pids
}

func TestADaemonThatStopsStopsWhatItStarted(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	pids := withEverything(t, d.c, fakeSite(t))
	ts, _ := d.c.Templates()
	sockDir := ts[0].SocketDir
	d.stop(t)
	for _, p := range pids {
		if !gone(p, 2*time.Second) {
			t.Errorf("pid %d outlived its daemon", p)
			syscall.Kill(p, syscall.SIGKILL)
		}
	}
	if _, err := os.Stat(sockDir); !os.IsNotExist(err) {
		t.Errorf("its sockets are left: %v", err)
	}
	// What it keeps says that nothing runs, and keeps the rest
	st := loadState(filepath.Join(dir, "state.json"))
	if len(st.Machines) != 0 || len(st.Templates) != 1 || st.Templates["t1"].Pid != 0 || len(st.Services) != 1 {
		t.Errorf("its state: %+v %+v", st.Machines, st.Templates)
	}
}

func TestADaemonStartedAgainStartsItsTemplatesAndServicesAgain(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	fastScaling(t)
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	old := withEverything(t, d.c, fakeSite(t))
	d.stop(t)

	d = startDaemon(t, dir, Options{})
	defer d.stop(t)
	// The template from its site, the service's replica at its min; the machine is not back
	waitFor(t, func() bool { ts, _ := d.c.Templates(); return len(ts) == 1 && !ts[0].Asleep && alive(ts[0].Pid) })
	waitFor(t, func() bool { return len(running(t, d.c, "web")) == 1 })
	if _, err := d.c.Machine("m"); !NotFound(err) {
		t.Errorf("a machine back from a stopped daemon: %v", err)
	}
	for _, p := range started(t, d.c) {
		for _, o := range old {
			if p == o {
				t.Errorf("pid %d taken back", p)
			}
		}
	}
	svc, _ := d.c.Service("web")
	if got := echo(t, svc.Ports[0].Host, "again"); got != "again" {
		t.Errorf("the service after a restart: %q", got)
	}
}

// A daemon killed outright (kill -9, the OOM killer, a crash) can't stop anything: what it
// started stops itself, as its lifeline breaks.
func TestWhatADaemonStartedEndsWhenItIsKilled(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	dir := shortTemp(t)
	self, _ := os.Executable()
	cmd := exec.Command(self)
	cmd.Env = append(os.Environ(), "SNOWGLOBE_FAKE_DAEMON="+dir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	sock := filepath.Join(dir, "daemon.sock")
	waitFor(t, func() bool { return control.Alive(sock) })
	c, _ := NewClient("unix://"+sock, "")
	pids := withEverything(t, c, fakeSite(t))

	cmd.Process.Signal(syscall.SIGKILL)
	cmd.Wait()
	for _, p := range pids {
		if !gone(p, 3*time.Second) {
			t.Errorf("pid %d outlived its daemon", p)
			syscall.Kill(p, syscall.SIGKILL)
		}
	}
	// Started again, it doesn't take back what is gone, and starts the template again
	d := startDaemon(t, dir, Options{})
	defer d.stop(t)
	waitFor(t, func() bool { ts, _ := d.c.Templates(); return len(ts) == 1 && !ts[0].Asleep && alive(ts[0].Pid) })
	if _, err := d.c.Machine("m"); !NotFound(err) {
		t.Errorf("a machine of a killed daemon: %v", err)
	}
}

func TestTheAPIStopsTheDaemon(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	tpl, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	if err != nil {
		t.Fatal(err)
	}
	// Answered once it has stopped
	if err := d.c.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if alive(tpl.Pid) {
		t.Error("its server outlived it")
	}
	select {
	case err := <-d.done:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve didn't return")
	}
}

func TestStoppedMachinesAndServersAreReaped(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	old := reapEvery
	reapEvery = 50 * time.Millisecond
	defer func() { reapEvery = old }()
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	tpl, _ := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	a, _ := d.c.Up(Up{Template: "t", Name: "a"})
	b, _ := d.c.Up(Up{Template: "t", Name: "b"})

	syscall.Kill(a.Pid, syscall.SIGKILL)
	waitFor(t, func() bool { ms, _ := d.c.Machines(nil); return len(ms) == 1 && ms[0].Name == "b" })
	// Its server gone: the template and its machines with it
	syscall.Kill(tpl.Pid, syscall.SIGKILL)
	waitFor(t, func() bool { ts, _ := d.c.Templates(); return len(ts) == 0 })
	if ms, _ := d.c.Machines(nil); len(ms) != 0 {
		t.Errorf("machines of a dead template: %+v", ms)
	}
	waitFor(t, func() bool { return !control.Alive(b.Socket) })
}

func TestSnapshotsCarryAMachineOnward(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	c := d.c
	site := fakeSite(t)
	tpl, err := c.AddTemplate(AddTemplate{Site: site, Name: "t"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.RemoveTemplate("t")
	c.Up(Up{Template: "t", Name: "a"})
	c.Job("a", control.JobRequest{Cmd: "x"})
	c.Job("a", control.JobRequest{Cmd: "x"})

	s1, err := c.Snapshot("a", "s1")
	if err != nil {
		t.Fatal(err)
	}
	if s1.Site != site || s1.Machine != "a" || s1.Template != "t" || !strings.HasPrefix(s1.Path, filepath.Join(d.dir, "snapshots")) {
		t.Errorf("snapshot: %+v", s1)
	}
	if _, err := c.Snapshot("a", "s1"); statusOf(err) != 409 {
		t.Errorf("the same name twice: %v", err)
	}
	if _, err := c.Snapshot("nope", ""); !NotFound(err) {
		t.Errorf("a snapshot of no machine: %v", err)
	}

	// The machine goes; one started from its snapshot carries on where it was
	c.RemoveMachine("a")
	if _, err := c.Up(Up{Template: "t", Name: "b", Snapshot: "s1"}); err != nil {
		t.Fatal(err)
	}
	if out := output(t)(c.Job("b", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Errorf("from the snapshot: %q", out)
	}
	if m, _ := c.Machine("b"); m.Snapshot != "s1" {
		t.Errorf("b's snapshot: %+v", m)
	}
	// Not from it: the template's state
	c.Up(Up{Template: "t", Name: "fresh"})
	if out := output(t)(c.Job("fresh", control.JobRequest{Cmd: "x"})); out != "x: 1\n" {
		t.Errorf("not from it: %q", out)
	}
	// The link the machine read it through is gone; the snapshot stays
	if left, _ := os.ReadDir(filepath.Join(tpl.JobsRoot, ".restore")); len(left) != 0 {
		t.Errorf("left in .restore: %v", left)
	}

	// A template made of the snapshot: every machine of it starts there
	t2, err := c.AddTemplate(AddTemplate{Snapshot: "s1", Name: "t2"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.RemoveTemplate("t2")
	if t2.Snapshot != "s1" || t2.Site != site {
		t.Errorf("template of a snapshot: %+v", t2)
	}
	c.Up(Up{Template: "t2", Name: "d"})
	if out := output(t)(c.Job("d", control.JobRequest{Cmd: "x"})); out != "x: 3\n" {
		t.Errorf("a machine of t2: %q", out)
	}

	// A snapshot only goes onto a template of its site
	other, _ := c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "other"})
	defer c.RemoveTemplate("other")
	if _, err := c.Up(Up{Template: other.Name, Snapshot: "s1"}); statusOf(err) != 400 {
		t.Errorf("onto another site's template: %v", err)
	}
	if ss, _ := c.Snapshots(); len(ss) != 1 || ss[0].Name != "s1" {
		t.Errorf("snapshots: %+v", ss)
	}
	// Not while a template is made of it: it starts from it again after sleeping
	if err := c.RemoveSnapshot("s1"); statusOf(err) != 409 || !strings.Contains(err.Error(), "t2") {
		t.Errorf("removed under its template: %v", err)
	}
	if err := c.RemoveTemplate("t2"); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveSnapshot("s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s1.Path); err == nil {
		t.Error("its file stays")
	}
	if _, err := c.Up(Up{Template: "t", Snapshot: "s1"}); !NotFound(err) {
		t.Errorf("up from a removed snapshot: %v", err)
	}
	if err := c.RemoveSnapshot("s1"); !NotFound(err) {
		t.Errorf("removed twice: %v", err)
	}
}

func waitFor(t *testing.T, f func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if f() {
			return
		}
	}
	t.Fatal("timed out")
}

func TestATemplateThatFailsToRestoreSaysWhy(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "fail")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	_, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t)})
	if err == nil || !strings.Contains(err.Error(), "boom: no such site") {
		t.Errorf("got %v", err)
	}
	for _, site := range []string{"", t.TempDir()} {
		if _, err := d.c.AddTemplate(AddTemplate{Site: site}); statusOf(err) != 400 {
			t.Errorf("site %q: %v", site, err)
		}
	}
	if ts, _ := d.c.Templates(); len(ts) != 0 {
		t.Errorf("templates: %+v", ts)
	}
}

func TestTheTCPAPINeedsTheToken(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	d := startDaemon(t, shortTemp(t), Options{Listen: addr, Token: "0123456789abcdef"})
	defer d.stop(t)
	waitFor(t, func() bool {
		c, err := net.Dial("tcp", addr)
		if err == nil {
			c.Close()
		}
		return err == nil
	})
	without, _ := NewClient("http://"+addr, "")
	if _, err := without.Templates(); statusOf(err) != 401 {
		t.Errorf("without a token: %v", err)
	}
	wrong, _ := NewClient("http://"+addr, "nope")
	if _, err := wrong.Templates(); statusOf(err) != 401 {
		t.Errorf("a wrong token: %v", err)
	}
	with, _ := NewClient("http://"+addr, "0123456789abcdef")
	if _, err := with.Templates(); err != nil {
		t.Errorf("with the token: %v", err)
	}
	// Refused outright without one
	s, _ := New(Options{Dir: shortTemp(t), Listen: "127.0.0.1:0"})
	if err := s.Serve(context.Background()); err == nil || !strings.Contains(err.Error(), "token") {
		t.Errorf("--listen without a token: %v", err)
	}
}

func TestOneDaemonPerDirectory(t *testing.T) {
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	defer d.stop(t)
	s, _ := New(Options{Dir: dir})
	if err := s.Serve(context.Background()); err == nil || !strings.Contains(err.Error(), "running already") {
		t.Errorf("a second daemon: %v", err)
	}
}

func TestParsePort(t *testing.T) {
	for spec, want := range map[string]Port{
		"8000":              {IP: "127.0.0.1", Guest: 8000},
		"8080:8000":         {IP: "127.0.0.1", Host: 8080, Guest: 8000},
		"0:8000":            {IP: "127.0.0.1", Guest: 8000},
		"0.0.0.0:8080:8000": {IP: "0.0.0.0", Host: 8080, Guest: 8000},
	} {
		if got, err := ParsePort(spec); err != nil || got != want {
			t.Errorf("%s: %+v %v", spec, got, err)
		}
	}
	for _, bad := range []string{"", "0", "http", "1:2:3:4", "host:80:80", "80:70000", "-1:80"} {
		if _, err := ParsePort(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

func TestNames(t *testing.T) {
	for _, ok := range []string{"a", "web-1", "A_b", strings.Repeat("x", 63)} {
		if validName(ok) != nil {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "-a", "_a", "a/b", "..", "a.b", "a b", strings.Repeat("x", 64)} {
		if validName(bad) == nil {
			t.Errorf("%q taken", bad)
		}
	}
}

func TestFindUsesSNOWGLOBE_DAEMON(t *testing.T) {
	t.Setenv("SNOWGLOBE_DAEMON", "ftp://nope")
	if _, ok := Find(); ok {
		t.Error("a bad address found")
	}
	t.Setenv("SNOWGLOBE_DAEMON", "")
	t.Setenv("SNOWGLOBE_DAEMON_DIR", shortTemp(t))
	if _, ok := Find(); ok {
		t.Error("found a daemon where none runs")
	}
	// And the health check over HTTP
	srv := &http.Server{Handler: (&Server{o: Options{Logf: t.Logf}, forwards: map[string][]net.Listener{}, svc: newServices(), st: emptyState()}).Handler()}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(l)
	defer srv.Close()
	t.Setenv("SNOWGLOBE_DAEMON", "http://"+l.Addr().String())
	c, ok := Find()
	if !ok {
		t.Fatal("not found")
	}
	if ts, err := c.Templates(); err != nil || len(ts) != 0 {
		t.Errorf("templates: %v %v", ts, err)
	}
}

func TestPortsNeedASiteWithANetwork(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	offline := fakeSite(t)
	os.WriteFile(filepath.Join(offline, "run.json"), []byte(`{"network":"none"}`), 0o644)
	if _, err := d.c.AddTemplate(AddTemplate{Site: offline, Name: "off"}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("off")
	for what, err := range map[string]error{
		"up": func() error { _, err := d.c.Up(Up{Template: "off", Ports: []string{"8000"}}); return err }(),
		"service add": func() error {
			_, err := d.c.AddService(Service{Name: "web", Template: "off", Ports: []Port{{IP: "127.0.0.1", Guest: 80}}})
			return err
		}(),
	} {
		if statusOf(err) != 400 || !strings.Contains(err.Error(), "--network fetch") {
			t.Errorf("%s with a port: %v", what, err)
		}
	}
	// Without ports, the same template serves
	if _, err := d.c.Up(Up{Template: "off", Name: "m"}); err != nil {
		t.Errorf("up without ports: %v", err)
	}
	if _, err := d.c.AddService(Service{Name: "jobs", Template: "off"}); err != nil {
		t.Errorf("a service without ports: %v", err)
	}
	d.c.RemoveService("jobs")
}

// Two ups of one name at once: one machine, the other refused
func TestTwoUpsOfOneNameMakeOneMachine(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	t.Setenv("SNOWGLOBE_FAKE_SPAWN_DELAY", "300ms")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"}); err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, 2)
	for range 2 {
		go func() { _, err := d.c.Up(Up{Template: "t", Name: "same"}); errs <- err }()
	}
	a, b := <-errs, <-errs
	if a != nil {
		a, b = b, a
	}
	// (Refused by the daemon, not left to the fork server to notice)
	if a != nil || statusOf(b) != 409 || !strings.Contains(b.Error(), "a machine called same exists") {
		t.Errorf("both: %v, %v", a, b)
	}
	if ms, _ := d.c.Machines(nil); len(ms) != 1 {
		t.Errorf("machines: %+v", ms)
	}
}

// A job's output past what the daemon keeps is cut, and it says how much
func TestAJobsOutputIsCut(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	old := maxJobOutput
	maxJobOutput = 3 << 10
	t.Cleanup(func() { maxJobOutput = old })
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	if _, err := d.c.Up(Up{Template: "t", Name: "m"}); err != nil {
		t.Fatal(err)
	}
	// The fake machine prints its command back
	res, err := d.c.Job("m", control.JobRequest{Cmd: strings.Repeat("x", 10<<10)})
	if err != nil {
		t.Fatal(err)
	}
	if res.OutputCut < 7<<10 || !strings.HasPrefix(string(res.Output), strings.Repeat("x", 3000)) ||
		!strings.Contains(string(res.Output), "more bytes of output were cut") || len(res.Output) > 4<<10 {
		t.Errorf("cut %d, kept %d: %q", res.OutputCut, len(res.Output), res.Output[len(res.Output)-100:])
	}
}
