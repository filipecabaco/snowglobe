package daemon

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/filipecabaco/snowglobe/internal/netguard"
	"github.com/filipecabaco/snowglobe/internal/oci"
	"github.com/filipecabaco/snowglobe/internal/pack"
)

// Artifact is a built site packed into one file (snowglobe pack's), for a static host or CDN:
// unpacked at any path, it is the site.
type Artifact struct {
	// The .tar.zst: its size and sha256 (hex)
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	// The .tar.gz, made the first time it is asked for
	GzBytes  int64  `json:"gz_bytes,omitempty"`
	GzSHA256 string `json:"gz_sha256,omitempty"`
}

const (
	artifactFile   = "site.tar.zst"
	artifactGzFile = "site.tar.gz"
	// What a build context and an artifact may be at most, unless the daemon says otherwise
	defaultMaxContext  = 1 << 30
	defaultMaxArtifact = 8 << 30
)

func sha256Of(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// cacheKey is what an artifact build's artifact is kept by: what it is built of, by content, and
// everything that makes its site another (the options it is built with, the snowglobe building
// it). The build's name isn't: it names the build, not what it makes.
func (s *Server) cacheKey(b *Build) string {
	return sha256Of(fmt.Appendf(nil, "snowglobe %s\nkind %s\ninput %s\nkernel %s\ncpus %d\nmemory %d\nnetwork %s\nbuilder %s\n",
		s.o.Version, b.Kind, b.Input, b.Kernel, b.CPUs, b.Memory, b.Network, b.Builder))
}

// imageDigest is the digest an image reference names now: asked of its registry (as the native
// builder pulls it; public images), else of Docker (which knows the registries it is logged in
// to). For a request from another host, the registry must be on a public address.
func (s *Server) imageDigest(ref string, remote bool) (string, error) {
	if s.o.resolveImage != nil {
		return s.o.resolveImage(ref, remote)
	}
	c := &http.Client{Timeout: 30 * time.Second}
	if remote && !s.o.Remote.Private {
		c = netguard.Client(30 * time.Second)
	}
	d, err := oci.Digest(ref, c)
	if err == nil || !s.dockerThere() {
		return d, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	out, derr := exec.CommandContext(ctx, "docker", "buildx", "imagetools", "inspect", "--format", "{{.Manifest.Digest}}", ref).Output()
	if d := strings.TrimSpace(string(out)); derr == nil && strings.HasPrefix(d, "sha256:") {
		return d, nil
	}
	return "", err
}

// lookupIP resolves a registry's host; a variable for tests.
var lookupIP = net.LookupIP

// publicRegistry refuses an image reference (from another host) whose registry is on this host's
// loopback or private network: pulling it would reach what the remote policy keeps from them.
func publicRegistry(ref string) error {
	r, err := oci.ParseRef(ref)
	if err != nil {
		return errStatus(400, "%v", err)
	}
	host := r.Registry
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	refused := errStatus(403, "%s: a request from another host may build images of registries on public addresses only (the daemon's --remote-allow-private lets it)", ref)
	ips, err := lookupIP(host)
	if err != nil || len(ips) == 0 {
		return refused
	}
	for _, ip := range ips {
		a, ok := netip.AddrFromSlice(ip)
		if !ok || !netguard.Public(a.Unmap()) {
			return refused
		}
	}
	return nil
}

// packArtifact packs a build's site into its artifact, refused past the largest the daemon keeps.
func (s *Server) packArtifact(b *Build) (*Artifact, error) {
	out := filepath.Join(b.dir, artifactFile)
	n, err := pack.Run(b.Site, out)
	if err != nil {
		return nil, err
	}
	if n > s.o.MaxArtifact {
		os.Remove(out)
		return nil, fmt.Errorf("the packed site is %.1f MB, more than the daemon keeps (--max-artifact %.1f MB)", float64(n)/(1<<20), float64(s.o.MaxArtifact)/(1<<20))
	}
	sum, err := fileSHA256(out)
	if err != nil {
		return nil, err
	}
	return &Artifact{Bytes: n, SHA256: sum}, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// cached is what the artifacts kept take on disk together, and how many there are (caller holds
// builds.mu).
func (bs *builds) cached() (bytes int64, n int) {
	for _, b := range bs.all {
		if b.Artifact != nil {
			bytes += b.Artifact.Bytes + b.Artifact.GzBytes
			n++
		}
	}
	return
}

// evictArtifacts lets go of the artifacts asked for longest ago while they take more than
// --cache-size together. The one used last stays, whatever its size: it was just asked for.
func (s *Server) evictArtifacts() {
	if s.o.CacheSize <= 0 {
		return
	}
	s.builds.mu.Lock()
	total, _ := s.builds.cached()
	var kept []*Build
	for _, b := range s.builds.all {
		if b.Artifact != nil && b.finished() {
			kept = append(kept, b)
		}
	}
	used := func(b *Build) time.Time {
		if b.Used != nil {
			return *b.Used
		}
		return b.Created
	}
	sort.Slice(kept, func(i, j int) bool { return used(kept[i]).Before(used(kept[j])) })
	var gone []*Build
	for i := 0; total > s.o.CacheSize && i < len(kept)-1; i++ {
		b := kept[i]
		total -= b.Artifact.Bytes + b.Artifact.GzBytes
		delete(s.builds.all, b.ID)
		if s.builds.byKey[b.Key] == b.ID {
			delete(s.builds.byKey, b.Key)
		}
		gone = append(gone, b)
	}
	s.builds.mu.Unlock()
	for _, b := range gone {
		// (A download under way reads on: the file goes once it is closed)
		os.RemoveAll(b.dir)
		s.note("build.evicted", "build "+b.ID, "%s: its artifact let go of, the cache being full (--cache-size)", b.Name)
	}
}

// How long a download may go without the client reading any of it, and how fast it must read at
// least, on average: a slow reader can't hold a connection (and a file) open for ever
var (
	downloadIdle = time.Minute
	downloadRate = int64(64 << 10) // bytes a second
)

// serveArtifact answers /v1/builds/{id}/artifact: the packed site, .tar.zst (?format=gz:
// .tar.gz), immutable, its sha256 in ETag and Digest. Ranges are served, to resume a download.
func (s *Server) serveArtifact(w http.ResponseWriter, r *http.Request) {
	b, err := s.Build(r.PathValue("id"))
	if err != nil {
		reply(w, nil, err)
		return
	}
	switch {
	case !b.finished():
		reply(w, nil, errStatus(409, "build %s is %s: its artifact is there once it is done", b.ID, b.Status))
		return
	case b.Artifact == nil:
		reply(w, nil, errStatus(404, "build %s has no artifact (one is made by a build that asks for it, and by every build of a provider)", b.ID))
		return
	}
	file, sum, ctype, ext := filepath.Join(b.dir, artifactFile), b.Artifact.SHA256, "application/zstd", ".tar.zst"
	switch f := r.URL.Query().Get("format"); f {
	case "", "zst":
	case "gz":
		art, err := s.gzArtifact(b.ID)
		if err != nil {
			reply(w, nil, err)
			return
		}
		file, sum, ctype, ext = filepath.Join(b.dir, artifactGzFile), art.GzSHA256, "application/gzip", ".tar.gz"
	default:
		reply(w, nil, errStatus(400, "format %q: zst or gz", f))
		return
	}
	f, err := os.Open(file)
	if err != nil {
		reply(w, nil, errStatus(404, "build %s: its artifact is gone (the cache let go of it)", b.ID))
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		reply(w, nil, err)
		return
	}
	now := time.Now()
	s.builds.mu.Lock()
	if cur := s.builds.all[b.ID]; cur != nil {
		cur.Used = &now
	}
	s.builds.mu.Unlock()
	raw, _ := hex.DecodeString(sum)
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", b.Name+ext))
	h.Set("ETag", strconv.Quote(sum))
	h.Set("Digest", "sha-256="+base64.StdEncoding.EncodeToString(raw))
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	// The whole of it in its time, and none of it held up by a client that stopped reading
	rc := http.NewResponseController(w)
	whole := now.Add(downloadIdle + time.Duration(fi.Size()/downloadRate)*time.Second)
	http.ServeContent(paced{w, rc, whole}, r, "", fi.ModTime(), f)
}

// paced is a response whose each write must go within downloadIdle, and all of them by end.
type paced struct {
	http.ResponseWriter
	rc  *http.ResponseController
	end time.Time
}

func (p paced) Write(b []byte) (int, error) {
	d := time.Now().Add(downloadIdle)
	if d.After(p.end) {
		d = p.end
	}
	p.rc.SetWriteDeadline(d)
	return p.ResponseWriter.Write(b)
}

// gzArtifact makes a build's .tar.gz of its .tar.zst (the same tar), once, and keeps it.
func (s *Server) gzArtifact(id string) (*Artifact, error) {
	s.builds.gz.Lock()
	defer s.builds.gz.Unlock()
	b, err := s.Build(id)
	if err != nil {
		return nil, err
	}
	if b.Artifact.GzSHA256 != "" {
		return b.Artifact, nil
	}
	in, err := os.Open(filepath.Join(b.dir, artifactFile))
	if err != nil {
		return nil, errStatus(404, "build %s: its artifact is gone (the cache let go of it)", id)
	}
	defer in.Close()
	zr, err := zstd.NewReader(in)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	out := filepath.Join(b.dir, artifactGzFile)
	tmp, err := os.CreateTemp(b.dir, "gz-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	gw := gzip.NewWriter(io.MultiWriter(tmp, h))
	_, err = io.Copy(gw, zr)
	if err == nil {
		err = gw.Close()
	}
	if err == nil {
		err = tmp.Close()
	} else {
		tmp.Close()
	}
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(tmp.Name())
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tmp.Name(), out); err != nil {
		return nil, err
	}
	s.builds.mu.Lock()
	cur := s.builds.all[id]
	if cur == nil || cur.Artifact == nil {
		s.builds.mu.Unlock()
		return nil, errStatus(404, "build %s: its artifact is gone (the cache let go of it)", id)
	}
	cur.Artifact.GzBytes, cur.Artifact.GzSHA256 = fi.Size(), hex.EncodeToString(h.Sum(nil))
	s.builds.write(cur)
	art := *cur.Artifact
	s.builds.mu.Unlock()
	s.evictArtifacts()
	return &art, nil
}
