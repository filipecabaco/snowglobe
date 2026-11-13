package daemon

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// registry stands in for image registries: what each reference names now, changed by push.
type registry struct {
	mu      sync.Mutex
	digests map[string]string
}

func (r *registry) resolve(ref string, remote bool) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if d, ok := r.digests[ref]; ok {
		return d, nil
	}
	return sha256Of([]byte(ref)), nil
}

func (r *registry) push(ref string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.digests[ref] = sha256Of([]byte(ref + time.Now().String()))
}

// providerDaemon is a daemon in provider mode whose builds run this test binary playing
// snowglobe build, and whose images' digests come from reg.
func providerDaemon(t *testing.T, o Options) (*daemonUnderTest, *registry) {
	t.Helper()
	t.Setenv("SNOWGLOBE_FAKE_BUILD", "1")
	self, _ := os.Executable()
	reg := &registry{digests: map[string]string{}}
	if o.Features.Mode == "" {
		o.Features = modes["provider"]
	}
	o.Snowglobe, o.dockerThere, o.resolveImage, o.Version = self, func() bool { return true }, reg.resolve, "test"
	return startDaemon(t, shortTemp(t), o), reg
}

func TestAProviderAnswersBuildsOnly(t *testing.T) {
	d, _ := providerDaemon(t, Options{})
	defer d.stop(t)
	for _, r := range []struct{ method, path string }{
		{"GET", "/v1/templates"}, {"POST", "/v1/templates"}, {"DELETE", "/v1/templates/x"}, {"POST", "/v1/sites"},
		{"GET", "/v1/machines"}, {"POST", "/v1/machines"}, {"GET", "/v1/machines/m/attach"},
		{"POST", "/v1/machines/m/jobs"}, {"POST", "/v1/templates/t/jobs"}, {"POST", "/v1/services/s/jobs"},
		{"GET", "/v1/snapshots"}, {"POST", "/v1/machines/m/snapshots"}, {"GET", "/v1/services"},
		{"GET", "/v1/links"}, {"GET", "/v1/graph"}, {"GET", "/v1/ports"}, {"POST", "/v1/runs"},
		{"GET", "/v1/events"}, {"GET", "/v1/metrics"}, {"GET", "/metrics"},
	} {
		err := d.c.call(r.method, r.path, nil, nil)
		mode, off := Disabled(err)
		if statusOf(err) != 404 || !off || mode != "provider" || err.Error() != "the daemon runs in provider mode: builds only" {
			t.Errorf("%s %s: %v", r.method, r.path, err)
		}
	}
	// What is on: health, version, stats and builds
	if err := d.c.call("GET", "/v1/health", nil, nil); err != nil {
		t.Error(err)
	}
	v, err := d.c.Version()
	if err != nil || v.Mode != "provider" || v.Version != "test" || v.Features.Templates || !v.Features.Builds || v.Features.MCP() {
		t.Errorf("version: %+v %v", v, err)
	}
	st, err := d.c.Stats()
	if err != nil || st.Mode != "provider" {
		t.Errorf("stats: %+v %v", st, err)
	}
	if bs, err := d.c.Builds(); err != nil || len(bs) != 0 {
		t.Errorf("builds: %v %v", bs, err)
	}
	// A route that is no route at all isn't the mode's
	if _, off := Disabled(d.c.call("GET", "/v1/nothing", nil, nil)); off {
		t.Error("an unknown route said to be the mode's")
	}
	// A full daemon answers what it is too
	full := buildDaemon(t, true)
	defer full.stop(t)
	if v, err := full.c.Version(); err != nil || v.Mode != "full" || !v.Features.MCP() {
		t.Errorf("full: %+v %v", v, err)
	}
}

