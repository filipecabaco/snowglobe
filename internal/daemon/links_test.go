package daemon

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// The links a fake machine was given last
func linksOf(t *testing.T, d *daemonUnderTest, machine string) []control.Link {
	t.Helper()
	m, err := d.c.Machine(machine)
	if err != nil {
		t.Fatal(err)
	}
	var ls []control.Link
	data, err := os.ReadFile(m.Socket + ".links")
	if err != nil {
		return nil
	}
	json.Unmarshal(data, &ls)
	return ls
}

func TestLinksLetMachinesReachEachOtherByNameOverSocketsOfTheirOwn(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "py"}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("py")
	for _, n := range []string{"app", "db"} {
		if _, err := d.c.Up(Up{Template: "py", Name: n}); err != nil {
			t.Fatal(err)
		}
	}

	// app reaches db's 5432 as db.internal, over a Unix socket of app's own
	l, err := d.c.AddLink(Link{From: "app", To: "db", Port: 5432, As: "db.internal"})
	if err != nil {
		t.Fatal(err)
	}
	if l.FromKind != KindMachine || l.ToKind != KindMachine || l.AsPort != 5432 || l.Name != "app-db-5432" {
		t.Errorf("link: %+v", l)
	}
	got := linksOf(t, d, "app")
	if len(got) != 1 || got[0].Host != "db.internal" || got[0].Port != 5432 || !strings.HasPrefix(got[0].URL, "unix:///") {
		t.Fatalf("app's links: %+v", got)
	}
	sock := strings.TrimPrefix(got[0].URL, "unix://")
	tpl, _ := d.c.Templates()
	if !strings.HasPrefix(sock, tpl[0].SocketDir+"/") {
		t.Errorf("app's socket %s is outside its template's socket directory %s", sock, tpl[0].SocketDir)
	}
	// It leads to db's guest port (the fake machine echoes)
	c, err := net.DialTimeout("unix", sock, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Errorf("through the link: %q %v", buf, err)
	}
	c.Close()

	// The same name and port twice from the same side is refused
	if _, err := d.c.AddLink(Link{From: "app", To: "db", Port: 6000, As: "db.internal", AsPort: 5432}); statusOf(err) != 409 {
		t.Errorf("a second link to db.internal:5432: %v", err)
	}
	// A template's link goes to its machines, the ones up later too
	if _, err := d.c.AddLink(Link{From: "py", FromKind: KindTemplate, To: "db", Port: 6379, As: "cache"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.c.Up(Up{Template: "py", Name: "late"}); err != nil {
		t.Fatal(err)
	}
	if got := linksOf(t, d, "late"); len(got) != 1 || got[0].Host != "cache" {
		t.Errorf("a later machine's links: %+v", got)
	}
	appLinks, lateLinks := linksOf(t, d, "app"), linksOf(t, d, "late")
	if len(appLinks) != 2 {
		t.Errorf("app's links with its template's: %+v", appLinks)
	}
	// Each machine has a socket of its own for the template's link
	for _, a := range appLinks {
		if len(lateLinks) == 1 && a.URL == lateLinks[0].URL {
			t.Errorf("app and late share a socket: %s", a.URL)
		}
	}

	// The graph shows them
	g, err := d.c.Graph()
	if err != nil {
		t.Fatal(err)
	}
	links := 0
	for _, e := range g.Edges {
		if e.Kind == "link" {
			links++
			if e.To != "machine:db" {
				t.Errorf("link edge: %+v", e)
			}
		}
	}
	if links != 2 {
		t.Errorf("link edges: %d in %+v", links, g.Edges)
	}

	// Removing it takes it from app, and its socket with it; db going takes every link to it
	if err := d.c.RemoveLink("app-db-5432"); err != nil {
		t.Fatal(err)
	}
	if got := linksOf(t, d, "app"); len(got) != 1 || got[0].Host != "cache" {
		t.Errorf("app's links after removing one: %+v", got)
	}
	if c, err := net.DialTimeout("unix", sock, time.Second); err == nil {
		c.Close()
		t.Error("the removed link's socket still answers")
	}
	if err := d.c.RemoveMachine("db"); err != nil {
		t.Fatal(err)
	}
	if ls, _ := d.c.Links(); len(ls) != 0 {
		t.Errorf("links after db went: %+v", ls)
	}
	if got := linksOf(t, d, "late"); len(got) != 0 {
		t.Errorf("late's links after db went: %+v", got)
	}

	for what, req := range map[string]Link{
		"no such target": {From: "app", To: "nope", Port: 1},
		"no port":        {From: "app", To: "late"},
		"a bad name":     {From: "app", To: "late", Port: 1, As: "no spaces"},
		"itself":         {From: "app", To: "app", Port: 1},
		"a bad instance": {From: "app", To: "late", Port: 1, Instance: "a b"},
	} {
		if _, err := d.c.AddLink(req); err == nil || statusOf(err) >= 500 {
			t.Errorf("%s: %v", what, err)
		} else if what == "no such target" && !strings.Contains(err.Error(), "nope") {
			t.Errorf("%s: %v", what, err)
		}
	}
}

func TestAnInstancesLinksStayInIt(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	for _, n := range []string{"app", "db"} {
		if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: n}); err != nil {
			t.Fatal(err)
		}
		defer d.c.RemoveTemplate(n)
	}
	for _, i := range []string{"i1", "i2"} {
		for _, tpl := range []string{"app", "db"} {
			if _, err := d.c.Up(Up{Template: tpl, Name: tpl + "-" + i, Labels: map[string]string{InstanceLabel: i}}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := d.c.AddLink(Link{From: "app", FromKind: KindTemplate, To: "db", ToKind: KindTemplate, Port: 5432, As: "db", Instance: i}); err != nil {
			t.Fatal(err)
		}
	}
	// Each app machine takes only its own instance's link, on a socket of its own
	a, b := linksOf(t, d, "app-i1"), linksOf(t, d, "app-i2")
	if len(a) != 1 || len(b) != 1 || a[0].Host != "db" || a[0].URL == b[0].URL {
		t.Fatalf("instances' links: %+v %+v", a, b)
	}
	// And it leads to its own instance's db
	for _, i := range []string{"i1", "i2"} {
		d.s.mu.Lock()
		l := *d.s.st.Links["app-db-5432-"+i]
		d.s.mu.Unlock()
		m, done, err := d.s.target(&l)
		if err != nil {
			t.Fatal(err)
		}
		done()
		if m.Name != "db-"+i {
			t.Errorf("instance %s's link leads to %s", i, m.Name)
		}
	}
	// With its db gone, an instance's link leads nowhere (not to the other's)
	if err := d.c.RemoveMachine("db-i1"); err != nil {
		t.Fatal(err)
	}
	d.s.mu.Lock()
	l := *d.s.st.Links["app-db-5432-i1"]
	d.s.mu.Unlock()
	if m, _, err := d.s.target(&l); err == nil {
		t.Errorf("instance i1 without its db reached %s", m.Name)
	}
}

func TestEgressIsNoneInternetOrPrivate(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "py", Egress: "sometimes"}); statusOf(err) != 400 {
		t.Errorf("egress sometimes: %v", err)
	}
	t1, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "py", Egress: "none"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("py")
	if t1.Egress != "none" {
		t.Errorf("egress: %q", t1.Egress)
	}
}
