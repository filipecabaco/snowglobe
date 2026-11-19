package daemon

import (
	"io"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// unixPair is a connected pair of Unix sockets.
func unixPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	conn := func(fd int) *net.UnixConn {
		f := os.NewFile(uintptr(fd), "pair")
		defer f.Close()
		c, err := net.FileConn(f)
		if err != nil {
			t.Fatal(err)
		}
		return c.(*net.UnixConn)
	}
	return conn(fds[0]), conn(fds[1])
}

// closedWithin says whether c's peer closed (c reads EOF) within d.
func closedWithin(c net.Conn, d time.Duration) bool {
	c.SetReadDeadline(time.Now().Add(d))
	_, err := c.Read(make([]byte, 1))
	return err == io.EOF
}

func TestTheDaemonKeepsItsCopyOfAConnectionUntilTheMachineGotIt(t *testing.T) {
	var held heldConns
	// Kept: the other end doesn't see it close
	ours, theirs := unixPair(t)
	held.hold(1, ours, time.Hour)
	if closedWithin(theirs, 100*time.Millisecond) {
		t.Fatal("closed before the machine said it got it")
	}
	// {"got":1}: let go
	held.release(1)
	if !closedWithin(theirs, time.Second) {
		t.Error("still kept after the machine got it")
	}
	// A machine that never says: let go at the most after the limit
	ours, theirs = unixPair(t)
	held.hold(2, ours, 50*time.Millisecond)
	if !closedWithin(theirs, 2*time.Second) {
		t.Error("kept past the limit")
	}
	// The channel gone: every copy goes with it
	a, ta := unixPair(t)
	b, tb := unixPair(t)
	held.hold(3, a, time.Hour)
	held.hold(4, b, time.Hour)
	if held.len() != 2 {
		t.Errorf("held: %d", held.len())
	}
	held.closeAll()
	if !closedWithin(ta, time.Second) || !closedWithin(tb, time.Second) {
		t.Error("copies kept after the channel went")
	}
	// What isn't kept (said twice, or never handed over) is nothing to let go
	held.release(3)
	held.release(99)
	if held.len() != 0 {
		t.Errorf("held after all: %d", held.len())
	}
}

func TestALinkChannelIsForAMachineWithLinksOnlyAndGoesWithIt(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	d := startDaemon(t, shortTemp(t), Options{})
	defer d.stop(t)
	if _, err := d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "py"}); err != nil {
		t.Fatal(err)
	}
	defer d.c.RemoveTemplate("py")
	for _, n := range []string{"app", "db", "lone"} {
		if _, err := d.c.Up(Up{Template: "py", Name: n}); err != nil {
			t.Fatal(err)
		}
	}
	channels := func() map[string]bool {
		d.s.mu.Lock()
		defer d.s.mu.Unlock()
		out := map[string]bool{}
		for n := range d.s.linkers {
			out[n] = true
		}
		return out
	}
	if got := channels(); len(got) != 0 {
		t.Errorf("channels before any link: %v", got)
	}
	if _, err := d.c.AddLink(Link{From: "app", To: "db", Port: 5432, As: "db.internal"}); err != nil {
		t.Fatal(err)
	}
	// The From side only: a target or a machine with no link has nothing to ask for
	if got := channels(); !got["app"] || got["db"] || got["lone"] {
		t.Errorf("channels with app's link: %v", got)
	}
	url := linksOf(t, d, "app")[0].URL
	if echo, err := dialAs(t, d, "app", url); err != nil || echo != "ping" {
		t.Fatalf("through the link channel: %q %v", echo, err)
	}

	// Only a unix:// url of its own: not a path of the daemon's choosing, nor another scheme
	for _, bad := range []string{"tcp://127.0.0.1:5432", "unix://" + d.dir + "/daemon.sock", strings.TrimPrefix(url, "unix://")} {
		if _, err := dialAs(t, d, "app", bad); err == nil || !strings.Contains(err.Error(), "no link of its") {
			t.Errorf("app asking for %s: %v", bad, err)
		}
	}

	// A link removed: its socket is nothing the channel opens any more
	if err := d.c.RemoveLink("app-db-5432"); err != nil {
		t.Fatal(err)
	}
	if _, err := dialAs(t, d, "app", url); err == nil || !strings.Contains(err.Error(), "no link of its") {
		t.Errorf("app asking for its removed link: %v", err)
	}

	// The machine gone: its channel with it
	if _, err := d.c.AddLink(Link{From: "app", To: "db", Port: 5432, As: "db.internal"}); err != nil {
		t.Fatal(err)
	}
	if err := d.c.RemoveMachine("app"); err != nil {
		t.Fatal(err)
	}
	if got := channels(); got["app"] {
		t.Errorf("channels after app went: %v", got)
	}
}

func TestAMachineWithNoLinkChannelStillGetsItsLinksAndTheDaemonSaysWhy(t *testing.T) {
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
	// app's snowglobe-vm predates link channels
	m, err := d.c.Machine("app")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(m.Socket+".nolinker", nil, 0o600)
	events, cancel := collect(t, d.c, 0)
	defer cancel()
	if _, err := d.c.AddLink(Link{From: "app", To: "db", Port: 5432, As: "db.internal"}); err != nil {
		t.Fatal(err)
	}
	if got := linksOf(t, d, "app"); len(got) != 1 || got[0].Host != "db.internal" {
		t.Errorf("app's links without a channel: %+v", got)
	}
	waitFor(t, func() bool {
		for _, ev := range events() {
			if ev.Kind == "link.error" && ev.Subject == "machine app" && strings.Contains(ev.Message, "update it") {
				return true
			}
		}
		return false
	})
	d.s.mu.Lock()
	_, open := d.s.linkers["app"]
	d.s.mu.Unlock()
	if open {
		t.Error("a channel for a machine that has none")
	}
}