func TestAProviderBuildIsAnArtifactBuiltOnce(t *testing.T) {
	d, reg := providerDaemon(t, Options{})
	b, err := d.c.StartBuild(BuildRequest{Source: "example.com/app:1"})
	if err != nil {
		t.Fatal(err)
	}
	b = waitBuild(t, d, b.ID)
	if b.Status != "done" || b.Artifact == nil || b.Template != "" || b.Kernel != "none" || b.Key == "" || b.Cached {
		t.Fatalf("built: %+v", b)
	}
	log, _ := d.c.BuildLog(b.ID, 0)
	// For the page (no --sandbox), with no kernel
	if !strings.Contains(log, "--builder docker --kernel none") || strings.Contains(log, "--sandbox") || !strings.Contains(log, "==> packed") {
		t.Errorf("log: %s", log)
	}
	// Only the artifact is kept
	if _, err := os.Stat(filepath.Join(d.dir, "builds", b.ID, "site")); !os.IsNotExist(err) {
		t.Errorf("its site is kept: %v", err)
	}
	if ts := d.s.Templates(); len(ts) != 0 {
		t.Errorf("a template: %v", ts)
	}

	// The same again: that build, at once
	again, err := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Name: "other-name"})
	if err != nil || again.ID != b.ID || !again.Cached || again.Status != "done" {
		t.Errorf("again: %+v %v", again, err)
	}
	// Another kernel, another site
	linux, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Kernel: "linux"})
	if linux.ID == b.ID || linux.Cached {
		t.Errorf("with a kernel: %+v", linux)
	}
	linux = waitBuild(t, d, linux.ID)
	if log, _ := d.c.BuildLog(linux.ID, 0); !strings.Contains(log, "--kernel linux") {
		t.Errorf("log: %s", log)
	}
	// Other options, other keys
	keys := map[string]bool{b.Key: true, linux.Key: true}
	for _, req := range []BuildRequest{
		{Source: "example.com/app:1", CPUs: 2}, {Source: "example.com/app:1", Memory: 256}, {Source: "example.com/app:1", Network: "fetch"},
		{Source: "example.com/other:1"}, {Dockerfile: "FROM alpine\n"}, {Dockerfile: "FROM alpine:3\n"},
	} {
		nb, err := d.c.StartBuild(req)
		if err != nil {
			t.Fatal(err)
		}
		if nb.Cached || keys[nb.Key] {
			t.Errorf("%+v: built already (%+v)", req, nb)
		}
		keys[nb.Key] = true
		waitBuild(t, d, nb.ID)
	}
	// The same Dockerfile: cached
	if df, _ := d.c.StartBuild(BuildRequest{Dockerfile: "FROM alpine\n"}); !df.Cached {
		t.Errorf("the same Dockerfile again: %+v", df)
	}
	// The tag pushed again: built again
	reg.push("example.com/app:1")
	if nb, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1"}); nb.ID == b.ID || nb.Cached {
		t.Errorf("after a push: %+v", nb)
	}
	// What a request can't change in a provider: it always packs, and never makes a template
	nb, err := d.c.StartBuild(BuildRequest{Source: "example.com/third:1", NoTemplate: false})
	if err != nil || waitBuild(t, d, nb.ID).Artifact == nil {
		t.Errorf("%+v %v", nb, err)
	}
	if _, err := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Kernel: "bsd"}); statusOf(err) != 400 {
		t.Errorf("kernel bsd: %v", err)
	}
	// Known again after a restart
	d.stop(t)
	d2 := startDaemon(t, d.dir, Options{Features: modes["provider"], Snowglobe: d.s.o.Snowglobe, dockerThere: d.s.o.dockerThere, resolveImage: reg.resolve, Version: "test"})
	defer d2.stop(t)
	if df, _ := d2.c.StartBuild(BuildRequest{Dockerfile: "FROM alpine\n"}); !df.Cached {
		t.Errorf("after a restart: %+v", df)
	}
}

