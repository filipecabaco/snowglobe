// Package remote fetches a snowglobe site from a URL into a local cache, so `snowglobe run` can
// take a deployed site (any static host or CDN) or a tarball made by `snowglobe pack` as easily
// as a directory. Everything is fetched before the run starts: the sandbox itself stays offline.
package remote

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/filipecabaco/snowglobe/internal/rootfs"
	"github.com/klauspost/compress/zstd"
)

// IsURL reports whether a run source is remote.
func IsURL(source string) bool {
	return strings.HasPrefix(source, "https://") || strings.HasPrefix(source, "http://")
}

// IsTarball reports whether a source (a URL or a path) names a packed site.
func IsTarball(source string) bool {
	p := sourcePath(source)
	for _, ext := range []string{".tar.gz", ".tgz", ".tar.zst", ".tar"} {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}

// sourcePath is a source's file name part: a URL's path, without its query, or the path itself.
func sourcePath(source string) string {
	if u, err := url.Parse(source); err == nil && IsURL(source) {
		return u.Path
	}
	return source
}

// Fetch makes the site at source available locally and returns its directory: a tarball URL is
// downloaded and unpacked, a site URL is mirrored file by file. Both are cached and revalidated.
func Fetch(source string) (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(source))
	dir := filepath.Join(base, "snowglobe", "sites", hex.EncodeToString(sum[:8]))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if IsTarball(source) {
		return fetchTarball(source, dir)
	}
	return dir, mirror(source, dir)
}

// Unpack extracts a local tarball into the cache and returns its directory.
func Unpack(file string) (string, error) {
	abs, err := filepath.Abs(file)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", abs, info.Size(), info.ModTime().UnixNano())))
	dir := filepath.Join(base, "snowglobe", "sites", hex.EncodeToString(sum[:8]))
	if v, ok := current(dir); ok {
		return v, nil
	}
	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return unpackInto(f, abs, dir)
}

// ---- builds of a tarball, side by side ----
//
// A tarball's cache entry holds each build unpacked in a directory of its own, v-<id>, and a
// symlink, current, to the newest. A process uses the build it got for as long as it runs,
// holding a shared lock (flock) on v-<id>.lock: a refresh by another process makes a new build
// current and removes only the builds it can lock exclusively, the ones nothing holds.

// held are the builds this process uses: their locks, kept until it exits.
var (
	heldMu sync.Mutex
	held   []*os.File
)

// Held are the locks on the builds this process uses, for a process it starts that outlives it
// (a detached snowglobe-vm) to inherit.
func Held() []*os.File {
	heldMu.Lock()
	defer heldMu.Unlock()
	return append([]*os.File(nil), held...)
}

// hold takes a shared lock on the build v for this process; false if it has gone meanwhile.
func hold(v string) bool {
	f, err := os.Open(v + ".lock")
	if err != nil {
		return false
	}
	// Blocks only while a refresh removes it, and then it is gone
	if syscall.Flock(int(f.Fd()), syscall.LOCK_SH) != nil {
		f.Close()
		return false
	}
	if _, err := os.Stat(filepath.Join(v, "run.json")); err != nil {
		f.Close()
		return false
	}
	heldMu.Lock()
	held = append(held, f)
	heldMu.Unlock()
	return true
}

// current is the build of the tarball cached in dir that is current, held for this process.
func current(dir string) (string, bool) {
	for range 3 {
		target, err := os.Readlink(filepath.Join(dir, "current"))
		if err != nil {
			return "", false
		}
		if v := filepath.Join(dir, target); hold(v) {
			return v, true
		}
	}
	return "", false
}

