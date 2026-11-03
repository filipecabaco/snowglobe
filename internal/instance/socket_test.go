package instance

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// With SNOWGLOBE_FAKE_VM set, this test binary stands in for snowglobe-vm: `run SITE ... --socket
// PATH --stop-file PATH`. It listens on the socket (or fails as a real run would when it can't),
// says it has restored, and ends once its stop file exists. FAKE_VM=fail prints a reason and
// exits 1 instead.
func TestMain(m *testing.M) {
	switch os.Getenv("SNOWGLOBE_FAKE_VM") {
	case "":
		os.Exit(m.Run())
	case "fail":
		fmt.Fprintln(os.Stderr, "snowglobe-vm: boom: the reason it stopped")
		os.Exit(1)
	}
	flag := func(name string) string {
		for i, a := range os.Args {
			if a == "--"+name && i+1 < len(os.Args) {
				return os.Args[i+1]
			}
		}
		return ""
	}
	// A control socket, or a serving one's (run --fork)
	sock := flag("socket")
	if sock == "" {
		sock = flag("serve")
	}
	l, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, "snowglobe-vm:", err)
		os.Exit(1)
	}
	defer l.Close()
	fmt.Println("restored fake in 0.1s (sandboxed: nothing)")
	for {
		if _, err := os.Stat(flag("stop-file")); err == nil {
			os.Exit(143)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// fakeSite is the least runNative takes for a site: a system/filesystem directory.
func fakeSite(t *testing.T) string {
	site := t.TempDir()
	if err := os.MkdirAll(filepath.Join(site, "system", "filesystem"), 0o755); err != nil {
		t.Fatal(err)
	}
	return site
}

// longHome points the user cache somewhere whose instance paths are too long for a socket.
func longHome(t *testing.T) string {
	home := filepath.Join(t.TempDir(), strings.Repeat("a-rather-long-directory-name/", 4))
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	dir, err := instancesDir()
	if err != nil {
		t.Fatal(err)
	}
	if len(filepath.Join(dir, "some-instance", "sock")) <= sockMax {
		t.Fatalf("not long enough to test: %s", dir)
	}
	return home
}

func TestSocketPath(t *testing.T) {
	short := t.TempDir()
	if p, err := socketPath(short); err != nil || p != filepath.Join(short, "sock") {
		t.Fatalf("a short directory keeps its socket: %s %v", p, err)
	}
	long := filepath.Join(t.TempDir(), strings.Repeat("x", 120))
	p, err := socketPath(long)
	if err != nil {
		t.Fatal(err)
	}
	if len(p) > sockMax || strings.HasPrefix(p, long) {
		t.Fatalf("got %s (%d bytes)", p, len(p))
	}
	st, err := os.Stat(filepath.Dir(p))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("its directory isn't private: %v %v", st.Mode(), err)
	}
	// Removed with its directory; a socket inside the instance's directory is left to it
	removeSocket(p, long)
	if _, err := os.Stat(filepath.Dir(p)); !os.IsNotExist(err) {
		t.Error("the private directory was kept")
	}
	inside := filepath.Join(short, "sock")
	os.WriteFile(inside, nil, 0o600)
	removeSocket(inside, short)
	if _, err := os.Stat(inside); err != nil {
		t.Error("removed a socket inside the instance's directory")
	}
}

func TestADetachedInstanceUnderALongCachePathStartsAndStops(t *testing.T) {
	longHome(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_FAKE_VM", "listen")
	o := Options{Name: "long-path", Detach: true, LogDir: t.TempDir()}
	if err := runNative(o, fakeSite(t), self, "none", nil); err != nil {
		t.Fatalf("didn't start: %v", err)
	}
	st, dir, ok := loadNative("long-path")
	if !ok {
		t.Fatal("not running")
	}
	if len(st.Socket) > sockMax {
		t.Fatalf("socket path %d bytes", len(st.Socket))
	}
	c, err := net.Dial("unix", st.Socket)
	if err != nil {
		t.Fatalf("its socket doesn't answer: %v", err)
	}
	c.Close()
	if err := Stop("long-path"); err != nil {
		t.Fatal(err)
	}
	if !gone(st.Pid, 5*time.Second) {
		t.Fatal("still running")
	}
	for _, p := range []string{dir, filepath.Dir(st.Socket)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s was kept", p)
		}
	}
}

func TestADetachedInstanceThatFailsSaysWhy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_FAKE_VM", "fail")
	err = runNative(Options{Name: "failing", Detach: true, LogDir: t.TempDir()}, fakeSite(t), self, "none", nil)
	if err == nil || !strings.Contains(err.Error(), "boom: the reason it stopped") {
		t.Fatalf("got %v", err)
	}
	if _, _, ok := loadNative("failing"); ok {
		t.Error("a failed instance counts as running")
	}
}