func TestABuildRunningIsJoinedAndAFailedOneIsNotKept(t *testing.T) {
	d, _ := providerDaemon(t, Options{})
	defer d.stop(t)
	slow, err := d.c.StartBuild(BuildRequest{Source: "example.com/slow:1"})
	if err != nil {
		t.Fatal(err)
	}
	joined, err := d.c.StartBuild(BuildRequest{Source: "example.com/slow:1"})
	if err != nil || joined.ID != slow.ID || joined.Cached {
		t.Errorf("joined: %+v %v", joined, err)
	}
	if bs, _ := d.c.Builds(); len(bs) != 1 {
		t.Errorf("%d builds", len(bs))
	}
	// Cancelled, it isn't what the next one gets
	d.c.RemoveBuild(slow.ID)
	waitBuild(t, d, slow.ID)
	next, _ := d.c.StartBuild(BuildRequest{Source: "example.com/slow:1"})
	if next.ID == slow.ID {
		t.Error("a cancelled build joined")
	}
	d.c.RemoveBuild(next.ID)
	waitBuild(t, d, next.ID)

	bad, _ := d.c.StartBuild(BuildRequest{Source: "example.com/fail:1"})
	if bad = waitBuild(t, d, bad.ID); bad.Status != "failed" || bad.Artifact != nil {
		t.Errorf("%+v", bad)
	}
	if again, _ := d.c.StartBuild(BuildRequest{Source: "example.com/fail:1"}); again.ID == bad.ID || again.Cached {
		t.Errorf("a failed build cached: %+v", again)
	}
}

func TestBuildsAreTimedAndArtifactsBounded(t *testing.T) {
	timed, _ := providerDaemon(t, Options{BuildTimeout: 3 * time.Second})
	defer timed.stop(t)
	slow, _ := timed.c.StartBuild(BuildRequest{Source: "example.com/slow:1"})
	if slow = waitBuild(t, timed, slow.ID); slow.Status != "failed" || !strings.Contains(slow.Error, "--build-timeout 3s") {
		t.Errorf("past its time: %+v", slow)
	}
	d, _ := providerDaemon(t, Options{MaxArtifact: 16})
	defer d.stop(t)
	big, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1"})
	if big = waitBuild(t, d, big.ID); big.Status != "failed" || !strings.Contains(big.Error, "--max-artifact") {
		t.Errorf("too big: %+v", big)
	}
	if _, err := os.Stat(filepath.Join(d.dir, "builds", big.ID, artifactFile)); !os.IsNotExist(err) {
		t.Errorf("its artifact is kept: %v", err)
	}
}

func TestTheCacheLetsGoOfWhatWasAskedForLongestAgo(t *testing.T) {
	d, _ := providerDaemon(t, Options{})
	defer d.stop(t)
	build := func(src string) *Build {
		b, err := d.c.StartBuild(BuildRequest{Source: src})
		if err != nil {
			t.Fatal(err)
		}
		return waitBuild(t, d, b.ID)
	}
	a := build("example.com/a:1")
	// Room for two (the fake's sites are all the same size)
	d.s.o.CacheSize = 2*a.Artifact.Bytes + 1
	b := build("example.com/b:1")
	// a asked for again: b is the one asked for longest ago
	time.Sleep(10 * time.Millisecond)
	if hit, _ := d.c.StartBuild(BuildRequest{Source: "example.com/a:1"}); !hit.Cached {
		t.Fatalf("%+v", hit)
	}
	c := build("example.com/c:1")
	have := map[string]bool{}
	bs, _ := d.c.Builds()
	for _, x := range bs {
		have[x.ID] = true
	}
	if !have[a.ID] || have[b.ID] || !have[c.ID] {
		t.Errorf("kept %v of a %s, b %s, c %s", have, a.ID, b.ID, c.ID)
	}
	if _, err := os.Stat(filepath.Join(d.dir, "builds", b.ID)); !os.IsNotExist(err) {
		t.Errorf("b's files: %v", err)
	}
	if again, _ := d.c.StartBuild(BuildRequest{Source: "example.com/b:1"}); again.Cached || again.ID == b.ID {
		t.Errorf("b after it went: %+v", again)
	}
	st, _ := d.c.Stats()
	if st.CacheSize != d.s.o.CacheSize || st.Artifacts < 2 {
		t.Errorf("stats: %+v", st)
	}
}