// unpackInto extracts a tarball as a new build in dir, held for this process, and makes it
// current once all of it is out: one cut short must not leave a run.json that makes a part of a
// site look like all of it. Builds nothing holds go.
func unpackInto(r io.Reader, name, dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(dir, ".unpack-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	// Readable as a site is: a container runs it as another user
	if err := os.Chmod(tmp, 0o755); err != nil {
		return "", err
	}
	if err := extract(r, name, tmp); err != nil {
		return "", err
	}
	// Its lock first, held: a refresh at the same time can't take the build once it is there
	id := "v-" + strings.TrimPrefix(filepath.Base(tmp), ".unpack-")
	v := filepath.Join(dir, id)
	if err := os.WriteFile(v+".lock", nil, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, v); err != nil {
		return "", err
	}
	if !hold(v) {
		return "", fmt.Errorf("%s: the build unpacked went", name)
	}
	link := filepath.Join(dir, ".current-"+id)
	if err := os.Symlink(id, link); err != nil {
		return "", err
	}
	if err := os.Rename(link, filepath.Join(dir, "current")); err != nil {
		os.Remove(link)
		return "", err
	}
	removeUnused(dir)
	return v, nil
}

// removeUnused removes the builds in dir that nothing holds, but the current one.
func removeUnused(dir string) {
	now, _ := os.Readlink(filepath.Join(dir, "current"))
	builds, _ := filepath.Glob(filepath.Join(dir, "v-*"))
	for _, v := range builds {
		if strings.HasSuffix(v, ".lock") || filepath.Base(v) == now {
			continue
		}
		f, err := os.OpenFile(v+".lock", os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			continue
		}
		if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
			os.RemoveAll(v)
			os.Remove(v + ".lock")
		}
		f.Close()
	}
}

// ---- a tarball ----

func fetchTarball(source, dir string) (string, error) {
	// Revalidate with whichever validator the server gave: CDNs send an ETag, plain file servers
	// often only Last-Modified
	etagFile, modifiedFile := filepath.Join(dir, ".etag"), filepath.Join(dir, ".last-modified")
	req, err := http.NewRequest("GET", source, nil)
	if err != nil {
		return "", err
	}
	cached, ok := current(dir)
	if ok {
		if etag, err := os.ReadFile(etagFile); err == nil {
			req.Header.Set("If-None-Match", string(etag))
		}
		if modified, err := os.ReadFile(modifiedFile); err == nil {
			req.Header.Set("If-Modified-Since", string(modified))
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified && ok {
		fmt.Fprintf(os.Stderr, "using the cached copy of %s\n", source)
		return cached, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", source, resp.Status)
	}
	fmt.Fprintf(os.Stderr, "downloading %s (%s)\n", source, size(resp.ContentLength))
	v, err := unpackInto(resp.Body, source, dir)
	if err != nil {
		return "", err
	}
	// This build's validators, not an earlier one's
	for file, value := range map[string]string{etagFile: resp.Header.Get("ETag"), modifiedFile: resp.Header.Get("Last-Modified")} {
		if value == "" {
			os.Remove(file)
		} else {
			writeBytes(file, []byte(value))
		}
	}
	return v, nil
}

func extract(r io.Reader, name, dir string) error {
	// A URL's query (?v=2) isn't part of its file name
	switch p := sourcePath(name); {
	case strings.HasSuffix(p, ".gz") || strings.HasSuffix(p, ".tgz"):
		gz, err := gzip.NewReader(r)
		if err != nil {
			return err
		}
		defer gz.Close()
		r = gz
	case strings.HasSuffix(p, ".zst"):
		zr, err := zstd.NewReader(r)
		if err != nil {
			return err
		}
		defer zr.Close()
		r = zr
	}

	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("reading %s: %w", name, err)
		}
		target := filepath.Join(dir, filepath.FromSlash(path.Clean("/"+h.Name)))
		if !strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator)) {
			continue // never write outside the cache directory
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeFile(target, tr); err != nil {
				return err
			}
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "run.json")); err != nil {
		return fmt.Errorf("%s isn't a packed snowglobe site (no run.json)", name)
	}
	return nil
}

// ---- a deployed site ----

