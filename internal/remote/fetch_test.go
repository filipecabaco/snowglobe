package remote

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// cacheHome points the user cache at a fresh directory.
func cacheHome(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
}

// tarOf is a tar of files (name -> contents).
func tarOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, data := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(data))
	}
	tw.WriteHeader(&tar.Header{Name: "system/", Mode: 0o755, Typeflag: tar.TypeDir})
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func gzipped(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write(data)
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// warmPack is a warm pack of blobs, in the order given.
func warmPack(names []string, blobs []string) []byte {
	index := "["
	for i, name := range names {
		if i > 0 {
			index += ","
		}
		index += `["` + name + `",1,` + strconv.Itoa(len(blobs[i])) + `]`
	}
	index += "]"
	var pack bytes.Buffer
	binary.Write(&pack, binary.LittleEndian, uint32(len(index)))
	pack.WriteString(index)
	for _, b := range blobs {
		pack.WriteString(b)
	}
	return pack.Bytes()
}

func TestFetchATarballURLWithAQueryUnpacksAndRevalidatesIt(t *testing.T) {
	cacheHome(t)
	archive := gzipped(t, tarOf(t, map[string]string{"run.json": `{"title":"x"}`, "system/state.bin.zst": "state"}))
	var mu sync.Mutex
	var conditional []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		conditional = append(conditional, r.Header.Get("If-None-Match")+"|"+r.Header.Get("If-Modified-Since"))
		mu.Unlock()
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Last-Modified", "Mon, 02 Nov 2026 10:00:00 GMT")
		w.Write(archive)
	}))
	defer srv.Close()

	// The query isn't part of the file name: it is still a .tar.gz
	source := srv.URL + "/site.tar.gz?v=2"
	dir, err := Fetch(source)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "system", "state.bin.zst")); string(got) != "state" {
		t.Fatalf("not unpacked: %q", got)
	}
	again, err := Fetch(source)
	if err != nil || again != dir {
		t.Fatalf("second fetch: %s, %v", again, err)
	}
	if len(conditional) != 2 || conditional[0] != "|" || conditional[1] != `"v1"|Mon, 02 Nov 2026 10:00:00 GMT` {
		t.Fatalf("the cached copy wasn't revalidated with its validators: %q", conditional)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "run.json")); string(got) != `{"title":"x"}` {
		t.Fatalf("a 304 kept the cached copy: %q", got)
	}
}

func TestFetchATarballFails(t *testing.T) {
	cacheHome(t)
	notASite := gzipped(t, tarOf(t, map[string]string{"index.html": "hi"}))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/missing.tar.gz":
			http.NotFound(w, r)
		case "/plain.tar.gz":
			w.Write(notASite)
		default:
			w.Write([]byte("this is not gzip at all"))
		}
	}))
	defer srv.Close()
	for path, want := range map[string]string{
		"/missing.tar.gz": "404",
		"/plain.tar.gz":   "no run.json",
		"/garbage.tgz":    "gzip",
	} {
		if _, err := Fetch(srv.URL + path); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", path, err, want)
		}
	}
}

func TestUnpackALocalTarballOnce(t *testing.T) {
	cacheHome(t)
	var zst bytes.Buffer
	zw, _ := zstd.NewWriter(&zst)
	zw.Write(tarOf(t, map[string]string{"run.json": "{}", "index.html": "page"}))
	zw.Close()
	file := filepath.Join(t.TempDir(), "site.tar.zst")
	os.WriteFile(file, zst.Bytes(), 0o644)

	dir, err := Unpack(file)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "index.html")); string(got) != "page" {
		t.Fatalf("got %q", got)
	}
	// Unchanged, it is used as unpacked
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("cached"), 0o644)
	if again, err := Unpack(file); err != nil || again != dir {
		t.Fatalf("%s, %v", again, err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "index.html")); string(got) != "cached" {
		t.Error("an unchanged tarball was unpacked again")
	}
	if _, err := Unpack(filepath.Join(t.TempDir(), "none.tar")); err == nil {
		t.Error("a missing tarball unpacked")
	}
}

// siteServer serves a deployed site: its files, a warm pack holding blob a and blob b at its own
// blob URL, and counts the requests for each path.
type siteServer struct {
	*httptest.Server
	mu    sync.Mutex
	files map[string]string
	hits  map[string]int
}

func newSiteServer(t *testing.T, files map[string]string) *siteServer {
	s := &siteServer{files: files, hits: map[string]int{}}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits[r.URL.Path]++
		data, ok := s.files[r.URL.Path]
		s.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(data))
	}))
	t.Cleanup(s.Close)
	return s
}

const twoBlobs = `{"version":3,"size":8,"fsroot":[["bin",0,0,16877,0,0,[
	["a",3,0,33188,0,0,"aaaaaaaaaa.bin.zst"],["b",5,0,33188,0,0,"bbbbbbbbbb.bin.zst"]]]]}`