func TestAnArtifactDownloadsWithItsDigest(t *testing.T) {
	d, _ := providerDaemon(t, Options{})
	defer d.stop(t)
	b, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Name: "app"})
	// Not yet
	if b.Status != "done" {
		if err := d.c.call("GET", "/v1/builds/"+b.ID+"/artifact", nil, nil); err != nil && statusOf(err) != 409 {
			t.Errorf("while it builds: %v", err)
		}
	}
	b = waitBuild(t, d, b.ID)
	hc := d.c.http
	get := func(query string, header ...string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", d.c.base+"/v1/builds/"+b.ID+"/artifact"+query, nil)
		for i := 0; i+1 < len(header); i += 2 {
			req.Header.Set(header[i], header[i+1])
		}
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return resp, data
	}
	resp, data := get("")
	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])
	h := resp.Header
	if resp.StatusCode != 200 || hexSum != b.Artifact.SHA256 || int64(len(data)) != b.Artifact.Bytes ||
		h.Get("Content-Type") != "application/zstd" || h.Get("Content-Length") != strconv.Itoa(len(data)) ||
		h.Get("Content-Disposition") != `attachment; filename="app.tar.zst"` || h.Get("ETag") != `"`+hexSum+`"` ||
		h.Get("Digest") != "sha-256="+base64.StdEncoding.EncodeToString(sum[:]) || !strings.Contains(h.Get("Cache-Control"), "immutable") {
		t.Errorf("%d %v (sha256 %s, artifact %+v)", resp.StatusCode, h, hexSum, b.Artifact)
	}
	files := untar(t, zstdReader(t, data))
	if files["run.json"] == "" || files["index.html"] == "" || files["system/user.bin"] != "user" {
		t.Errorf("in it: %v", files)
	}
	// Asked again by its ETag: not again
	if resp, _ := get("", "If-None-Match", `"`+hexSum+`"`); resp.StatusCode != 304 {
		t.Errorf("if none match: %d", resp.StatusCode)
	}
	// A part of it, to resume
	if resp, part := get("", "Range", "bytes=2-5"); resp.StatusCode != 206 || !bytes.Equal(part, data[2:6]) {
		t.Errorf("a range: %d", resp.StatusCode)
	}
	// As a .tar.gz: made once, the same tar
	resp, gz := get("?format=gz")
	gsum := sha256.Sum256(gz)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/gzip" || resp.Header.Get("ETag") != `"`+hex.EncodeToString(gsum[:])+`"` ||
		resp.Header.Get("Content-Disposition") != `attachment; filename="app.tar.gz"` {
		t.Errorf("gz: %d %v", resp.StatusCode, resp.Header)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	if g := untar(t, zr); g["run.json"] != files["run.json"] || len(g) != len(files) {
		t.Errorf("gz holds %v", g)
	}
	if cur, _ := d.c.Build(b.ID); cur.Artifact.GzSHA256 != hex.EncodeToString(gsum[:]) {
		t.Errorf("%+v", cur.Artifact)
	}
	if resp, _ := get("?format=rar"); resp.StatusCode != 400 {
		t.Errorf("rar: %d", resp.StatusCode)
	}
	// The client's download: checked, and whole
	out := filepath.Join(t.TempDir(), "site.tar.zst")
	n, got, err := d.c.DownloadArtifact(b.ID, "", out)
	if err != nil || n != b.Artifact.Bytes || got != hexSum {
		t.Errorf("download: %d %s %v", n, got, err)
	}
	// A build with no artifact (a full daemon's template build) has none to give
	full := buildDaemon(t, true)
	defer full.stop(t)
	tb, _ := full.c.StartBuild(BuildRequest{Source: "example.com/app:1", NoTemplate: true})
	waitBuild(t, full, tb.ID)
	if _, _, err := full.c.DownloadArtifact(tb.ID, "", out+"2"); statusOf(err) != 404 {
		t.Errorf("no artifact: %v", err)
	}
}

