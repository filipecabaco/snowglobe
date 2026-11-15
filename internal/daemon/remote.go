package daemon

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/remote"
)

// Policy is what a request from another host may make the daemon do: one that came in on the TCP
// API (--listen), bearing the token. The token says who may use the daemon, not what of this host
// they may see: a remote request names no path on it but the sites it uploaded and the roots the
// daemon was given, and no URL on its own or private network, unless the daemon says so.
// Requests on the Unix socket are this host's user's, and may do anything.
type Policy struct {
	// Directories of this host a remote request may name a site or a build's source in, besides
	// the sites it uploaded (--site-root)
	SiteRoots []string
	// Private lets a remote request give its templates loopback and private egress, and name URLs
	// on private addresses (--remote-allow-private)
	Private bool
}

// OriginHeader on a request to the Unix socket says it is made for a remote one: the fleet
// routes apply a fleet through the daemon's own socket, as a client would, and say whose it is.
// (A local client gains nothing by sending it: it can only take rights away.)
const OriginHeader = "X-Snowglobe-Origin"

type remoteKey struct{}

// markRemote is r, known to come from another host.
func markRemote(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), remoteKey{}, true))
}

// IsRemote says whether r came from another host, or is made for one.
func IsRemote(r *http.Request) bool {
	if v, _ := r.Context().Value(remoteKey{}).(bool); v {
		return true
	}
	return r.Header.Get(OriginHeader) == "remote"
}

// Path checks a path of this host a remote request names: one under uploads (the sites uploaded
// to the daemon) or a site root, symlinks resolved. The error doesn't say whether it exists.
func (p Policy) Path(path, uploads string) error {
	refused := errStatus(403, "%s: a request from another host may name a site it uploaded (template add uploads a local one), a URL, or a path under one of the daemon's --site-root directories", path)
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return refused
	}
	for _, root := range append([]string{uploads}, p.SiteRoots...) {
		r, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if real == r || strings.HasPrefix(real, r+string(os.PathSeparator)) {
			return nil
		}
	}
	return refused
}

// maxUpload bounds an uploaded site, packed
const maxUpload = 16 << 30

// uploads is where uploaded sites are kept, each in a directory of its own.
func (s *Server) uploads() string {
	return filepath.Join(s.o.Dir, "sites")
}

// serveUpload takes a packed site (a tar, ?format=gz or zst for a compressed one) and keeps it
// for templates: it answers {"site": DIR}, the path to name in AddTemplate.Site. How a client
// on another host uses a site it has: it can't name a path of its own (template add uploads one).
func (s *Server) serveUpload(w http.ResponseWriter, r *http.Request) {
	name := "site.tar"
	switch f := r.URL.Query().Get("format"); f {
	case "", "tar":
	case "gz", "zst":
		name += "." + f
	default:
		reply(w, nil, errStatus(400, "format %q: tar, gz or zst", f))
		return
	}
	if err := os.MkdirAll(s.uploads(), 0o700); err != nil {
		reply(w, nil, err)
		return
	}
	dir, err := os.MkdirTemp(s.uploads(), "up-")
	if err != nil {
		reply(w, nil, err)
		return
	}
	// Readable as a site is: the fork server's sandbox reads it
	os.Chmod(dir, 0o755)
	body := http.MaxBytesReader(w, r.Body, maxUpload)
	if err := remote.Extract(body, name, dir); err != nil {
		os.RemoveAll(dir)
		reply(w, nil, errStatus(400, "upload: %v", err))
		return
	}
	s.note("site.uploaded", "site "+filepath.Base(dir), "uploaded")
	reply(w, map[string]string{"site": dir}, nil)
}

// sweepUploads removes the uploaded sites no template or snapshot is made of (caller holds s.mu).
func (s *Server) sweepUploads() {
	used := map[string]bool{}
	for _, t := range s.st.Templates {
		used[t.Site] = true
	}
	for _, sn := range s.st.Snapshots {
		used[sn.Site] = true
	}
	dirs, _ := filepath.Glob(filepath.Join(s.uploads(), "up-*"))
	for _, d := range dirs {
		// (One uploaded a moment ago is on its way to a template)
		if fi, err := os.Stat(d); used[d] || err != nil || time.Since(fi.ModTime()) < time.Hour {
			continue
		}
		os.RemoveAll(d)
	}
}