var baseurlPattern = regexp.MustCompile(`baseurl:\s*"([^"]+)"`)

// The files a run needs besides run.json and the guest's blobs; the optional ones exist only for
// some sites
var siteFiles = []struct {
	path     string
	optional bool
}{
	{"index.html", false}, {"system/filesystem.json", false}, {"system/state.bin.zst", false}, {"system/console.bin", true},
	// The site's CA: with a network, the guest's HTTPS ends in the machine with it
	{"system/tls.json", true},
}

func mirror(source, dir string) error {
	if !strings.HasSuffix(source, "/") {
		source += "/"
	}
	site, err := url.Parse(source)
	if err != nil {
		return err
	}

	// run.json says which build this is: when it matches the cache, nothing else is fetched
	fresh, err := get(site.ResolveReference(&url.URL{Path: "run.json"}).String(), maxRunJSON)
	if err != nil {
		return fmt.Errorf("%s doesn't look like a snowglobe site: %w", source, err)
	}
	if cached, err := os.ReadFile(filepath.Join(dir, "run.json")); err == nil && string(cached) == string(fresh) {
		if _, err := os.Stat(filepath.Join(dir, ".complete")); err == nil {
			fmt.Fprintf(os.Stderr, "using the cached copy of %s\n", source)
			return nil
		}
	}
	os.Remove(filepath.Join(dir, ".complete"))
	fmt.Fprintf(os.Stderr, "fetching %s\n", source)

	// The run.json just fetched, not another copy that may be of a newer build
	if err := writeBytes(filepath.Join(dir, "run.json"), fresh); err != nil {
		return err
	}
	for _, f := range siteFiles {
		target := filepath.Join(dir, filepath.FromSlash(f.path))
		if err := fetchTo(site.ResolveReference(&url.URL{Path: f.path}).String(), target); err != nil {
			if f.optional && errors.Is(err, errNotThere) {
				// Not in this build: an earlier build's copy must not stay
				os.Remove(target)
				continue
			}
			return err
		}
	}

	// Blobs live where the page says: the site's own system/filesystem/, or a pooled store
	page, _ := os.ReadFile(filepath.Join(dir, "index.html"))
	blobBase := "system/filesystem/"
	if m := baseurlPattern.FindSubmatch(page); m != nil {
		blobBase = string(m[1])
	}
	// Relative to the site, or elsewhere altogether (the live site serves blobs from GitHub)
	ref, err := url.Parse(blobBase)
	if err != nil {
		return fmt.Errorf("blob store %q: %w", blobBase, err)
	}
	blobURL := site.ResolveReference(ref)
	blobDir := filepath.Join(dir, "system", "filesystem")

	names, err := BlobNames(filepath.Join(dir, "system", "filesystem.json"))
	if err != nil {
		return err
	}
	var missing []string
	for _, name := range names {
		if _, err := os.Stat(filepath.Join(blobDir, name)); err != nil {
			missing = append(missing, name)
		}
	}

	// The warm pack carries the files a run reads first in one request
	if len(missing) > 0 {
		if pack, err := get(site.ResolveReference(&url.URL{Path: "system/warm.pack"}).String(), maxWarmPack); err == nil {
			unpacked, err := unpackWarm(pack, blobDir)
			if err == nil {
				fmt.Fprintf(os.Stderr, "  %d files from warm.pack\n", unpacked)
				missing = missing[:0]
				for _, name := range names {
					if _, err := os.Stat(filepath.Join(blobDir, name)); err != nil {
						missing = append(missing, name)
					}
				}
			}
		}
	}

	if err := fetchAll(blobURL, blobDir, missing); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ".complete"), nil, 0o644)
}