func TestAFullDaemonBuildsWithAKernelAndArtifacts(t *testing.T) {
	d := buildDaemon(t, true)
	defer d.stop(t)
	d.s.o.resolveImage = (&registry{digests: map[string]string{}}).resolve
	b, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Kernel: "none", NoTemplate: true})
	b = waitBuild(t, d, b.ID)
	log, _ := d.c.BuildLog(b.ID, 0)
	if !strings.Contains(log, "--sandbox --builder docker --kernel none") || b.Artifact != nil {
		t.Errorf("%+v: %s", b, log)
	}
	// No kernel asked for: snowglobe build's own
	b, _ = d.c.StartBuild(BuildRequest{Source: "example.com/app:2", NoTemplate: true})
	waitBuild(t, d, b.ID)
	if log, _ := d.c.BuildLog(b.ID, 0); strings.Contains(log, "--kernel") {
		t.Errorf("a kernel nobody asked for: %s", log)
	}
	// An artifact asked for: packed, cached, no template
	a, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Artifact: true, Name: "art"})
	a = waitBuild(t, d, a.ID)
	if a.Artifact == nil || a.Template != "" || a.Kernel != "" {
		t.Errorf("%+v", a)
	}
	if again, _ := d.c.StartBuild(BuildRequest{Source: "example.com/app:1", Artifact: true}); !again.Cached || again.ID != a.ID {
		t.Errorf("%+v", again)
	}
}

func TestABuildContextIsUploadedWhole(t *testing.T) {
	d, _ := providerDaemon(t, Options{MaxContext: 1 << 20})
	defer d.stop(t)
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "app", "lib"), 0o755)
	os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine\nCOPY app /app\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "app", "run.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755)
	os.WriteFile(filepath.Join(dir, "app", "lib", "data"), []byte("data"), 0o600)
	os.Symlink("run.sh", filepath.Join(dir, "app", "start"))
	os.Symlink("../Dockerfile", filepath.Join(dir, "app", "df"))
	up, err := d.c.UploadContext(dir)
	if err != nil {
		t.Fatal(err)
	}
	if up.Files != 7 || !strings.HasPrefix(up.Digest, "sha256:") {
		t.Errorf("%+v", up)
	}
	tree := filepath.Join(d.dir, "contexts", up.Context, "tree")
	for name, mode := range map[string]os.FileMode{"app/run.sh": 0o755, "app/lib/data": 0o600, "Dockerfile": 0o644} {
		if fi, err := os.Stat(filepath.Join(tree, name)); err != nil || fi.Mode().Perm() != mode {
			t.Errorf("%s: %v %v", name, fi, err)
		}
	}
	if l, err := os.Readlink(filepath.Join(tree, "app", "start")); err != nil || l != "run.sh" {
		t.Errorf("link: %q %v", l, err)
	}
	// The same tree again, touched: the same digest; changed: another
	now := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(dir, "app", "run.sh"), now, now)
	up2, _ := d.c.UploadContext(dir)
	os.Chmod(filepath.Join(dir, "app", "run.sh"), 0o644)
	up3, _ := d.c.UploadContext(dir)
	if up2.Digest != up.Digest || up3.Digest == up.Digest || up2.Context == up.Context {
		t.Errorf("digests %s %s %s", up.Digest, up2.Digest, up3.Digest)
	}
	// Built from it, the context is the build's; the same again is cached, its upload let go of
	b, err := d.c.StartBuild(BuildRequest{Context: up.Context})
	if err != nil {
		t.Fatal(err)
	}
	if b.Kind != "context" || b.Input != up.Digest {
		t.Errorf("%+v", b)
	}
	waitBuild(t, d, b.ID)
	// The site calls it by the build's name, not the daemon's path to it
	if log, _ := d.c.BuildLog(b.ID, 0); !strings.Contains(log, "--source-name "+b.Name) {
		t.Errorf("log: %s", log)
	}
	if _, err := os.Stat(filepath.Join(d.dir, "contexts", up.Context)); !os.IsNotExist(err) {
		t.Errorf("the upload is still there: %v", err)
	}
	again, err := d.c.StartBuild(BuildRequest{Context: up2.Context})
	if err != nil || !again.Cached || again.ID != b.ID {
		t.Errorf("%+v %v", again, err)
	}
	if _, err := os.Stat(filepath.Join(d.dir, "contexts", up2.Context)); !os.IsNotExist(err) {
		t.Errorf("a cached build's upload is still there: %v", err)
	}
	for _, id := range []string{up.Context, "../x", "ctx-zzzzzz"} {
		if _, err := d.c.StartBuild(BuildRequest{Context: id}); statusOf(err) != 404 && statusOf(err) != 400 {
			t.Errorf("context %s: %v", id, err)
		}
	}
	if _, err := d.c.StartBuild(BuildRequest{Context: up3.Context, Source: "alpine"}); statusOf(err) != 400 {
		t.Errorf("a context and a source: %v", err)
	}
}