func TestMirrorADeployedSite(t *testing.T) {
	cacheHome(t)
	srv := newSiteServer(t, map[string]string{
		"/demo/run.json":                             `{"title":"demo"}`,
		"/demo/index.html":                           `armless({ baseurl: "../blobs/" })`,
		"/demo/system/filesystem.json":               twoBlobs,
		"/demo/system/state.bin.zst":                 "state",
		"/demo/system/tls.json":                      `{"ca":"old"}`,
		"/demo/system/warm.pack":                     string(warmPack([]string{"aaaaaaaaaa.bin.zst"}, []string{"AAA"})),
		"/blobs/bbbbbbbbbb.bin.zst":                  "BBBBB",
		"/demo/system/filesystem/aaaaaaaaaa.bin.zst": "not from here",
	})
	dir, err := Fetch(srv.URL + "/demo")
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"run.json": `{"title":"demo"}`, "system/state.bin.zst": "state", "system/tls.json": `{"ca":"old"}`,
		"system/filesystem/aaaaaaaaaa.bin.zst": "AAA", "system/filesystem/bbbbbbbbbb.bin.zst": "BBBBB",
	} {
		if got, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name))); string(got) != want {
			t.Errorf("%s: got %q, want %q", name, got, want)
		}
	}
	// The optional files it doesn't have aren't an error, nor written
	if _, err := os.Stat(filepath.Join(dir, "system", "console.bin")); err == nil {
		t.Error("a missing optional file was written")
	}
	if srv.hits["/demo/run.json"] != 1 {
		t.Errorf("run.json fetched %d times: a second copy may be of another build", srv.hits["/demo/run.json"])
	}

	// Same run.json: nothing else is fetched
	srv.hits = map[string]int{}
	if again, err := Fetch(srv.URL + "/demo"); err != nil || again != dir {
		t.Fatal(again, err)
	}
	if len(srv.hits) != 1 || srv.hits["/demo/run.json"] != 1 {
		t.Errorf("a cached site fetched %v", srv.hits)
	}

	// A new build is fetched again; blobs it has already are not, and what it dropped goes
	srv.files["/demo/run.json"] = `{"title":"demo 2"}`
	delete(srv.files, "/demo/system/tls.json")
	srv.hits = map[string]int{}
	if _, err := Fetch(srv.URL + "/demo"); err != nil {
		t.Fatal(err)
	}
	if srv.hits["/demo/system/state.bin.zst"] != 1 || srv.hits["/blobs/bbbbbbbbbb.bin.zst"] != 0 || srv.hits["/demo/system/warm.pack"] != 0 {
		t.Errorf("a new build fetched %v", srv.hits)
	}
	if _, err := os.Stat(filepath.Join(dir, "system", "tls.json")); err == nil {
		t.Error("the earlier build's CA was kept for a build without one")
	}
}

func TestMirrorFails(t *testing.T) {
	cacheHome(t)
	site := map[string]string{
		"/run.json": "{}", "/index.html": "page", "/system/filesystem.json": twoBlobs,
		"/system/state.bin.zst": "state", "/system/filesystem/aaaaaaaaaa.bin.zst": "AAA",
	}
	srv := newSiteServer(t, site)
	// A blob it can't fetch
	if _, err := Fetch(srv.URL + "/"); err == nil || !strings.Contains(err.Error(), "bbbbbbbbbb.bin.zst") {
		t.Errorf("a missing blob: %v", err)
	}
	// A required file it can't fetch
	delete(site, "/system/state.bin.zst")
	if _, err := Fetch(srv.URL + "/"); err == nil || !strings.Contains(err.Error(), "state.bin.zst") {
		t.Errorf("a missing state: %v", err)
	}
	// Not a site at all
	delete(site, "/run.json")
	if _, err := Fetch(srv.URL + "/"); err == nil || !strings.Contains(err.Error(), "doesn't look like a snowglobe site") {
		t.Errorf("no run.json: %v", err)
	}
}

func TestMirrorRefusesBlobNamesWithAPath(t *testing.T) {
	cacheHome(t)
	escape := `{"version":3,"size":3,"fsroot":[["a",3,0,33188,0,0,"../../../../escaped.bin.zst"]]}`
	srv := newSiteServer(t, map[string]string{
		"/run.json": "{}", "/index.html": "page", "/system/filesystem.json": escape,
		"/system/state.bin.zst": "state", "/escaped.bin.zst": "out", "/system/escaped.bin.zst": "out",
	})
	dir, err := Fetch(srv.URL + "/")
	if err == nil || !strings.Contains(err.Error(), "isn't a blob name") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "..", "escaped.bin.zst")); err == nil {
		t.Error("a blob was written outside the cache directory")
	}
}

func TestUnpackWarmRefusesBadPacks(t *testing.T) {
	short := []byte{1, 0}
	var bigIndex bytes.Buffer
	binary.Write(&bigIndex, binary.LittleEndian, uint32(100))
	withIndex := func(index string, tail string) []byte {
		var b bytes.Buffer
		binary.Write(&b, binary.LittleEndian, uint32(len(index)))
		b.WriteString(index + tail)
		return b.Bytes()
	}
	for name, pack := range map[string][]byte{
		"short":              short,
		"index past the end": bigIndex.Bytes(),
		"index not json":     withIndex("nope", ""),
		"entry too short":    withIndex(`[["a.bin.zst"]]`, "AAA"),
		"negative length":    withIndex(`[["a.bin.zst",1,-2]]`, "AAA"),
		"blob past the end":  withIndex(`[["a.bin.zst",1,9]]`, "AAA"),
		"huge length":        withIndex(`[["a.bin.zst",1,1e300]]`, "AAA"),
		"no name":            withIndex(`[["",1,3]]`, "AAA"),
		"a path":             warmPack([]string{"../a.bin.zst"}, []string{"AAA"}),
		"a parent":           warmPack([]string{".."}, []string{"AAA"}),
	} {
		dir := filepath.Join(t.TempDir(), "blobs")
		if n, err := unpackWarm(pack, dir); err == nil {
			t.Errorf("%s: unpacked %d", name, n)
		}
		if _, err := os.Stat(filepath.Join(dir, "..", "a.bin.zst")); err == nil {
			t.Errorf("%s: wrote outside its directory", name)
		}
	}
}

func TestSize(t *testing.T) {
	if got := size(-1); got != "size unknown" {
		t.Error(got)
	}
	if got := size(3 << 20); got != "3.0 MB" {
		t.Error(got)
	}
}