func fetchAll(base *url.URL, dir string, names []string) error {
	if len(names) == 0 {
		return nil
	}
	var (
		wg      sync.WaitGroup
		done    atomic.Int64
		errOnce sync.Once
		failure error
	)
	jobs := make(chan string)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for name := range jobs {
				err := fetchTo(base.ResolveReference(&url.URL{Path: name}).String(), filepath.Join(dir, name))
				if err != nil {
					errOnce.Do(func() { failure = err })
				}
				if n := done.Add(1); n%100 == 0 || int(n) == len(names) {
					fmt.Fprintf(os.Stderr, "\r  %d/%d files", n, len(names))
				}
			}
		}()
	}
	for _, name := range names {
		jobs <- name
	}
	close(jobs)
	wg.Wait()
	fmt.Fprintln(os.Stderr)
	return failure
}

// BlobNames lists every blob the filesystem refers to: whole files' and chunks'
func BlobNames(file string) ([]string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	refs, err := rootfs.ListBlobs(data)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(refs))
	for i, r := range refs {
		if !blobName(r.Name) {
			return nil, fmt.Errorf("%s: %q isn't a blob name", file, r.Name)
		}
		names[i] = r.Name
	}
	return names, nil
}

// blobName says whether name is a plain file name in the blob directory: a site from elsewhere
// names the blobs, and a path in a name would write (or read) outside it.
func blobName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\`)
}

// unpackWarm writes the blobs in a warm pack.
func unpackWarm(pack []byte, dir string) (int, error) {
	entries, blobs, err := rootfs.ParseWarmPack(pack)
	if err != nil {
		return 0, err
	}
	for _, e := range entries {
		if !blobName(e.Blob) {
			return 0, fmt.Errorf("bad warm pack entry %q", e.Blob)
		}
	}
	for i, e := range entries {
		if err := writeBytes(filepath.Join(dir, e.Blob), blobs[i]); err != nil {
			return 0, err
		}
	}
	return len(entries), nil
}

// What a site's server may send, at most: it is someone else's, so it can't make this process
// hold or write without end. Generous for real sites (a snapshot of several GiB). Variables for
// the tests.
var (
	maxRunJSON  int64 = 16 << 20
	maxWarmPack int64 = 2 << 30 // held in memory to unpack
	maxFile     int64 = 16 << 30
)

// errNotThere is an answer other than 200: for an optional file, one the build doesn't have
// (S3 says 403 rather than 404, say).
var errNotThere = errors.New("not there")

// open GETs u, its body read at most limit bytes.
func open(u string, limit int64) (io.ReadCloser, error) {
	resp, err := http.Get(u)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s: %s: %w", u, resp.Status, errNotThere)
	}
	return struct {
		io.Reader
		io.Closer
	}{&capped{r: resp.Body, left: limit, limit: limit, u: u}, resp.Body}, nil
}

// get reads u into memory, at most limit bytes.
func get(u string, limit int64) ([]byte, error) {
	body, err := open(u, limit)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	return io.ReadAll(body)
}

// fetchTo streams u into target, at most maxFile bytes.
func fetchTo(u, target string) error {
	body, err := open(u, maxFile)
	if err != nil {
		return err
	}
	defer body.Close()
	return writeFrom(target, body)
}

// capped fails a read past its limit, rather than stopping short as if that were all.
type capped struct {
	r           io.Reader
	left, limit int64
	u           string
}

func (c *capped) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if c.left -= int64(n); c.left < 0 {
		return 0, fmt.Errorf("%s: more than %d bytes", c.u, c.limit)
	}
	return n, err
}

func writeBytes(target string, data []byte) error {
	return writeFrom(target, bytes.NewReader(data))
}

func writeFrom(target string, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	// A temporary file of its own: another process may be writing the same target
	f, err := os.CreateTemp(filepath.Dir(target), filepath.Base(target)+".part-*")
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(f.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(f.Name(), target)
	}
	if err != nil {
		os.Remove(f.Name())
	}
	return err
}

func writeFile(target string, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func size(n int64) string {
	if n < 0 {
		return "size unknown"
	}
	return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
}
