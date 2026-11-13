package daemon

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// A build context is a directory with a Dockerfile that a client sends the daemon as a tarball
// (POST /v1/contexts), for a build to name (BuildRequest.Context): how a client on another host
// builds a Dockerfile of its own, as a site upload is how it runs a site of its own. Each upload
// is a directory of its own until a build takes it; one no build took goes after an hour.

// contexts is where uploaded build contexts wait for their build.
func (s *Server) contexts() string {
	return filepath.Join(s.o.Dir, "contexts")
}

// How many contexts may wait for a build at once, and the most entries one may have
var (
	maxContexts       = 16
	maxContextEntries = 200_000
)

var contextRE = regexp.MustCompile(`^ctx-[0-9a-f]{6}$`)

// ContextUpload is what POST /v1/contexts answers: the context to name in BuildRequest.Context,
// and what it holds, by content (the build's input, for its cache key).
type ContextUpload struct {
	Context string `json:"context"`
	Digest  string `json:"digest"`
	Bytes   int64  `json:"bytes"`
	Files   int    `json:"files"`
}

// serveContext takes a build context: a tar (?format=gz or zst for a compressed one) of a
// directory with a Dockerfile at its top.
func (s *Server) serveContext(w http.ResponseWriter, r *http.Request) {
	name := "context.tar"
	switch f := r.URL.Query().Get("format"); f {
	case "", "tar":
	case "gz", "zst":
		name += "." + f
	default:
		reply(w, nil, errStatus(400, "format %q: tar, gz or zst", f))
		return
	}
	s.sweepContexts()
	if err := os.MkdirAll(s.contexts(), 0o700); err != nil {
		reply(w, nil, err)
		return
	}
	if waiting, _ := filepath.Glob(filepath.Join(s.contexts(), "ctx-*")); len(waiting) >= maxContexts {
		reply(w, nil, errStatus(429, "%d build contexts are waiting for their builds already: build them, or try again later", len(waiting)))
		return
	}
	var dir string
	for range 8 {
		d := filepath.Join(s.contexts(), randomName("ctx"))
		if err := os.Mkdir(d, 0o700); err == nil {
			dir = d
			break
		}
	}
	if dir == "" {
		reply(w, nil, errors.New("no room for a context"))
		return
	}
	tree := filepath.Join(dir, "tree")
	body := http.MaxBytesReader(w, r.Body, s.o.MaxContext)
	up, err := extractContext(body, name, tree, s.o.MaxContext)
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "digest"), []byte(up.Digest), 0o600)
	}
	if err != nil {
		os.RemoveAll(dir)
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			err = errStatus(413, "the context is more than the daemon takes (--max-context %.0f MB)", float64(s.o.MaxContext)/(1<<20))
		} else if statusOf(err) == 500 {
			err = errStatus(400, "context: %v", err)
		}
		reply(w, nil, err)
		return
	}
	up.Context = filepath.Base(dir)
	s.note("context.uploaded", "context "+up.Context, "%d files, %.1f MB, %s", up.Files, float64(up.Bytes)/(1<<20), up.Digest)
	reply(w, up, nil)
}

// takeContext is the directory of the uploaded context id and its digest, for a build to take.
func (s *Server) takeContext(id string) (tree, digest string, err error) {
	if !contextRE.MatchString(id) {
		return "", "", errStatus(400, "context %q: a context the daemon gave (POST /v1/contexts)", id)
	}
	dir := filepath.Join(s.contexts(), id)
	data, err := os.ReadFile(filepath.Join(dir, "digest"))
	if err != nil {
		return "", "", errStatus(404, "no context %s: upload it again (a context is kept an hour, for one build)", id)
	}
	return filepath.Join(dir, "tree"), string(data), nil
}

// sweepContexts removes the contexts no build took within the hour.
func (s *Server) sweepContexts() {
	dirs, _ := filepath.Glob(filepath.Join(s.contexts(), "ctx-*"))
	for _, d := range dirs {
		if fi, err := os.Stat(d); err == nil && time.Since(fi.ModTime()) > time.Hour {
			os.RemoveAll(d)
		}
	}
}

func (s *Server) contextRoutes(mux Router) {
	mux.HandleFunc("POST /v1/contexts", s.serveContext)
}