func TestABuildContextStaysInItsDirectory(t *testing.T) {
	d, _ := providerDaemon(t, Options{MaxContext: 64 << 10})
	defer d.stop(t)
	dockerfile := entry{name: "Dockerfile", body: "FROM alpine\n"}
	for name, entries := range map[string][]entry{
		"a path up":                  {dockerfile, {name: "../escape", body: "x"}},
		"an absolute path":           {dockerfile, {name: "/tmp/escape", body: "x"}},
		"a link up":                  {dockerfile, {name: "up", link: "../../etc"}},
		"an absolute link":           {dockerfile, {name: "passwd", link: "/etc/passwd"}},
		"a path through a link":      {dockerfile, {name: "sub/", dir: true}, {name: "l", link: "sub"}, {name: "l/x", body: "x"}},
		"a file over a link":         {dockerfile, {name: "l", link: "Dockerfile"}, {name: "l", body: "x"}},
		"a hard link up":             {dockerfile, {name: "h", hard: "../x"}},
		"a device":                   {dockerfile, {name: "dev", typ: tar.TypeChar}},
		"no Dockerfile":              {{name: "x", body: "x"}},
		"a Dockerfile that's a link": {{name: "real", body: "FROM x"}, {name: "Dockerfile", link: "real"}},
		"too much":                   {dockerfile, {name: "big", body: strings.Repeat("x", 128<<10)}},
	} {
		resp, err := d.c.http.Post(d.c.base+"/v1/contexts", "application/x-tar", bytes.NewReader(tarOf(t, entries)))
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 400 && resp.StatusCode != 413 {
			t.Errorf("%s: %d %s", name, resp.StatusCode, data)
		}
	}
	if _, err := os.Stat("/tmp/escape"); err == nil {
		t.Error("written outside")
	}
	// Nothing left of them
	if left, _ := filepath.Glob(filepath.Join(d.dir, "contexts", "ctx-*")); len(left) != 0 {
		t.Errorf("left: %v", left)
	}
	// What is fine: links inside, hard links, directories
	ok := []entry{dockerfile, {name: "a/", dir: true}, {name: "a/f", body: "f"}, {name: "a/l", link: "f"}, {name: "top", link: "a/f"}, {name: "h", hard: "a/f"}}
	resp, _ := d.c.http.Post(d.c.base+"/v1/contexts", "application/x-tar", bytes.NewReader(tarOf(t, ok)))
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Errorf("%d %s", resp.StatusCode, data)
	}
}

