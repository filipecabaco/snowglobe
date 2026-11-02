package tools

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

// fakeDocker puts a docker on the PATH that logs its arguments, one call a line, and then runs
// script (a POSIX sh body, with the arguments in $@). It returns the log's path.
func fakeDocker(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	body := "#!/bin/sh\necho \"$*\" >> '" + log + "'\n" + script + "\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func calls(t *testing.T, log string) []string {
	t.Helper()
	data, _ := os.ReadFile(log)
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func TestBuildUsesTheImageThatIsThere(t *testing.T) {
	log := fakeDocker(t, "exit 0")
	img, err := Build("dev")
	if err != nil {
		t.Fatal(err)
	}
	if img.Tag() != "snowglobe-tools:"+Version() {
		t.Errorf("tag %s", img.Tag())
	}
	if got := calls(t, log); len(got) != 1 || !strings.HasPrefix(got[0], "image inspect") {
		t.Errorf("an image already there was built or pulled: %q", got)
	}
}

func TestBuildPullsThePublishedImage(t *testing.T) {
	t.Setenv("SNOWGLOBE_TOOLS_BUILD", "")
	log := fakeDocker(t, `[ "$1" = image ] && exit 1; exit 0`)
	img, err := Build("dev")
	if err != nil {
		t.Fatal(err)
	}
	published := Registry + ":" + Version()
	want := []string{"image inspect --format {{.Id}} " + img.Tag(), "pull --quiet " + published, "tag " + published + " " + img.Tag()}
	if got := calls(t, log); !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestBuildBuildsFromItsEmbeddedContext(t *testing.T) {
	for _, forced := range []bool{true, false} {
		if forced {
			t.Setenv("SNOWGLOBE_TOOLS_BUILD", "1")
		} else {
			t.Setenv("SNOWGLOBE_TOOLS_BUILD", "")
		}
		// The build context it is given has the Dockerfile and the runtime's sources
		log := fakeDocker(t, `case "$1" in
build) for a; do dir=$a; done
       [ -f "$dir/Dockerfile" ] && [ -f "$dir/runtime/Cargo.toml" ] && [ -d "$dir/runtime/src" ] ;;
*) exit 1 ;;
esac`)
		img, err := Build("dev")
		if err != nil {
			t.Fatalf("forced %v: %v", forced, err)
		}
		got := calls(t, log)
		last := got[len(got)-1]
		if !strings.HasPrefix(last, "build --quiet --tag "+img.Tag()+" ") {
			t.Errorf("forced %v: %q", forced, got)
		}
		if pulled := slices.ContainsFunc(got, func(c string) bool { return strings.HasPrefix(c, "pull") }); pulled == forced {
			t.Errorf("forced %v: pulled %v: %q", forced, pulled, got)
		}
		// The context is temporary
		if _, err := os.Stat(strings.Fields(last)[4]); err == nil {
			t.Errorf("the build context was kept")
		}
	}
}

func TestBuildFails(t *testing.T) {
	t.Setenv("SNOWGLOBE_TOOLS_BUILD", "1")
	fakeDocker(t, "echo no daemon >&2; exit 1")
	if _, err := Build("dev"); err == nil || !strings.Contains(err.Error(), "no daemon") {
		t.Fatalf("got %v", err)
	}
}

func TestExtractVMCopiesItOutOfAContainer(t *testing.T) {
	log := fakeDocker(t, `[ "$1" = create ] && echo c0ffee; exit 0`)
	if err := (&Image{tag: "snowglobe-tools:x"}).ExtractVM("/tmp/vm"); err != nil {
		t.Fatal(err)
	}
	want := []string{"create snowglobe-tools:x", "cp c0ffee:" + VM + " /tmp/vm", "rm c0ffee"}
	if got := calls(t, log); !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	fakeDocker(t, "exit 1")
	if err := (&Image{tag: "snowglobe-tools:x"}).ExtractVM("/tmp/vm"); err == nil {
		t.Error("a failed create")
	}
}

func TestNativeSourceNeedsDocker(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if NativeSource("dev") != nil {
		t.Fatal("a source without Docker")
	}
	// With Docker: the image's snowglobe-vm, keyed by the image's contents
	fakeDocker(t, `case "$1" in
create) echo c0ffee ;;
cp) echo vm > "$3" ;;
esac`)
	src := NativeSource("dev")
	if src == nil || src.Key != Version() {
		t.Fatalf("got %+v", src)
	}
	dest := filepath.Join(t.TempDir(), "vm")
	if err := src.Extract(dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); string(got) != "vm\n" {
		t.Errorf("got %q", got)
	}
}

func TestJITArgs(t *testing.T) {
	t.Setenv("ARMLESS_JIT", "")
	if got := JITArgs(); got != nil {
		t.Errorf("unset: %q", got)
	}
	t.Setenv("ARMLESS_JIT", "off")
	if got := JITArgs(); !slices.Equal(got, []string{"-e", "ARMLESS_JIT=off"}) {
		t.Errorf("got %q", got)
	}
}

func TestNetworkArgs(t *testing.T) {
	ca := filepath.Join(t.TempDir(), "ca.pem")
	os.WriteFile(ca, []byte("cert"), 0o644)
	for _, tc := range []struct {
		name string
		env  map[string]string
		want []string
	}{
		{"nothing set", nil, nil},
		{"a remote proxy", map[string]string{"HTTPS_PROXY": "http://proxy.corp:3128"},
			[]string{"-e", "HTTPS_PROXY=http://proxy.corp:3128"}},
		{"a proxy on the host's loopback shares its network", map[string]string{"http_proxy": "127.0.0.1:8080"},
			[]string{"-e", "http_proxy=127.0.0.1:8080", "--network", "host"}},
		{"loopback in NO_PROXY isn't a proxy", map[string]string{"NO_PROXY": "localhost"},
			[]string{"-e", "NO_PROXY=localhost"}},
		{"the CA bundle is mounted", map[string]string{"SSL_CERT_FILE": ca},
			[]string{"-v", ca + ":/etc/snowglobe/ca-bundle.pem:ro", "-e", "SSL_CERT_FILE=/etc/snowglobe/ca-bundle.pem"}},
		{"a CA bundle that isn't there isn't", map[string]string{"SSL_CERT_FILE": ca + ".missing"}, nil},
	} {
		for _, v := range append(proxyVars, "SSL_CERT_FILE") {
			t.Setenv(v, tc.env[v])
		}
		if got := NetworkArgs(); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestLoopback(t *testing.T) {
	for proxy, want := range map[string]bool{
		"http://localhost:3128":  true,
		"127.0.0.1:8080":         true,
		"http://127.1.2.3":       true,
		"http://[::1]:8080":      true,
		"http://proxy.corp:3128": false,
		"http://10.0.0.1:3128":   false,
		"http://%zz":             false,
	} {
		if loopback(proxy) != want {
			t.Errorf("%s: want %v", proxy, want)
		}
	}
}

func TestVersionNamesTheImageContents(t *testing.T) {
	v := Version()
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(v) || Version() != v {
		t.Fatalf("got %q", v)
	}
}

// tgz is a gzipped tar of files (name -> contents).
func tgz(t *testing.T, files map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, data := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg})
		tw.Write([]byte(data))
	}
	tw.Close()
	gz.Close()
	file := filepath.Join(t.TempDir(), "a.tgz")
	if err := os.WriteFile(file, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestExtractMembers(t *testing.T) {
	archive := tgz(t, map[string]string{"./package/lib/xterm.js": "js", "package/css/xterm.css": "css", "package/README": "no"})
	out := t.TempDir()
	members := map[string]string{"package/lib/xterm.js": "xterm/xterm.js", "package/css/xterm.css": "xterm/xterm.css"}
	if err := extractMembers(archive, members, out); err != nil {
		t.Fatal(err)
	}
	for file, want := range map[string]string{"xterm/xterm.js": "js", "xterm/xterm.css": "css"} {
		if got, _ := os.ReadFile(filepath.Join(out, file)); string(got) != want {
			t.Errorf("%s: got %q", file, got)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "package")); err == nil {
		t.Error("a member it wasn't asked for was written")
	}

	members["package/lib/addon.js"] = "xterm/addon.js"
	if err := extractMembers(archive, members, out); err == nil || !strings.Contains(err.Error(), "found 2 of its 3") {
		t.Errorf("a missing member: %v", err)
	}
	notGzip := filepath.Join(t.TempDir(), "x.tgz")
	os.WriteFile(notGzip, []byte("plain text, not gzip"), 0o644)
	if err := extractMembers(notGzip, members, out); err == nil {
		t.Error("not a gzip")
	}
	if err := extractMembers(filepath.Join(t.TempDir(), "none.tgz"), members, out); err == nil {
		t.Error("no archive")
	}
}

func TestFetchSiteRefusesADownloadWithTheWrongChecksum(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	df, _ := context.ReadFile("Dockerfile")
	m := regexp.MustCompile(`ADD --checksum=sha256:([0-9a-f]+)\s*\\?\s*(\S+)`).FindStringSubmatch(string(df))
	if m == nil {
		t.Fatal("the Dockerfile has no ADD --checksum")
	}
	sum, url := m[1], m[2]
	// The cached copy (as if downloaded earlier) has been tampered with: it is not used, and goes
	dir, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(dir, "snowglobe", "site", sum[:16]+"-"+url[strings.LastIndex(url, "/")+1:])
	os.MkdirAll(filepath.Dir(local), 0o755)
	os.WriteFile(local, []byte("tampered"), 0o644)
	if err := FetchSite(t.TempDir()); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(local); err == nil {
		t.Error("the bad copy was kept")
	}
}

// The out directory a `docker run -v OUT:/out` was given, in the fake docker script: $out.
const outMount = `out=; prev=; for a; do [ "$prev" = -v ] && case "$a" in *:/out) out=${a%:/out} ;; esac; prev=$a; done`

func TestCopySitePatchesArmless(t *testing.T) {
	fakeDocker(t, outMount+`
mkdir -p "$out/armless" && echo 'pages = Math.ceil((o.memory_mb + 1024) * 16);' > "$out/armless/armless.js"`)
	out := t.TempDir()
	if err := (&Image{tag: "snowglobe-tools:x"}).CopySite(out); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(out, "armless", "armless.js")); !strings.Contains(string(got), "o.memory_mb * 3 + 1024") {
		t.Errorf("not patched: %q", got)
	}
	// A runtime of another shape fails rather than ship unpatched
	fakeDocker(t, outMount+`
mkdir -p "$out/armless" && echo 'something else' > "$out/armless/armless.js"`)
	if err := (&Image{tag: "snowglobe-tools:x"}).CopySite(t.TempDir()); err == nil {
		t.Error("an unexpected runtime was copied")
	}
	fakeDocker(t, "exit 1")
	if err := (&Image{tag: "snowglobe-tools:x"}).CopySite(t.TempDir()); err == nil {
		t.Error("a failed copy")
	}
}

func TestSnapshotRunsTheVMInTheToolsImage(t *testing.T) {
	t.Setenv("ARMLESS_JIT", "off")
	t.Setenv("SNOWGLOBE_BOOT_STALL_SECS", "30")
	for _, v := range append(proxyVars, "SSL_CERT_FILE") {
		t.Setenv(v, "")
	}
	t.Setenv("HTTPS_PROXY", "http://localhost:3128")
	log := fakeDocker(t, "exit 0")
	img := &Image{tag: "snowglobe-tools:x"}
	tunnels := []tunnel.Tunnel{{Host: "db", Port: 5432, URL: "wss://gw/db"}}
	if err := img.Snapshot("/site", 256, "$ ", []string{"ls", "env"}, "fetch", tunnels, true, 2, 4, true); err != nil {
		t.Fatal(err)
	}
	user := fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
	want := "run --rm --user " + user + " -v /site:/out -e SNOWGLOBE_BOOT_STALL_SECS=30 -e ARMLESS_JIT=off " +
		"-e HTTPS_PROXY=http://localhost:3128 --network host snowglobe-tools:x " + VM + " snapshot /out/system " +
		"--memory 256 --network fetch --cpus 2 --build-cpus 4 --cols 90 --rows 30 --ready $  --sandbox " +
		"--exercise ls --exercise env --tunnel db:5432=wss://gw/db --allow-private"
	if got := calls(t, log); len(got) != 1 || got[0] != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	// Offline: none of the host's network settings
	log = fakeDocker(t, "exit 0")
	if err := img.Snapshot("/site", 256, "", nil, "none", nil, false, 1, 4, false); err != nil {
		t.Fatal(err)
	}
	if got := calls(t, log)[0]; strings.Contains(got, "HTTPS_PROXY") || strings.Contains(got, "--ready") || strings.Contains(got, "--sandbox") {
		t.Errorf("offline: %s", got)
	}
}