// extractContext unpacks a build context (a tar; .gz or .zst by name's suffix) into dir, which it
// makes: regular files with their modes, directories, hard links and symbolic links, as `docker
// build` reads them. Nothing may land, or point, outside dir: a path that leaves it, an absolute
// link, a link whose target leaves it or a path through a link is refused, as is anything else
// (a device, a pipe). Its digest is the sha256 of its entries, sorted by path (each one's path,
// type, mode, link and content), not of the tarball: the same tree packed again is the same
// context. At most max bytes of content.
func extractContext(r io.Reader, name, dir string, max int64) (*ContextUpload, error) {
	switch {
	case strings.HasSuffix(name, ".gz"):
		gz, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		r = gz
	case strings.HasSuffix(name, ".zst"):
		zr, err := zstd.NewReader(r)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r = zr
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		return nil, err
	}
	up := &ContextUpload{}
	var lines []string
	modes := map[string]os.FileMode{}
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if up.Files++; up.Files > maxContextEntries {
			return nil, errStatus(413, "more than %d entries in the context", maxContextEntries)
		}
		rel, err := contextPath(h.Name)
		if err != nil {
			return nil, err
		}
		if rel == "." {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if err := noLinkOnTheWay(dir, rel); err != nil {
			return nil, err
		}
		mode := os.FileMode(h.Mode).Perm()
		line := ""
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return nil, err
			}
			modes[target] = mode
			line = fmt.Sprintf("d %o", mode)
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode|0o400)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
			hash := sha256.New()
			n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(tr, max-up.Bytes+1))
			f.Close()
			if err != nil {
				return nil, err
			}
			if up.Bytes += n; up.Bytes > max {
				return nil, &http.MaxBytesError{Limit: max}
			}
			line = fmt.Sprintf("f %o %s", mode, hex.EncodeToString(hash.Sum(nil)))
		case tar.TypeSymlink:
			if to := path.Clean(path.Join(path.Dir(rel), h.Linkname)); path.IsAbs(h.Linkname) || to == ".." || strings.HasPrefix(to, "../") {
				return nil, errStatus(400, "%s: a link to %s, outside the context", rel, h.Linkname)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, err
			}
			if err := os.Symlink(h.Linkname, target); err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
			line = "l " + h.Linkname
		case tar.TypeLink:
			to, err := contextPath(h.Linkname)
			if err != nil || to == "." {
				return nil, errStatus(400, "%s: a hard link to %s, outside the context", rel, h.Linkname)
			}
			if err := noLinkOnTheWay(dir, to); err != nil {
				return nil, err
			}
			src := filepath.Join(dir, filepath.FromSlash(to))
			if fi, err := os.Lstat(src); err != nil || !fi.Mode().IsRegular() {
				return nil, errStatus(400, "%s: a hard link to %s, which isn't a file before it", rel, h.Linkname)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, err
			}
			if err := os.Link(src, target); err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
			line = "h " + to
		case tar.TypeXGlobalHeader:
			continue
		default:
			return nil, errStatus(400, "%s: a context holds files, directories and links only", rel)
		}
		lines = append(lines, rel+"\x00"+line)
	}
	// Directories' modes last (one without write permission would have refused what is in it),
	// and always the daemon's to read and empty
	for d, m := range modes {
		os.Chmod(d, m|0o700)
	}
	if fi, err := os.Lstat(filepath.Join(dir, "Dockerfile")); err != nil || !fi.Mode().IsRegular() {
		return nil, errStatus(400, "no Dockerfile at the top of the context")
	}
	sort.Strings(lines)
	up.Digest = sha256Of([]byte(strings.Join(lines, "\n")))
	return up, nil
}

// contextPath is a tar entry's path inside the context ("." for its top), or an error if it
// leaves it.
func contextPath(name string) (string, error) {
	if strings.HasPrefix(name, "/") {
		return "", errStatus(400, "%s: an absolute path, outside the context", name)
	}
	p := path.Clean(name)
	if p == ".." || strings.HasPrefix(p, "../") {
		return "", errStatus(400, "%s: a path outside the context", name)
	}
	return p, nil
}

// noLinkOnTheWay refuses a path under dir that goes through a symbolic link: written to, it would
// land wherever the link points.
func noLinkOnTheWay(dir, rel string) error {
	cur := dir
	parts := strings.Split(rel, "/")
	for _, p := range parts[:len(parts)-1] {
		cur = filepath.Join(cur, p)
		fi, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return errStatus(400, "%s: a path through a link", rel)
		}
	}
	// Nor over one already there
	if fi, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(rel))); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errStatus(400, "%s: a path over a link", rel)
	}
	return nil
}