func TestAProviderHoldsRemoteRequestsToItsPolicy(t *testing.T) {
	old := lookupIP
	lookupIP = func(host string) ([]net.IP, error) {
		switch host {
		case "registry.internal":
			return []net.IP{net.ParseIP("10.0.0.5")}, nil
		case "localhost":
			return []net.IP{net.ParseIP("127.0.0.1")}, nil
		}
		return []net.IP{net.ParseIP("93.184.215.14")}, nil
	}
	t.Cleanup(func() { lookupIP = old })
	t.Setenv("SNOWGLOBE_FAKE_BUILD", "1")
	self, _ := os.Executable()
	reg := &registry{digests: map[string]string{}}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	d := startDaemon(t, shortTemp(t), Options{Listen: addr, Token: "0123456789abcdef", Features: modes["provider"], Snowglobe: self,
		dockerThere: func() bool { return true }, resolveImage: reg.resolve})
	defer d.stop(t)
	waitFor(t, func() bool {
		c, err := net.Dial("tcp", addr)
		if err == nil {
			c.Close()
		}
		return err == nil
	})
	c, _ := NewClient("http://"+addr, "0123456789abcdef")
	// No path of this host
	if err := c.call("POST", "/v1/builds", BuildRequest{Source: "/etc"}, nil); statusOf(err) != 403 {
		t.Errorf("a host path: %v", err)
	}
	// No registry on its own network
	for _, ref := range []string{"registry.internal/app:1", "localhost:5000/app:1"} {
		if _, err := c.StartBuild(BuildRequest{Source: ref}); statusOf(err) != 403 || !strings.Contains(err.Error(), "public") {
			t.Errorf("%s: %v", ref, err)
		}
	}
	// Off in its mode, from there too
	if _, err := c.Templates(); statusOf(err) != 404 {
		t.Errorf("templates: %v", err)
	}
	// What it is for: a context it sends, and an image of a public registry
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine\n"), 0o644)
	up, err := c.UploadContext(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.StartBuild(BuildRequest{Context: up.Context})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { cur, _ := c.Build(b.ID); return cur.finished() })
	if _, _, err := c.DownloadArtifact(b.ID, "gz", filepath.Join(t.TempDir(), "s.tar.gz")); err != nil {
		t.Error(err)
	}
	if b, err := c.StartBuild(BuildRequest{Source: "ghcr.io/o/app:1"}); err != nil {
		t.Error(err)
	} else {
		waitFor(t, func() bool { cur, _ := c.Build(b.ID); return cur.finished() })
	}
	// Without the token: nothing
	anon, _ := NewClient("http://"+addr, "")
	if _, err := anon.Builds(); statusOf(err) != 401 {
		t.Errorf("no token: %v", err)
	}
}

type entry struct {
	name, body, link, hard string
	dir                    bool
	typ                    byte
}

func tarOf(t *testing.T, entries []entry) []byte {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body)), Typeflag: tar.TypeReg}
		switch {
		case e.dir:
			h.Typeflag, h.Mode = tar.TypeDir, 0o755
		case e.link != "":
			h.Typeflag, h.Linkname, h.Size = tar.TypeSymlink, e.link, 0
		case e.hard != "":
			h.Typeflag, h.Linkname, h.Size = tar.TypeLink, e.hard, 0
		case e.typ != 0:
			h.Typeflag, h.Size = e.typ, 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size > 0 {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	return b.Bytes()
}

func zstdReader(t *testing.T, data []byte) io.Reader {
	t.Helper()
	zr, err := zstd.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

func untar(t *testing.T, r io.Reader) map[string]string {
	t.Helper()
	files := map[string]string{}
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return files
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(tr)
		files[h.Name] = string(data)
	}
}
