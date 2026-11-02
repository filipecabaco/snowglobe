// Package oci reads container images without Docker: from a registry (the distribution API, with
// anonymous bearer tokens) or from an archive (`docker save`, or an OCI layout), and flattens their
// layers into one filesystem tar, as `docker export` of a container would be.
package oci

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/klauspost/compress/zstd"

	"github.com/filipecabaco/snowglobe/internal/docker"
)

// Image is an image's configuration and its layers, oldest first.
type Image struct {
	Config docker.Image
	Layers []Layer
}

// Layer opens a layer as an uncompressed tar.
type Layer func() (io.ReadCloser, error)

// Ref is an image reference: registry, repository and tag or digest.
type Ref struct {
	Registry, Repository, Reference string
}

// ParseRef reads "alpine", "alpine:3.24", "ghcr.io/o/r:tag" or "...@sha256:...", Docker Hub's
// defaults included.
func ParseRef(s string) (Ref, error) {
	r := Ref{Registry: "registry-1.docker.io", Reference: "latest"}
	rest := s
	if i := strings.Index(rest, "/"); i > 0 {
		host := rest[:i]
		if strings.ContainsAny(host, ".:") || host == "localhost" {
			r.Registry = host
			if host == "docker.io" || host == "index.docker.io" {
				r.Registry = "registry-1.docker.io"
			}
			rest = rest[i+1:]
		}
	}
	if i := strings.Index(rest, "@"); i >= 0 {
		r.Reference = rest[i+1:]
		rest = rest[:i]
	} else if i := strings.LastIndex(rest, ":"); i >= 0 {
		r.Reference = rest[i+1:]
		rest = rest[:i]
	}
	if rest == "" {
		return Ref{}, fmt.Errorf("%q: not an image reference", s)
	}
	if r.Registry == "registry-1.docker.io" && !strings.Contains(rest, "/") {
		rest = "library/" + rest
	}
	r.Repository = rest
	return r, nil
}

const accept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, " +
	"application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

type descriptor struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
	Platform  *struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Variant      string `json:"variant"`
	} `json:"platform"`
}

type manifest struct {
	MediaType string       `json:"mediaType"`
	Manifests []descriptor `json:"manifests"`
	Config    descriptor   `json:"config"`
	Layers    []descriptor `json:"layers"`
}

// client talks to one registry, with the token it was given for a repository.
type client struct {
	http  *http.Client
	base  string
	token string
}

// Pull reads the linux/arm64 image at ref from its registry.
func Pull(ref string) (*Image, error) {
	r, err := ParseRef(ref)
	if err != nil {
		return nil, err
	}
	return (&client{http: http.DefaultClient, base: "https://" + r.Registry + "/v2/" + r.Repository}).pull(ref, r.Reference)
}

// pull reads the linux/arm64 image at reference (a tag or digest) from c's repository; ref names
// it in errors.
func (c *client) pull(ref, reference string) (*Image, error) {
	m, err := c.manifest(reference)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", ref, err)
	}
	if len(m.Manifests) > 0 {
		var pick *descriptor
		for i, d := range m.Manifests {
			if d.Platform != nil && d.Platform.OS == "linux" && d.Platform.Architecture == "arm64" {
				pick = &m.Manifests[i]
				break
			}
		}
		if pick == nil {
			return nil, fmt.Errorf("%s has no linux/arm64 image", ref)
		}
		if m, err = c.manifest(pick.Digest); err != nil {
			return nil, fmt.Errorf("%s: %w", ref, err)
		}
	}
	img := &Image{}
	cfg, err := c.blobBytes(m.Config)
	if err != nil {
		return nil, fmt.Errorf("%s: config: %w", ref, err)
	}
	if err := json.Unmarshal(cfg, &img.Config); err != nil {
		return nil, fmt.Errorf("%s: config: %w", ref, err)
	}
	for _, l := range m.Layers {
		l := l
		img.Layers = append(img.Layers, func() (io.ReadCloser, error) {
			body, err := c.blob(l)
			if err != nil {
				return nil, err
			}
			return decompress(l.MediaType, body)
		})
	}
	return img, nil
}

// get asks the registry, fetching an anonymous token the first time it asks for one.
func (c *client) get(u, accept string) (*http.Response, error) {
	for try := 0; try < 2; try++ {
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			return nil, err
		}
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		if c.token != "" {
			req.Header.Set("Authorization", "Bearer "+c.token)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && c.token == "" {
			challenge := resp.Header.Get("WWW-Authenticate")
			resp.Body.Close()
			if c.token, err = c.authenticate(challenge); err != nil {
				return nil, err
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("GET %s: %s", u, resp.Status)
		}
		return resp, nil
	}
	return nil, fmt.Errorf("GET %s: unauthorized", u)
}

// authenticate answers a Bearer challenge with an anonymous token (public images).
func (c *client) authenticate(challenge string) (string, error) {
	if !strings.HasPrefix(challenge, "Bearer ") {
		return "", fmt.Errorf("registry asks for %q, which isn't supported (public images only)", challenge)
	}
	params := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(challenge, "Bearer "), ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(part), "="); ok {
			params[k] = strings.Trim(v, `"`)
		}
	}
	u, err := url.Parse(params["realm"])
	if err != nil || params["realm"] == "" {
		return "", fmt.Errorf("bad auth challenge %q", challenge)
	}
	q := u.Query()
	for _, k := range []string{"service", "scope"} {
		if params[k] != "" {
			q.Set(k, params[k])
		}
	}
	u.RawQuery = q.Encode()
	resp, err := c.http.Get(u.String())
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token from %s: %s", u.Host, resp.Status)
	}
	var tok struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return "", err
	}
	if tok.Token != "" {
		return tok.Token, nil
	}
	return tok.AccessToken, nil
}

func (c *client) manifest(reference string) (*manifest, error) {
	resp, err := c.get(c.base+"/manifests/"+reference, accept)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var m manifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

// blob streams a blob, checking its digest when it has been read to the end.
func (c *client) blob(d descriptor) (io.ReadCloser, error) {
	resp, err := c.get(c.base+"/blobs/"+d.Digest, "")
	if err != nil {
		return nil, err
	}
	return verified(resp.Body, d.Digest)
}

func (c *client) blobBytes(d descriptor) ([]byte, error) {
	r, err := c.blob(d)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, 64<<20))
}

// verified checks, at EOF, that what was read hashes to digest (sha256 only).
func verified(r io.ReadCloser, digest string) (io.ReadCloser, error) {
	want, ok := strings.CutPrefix(digest, "sha256:")
	if !ok {
		r.Close()
		return nil, fmt.Errorf("digest %s: only sha256 is supported", digest)
	}
	return &verifier{r: r, h: sha256.New(), want: want}, nil
}

type verifier struct {
	r    io.ReadCloser
	h    hash.Hash
	want string
}

func (v *verifier) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	v.h.Write(p[:n])
	if err == io.EOF && hex.EncodeToString(v.h.Sum(nil)) != v.want {
		return n, fmt.Errorf("blob sha256:%s: content doesn't match its digest", v.want)
	}
	return n, err
}

func (v *verifier) Close() error { return v.r.Close() }

// decompress opens a layer blob as a tar, by its media type.
func decompress(mediaType string, r io.ReadCloser) (io.ReadCloser, error) {
	switch {
	case strings.HasSuffix(mediaType, "+zstd") || strings.HasSuffix(mediaType, ".zstd"):
		d, err := zstd.NewReader(r)
		if err != nil {
			r.Close()
			return nil, err
		}
		return closers{d.IOReadCloser(), r}, nil
	case strings.HasSuffix(mediaType, "+gzip") || strings.HasSuffix(mediaType, ".gzip") || strings.HasSuffix(mediaType, "tar.gzip") || mediaType == "":
		g, err := gzip.NewReader(r)
		if err != nil {
			r.Close()
			return nil, err
		}
		return closers{g, r}, nil
	default:
		return r, nil // an uncompressed tar
	}
}

type closers struct {
	io.ReadCloser
	under io.Closer
}

func (c closers) Close() error {
	c.ReadCloser.Close()
	return c.under.Close()
}

// FromArchive reads an image archive: `docker save` (manifest.json) or an OCI layout (index.json),
// as a tar file. It is unpacked into dir, which the layers read from.
func FromArchive(archive, dir string) (*Image, error) {
	f, err := os.Open(archive)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var r io.Reader = f
	if strings.HasSuffix(archive, ".gz") || strings.HasSuffix(archive, ".tgz") {
		g, err := gzip.NewReader(f)
		if err != nil {
			return nil, err
		}
		r = g
	}
	return FromTar(r, archive, dir)
}

// FromTar reads an image archive as a tar stream (archive names it in errors), e.g. `docker
// save`'s output: unpacked into dir, which the layers read from.
func FromTar(r io.Reader, archive, dir string) (*Image, error) {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		name := path.Clean("/" + h.Name)[1:]
		if name == "" || h.Typeflag != tar.TypeReg {
			continue
		}
		dest := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return nil, err
		}
		out, err := os.Create(dest)
		if err != nil {
			return nil, err
		}
		_, err = io.Copy(out, tr)
		out.Close()
		if err != nil {
			return nil, err
		}
	}
	// The archive names its config and layers: within dir, as it was unpacked, whatever the names say
	file := func(name string) string { return filepath.Join(dir, filepath.FromSlash(path.Clean("/"+name))) }
	read := func(name string) ([]byte, error) { return os.ReadFile(file(name)) }
	open := func(name, mediaType string) Layer {
		return func() (io.ReadCloser, error) {
			f, err := os.Open(file(name))
			if err != nil {
				return nil, err
			}
			return sniff(f, mediaType)
		}
	}
	img := &Image{}
	if data, err := read("manifest.json"); err == nil {
		// docker save
		var saved []struct {
			Config string
			Layers []string
		}
		if err := json.Unmarshal(data, &saved); err != nil || len(saved) == 0 {
			return nil, fmt.Errorf("%s: manifest.json lists no image", archive)
		}
		cfg, err := read(saved[0].Config)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(cfg, &img.Config); err != nil {
			return nil, err
		}
		for _, l := range saved[0].Layers {
			img.Layers = append(img.Layers, open(l, ""))
		}
		return img, nil
	}
	data, err := read("index.json")
	if err != nil {
		return nil, fmt.Errorf("%s: neither a docker save archive nor an OCI layout", archive)
	}
	blob := func(d descriptor) string { return "blobs/" + strings.Replace(d.Digest, ":", "/", 1) }
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	for depth := 0; len(m.Manifests) > 0; depth++ {
		// An index of indexes, not one that lists itself
		if depth == 8 {
			return nil, fmt.Errorf("%s: image indexes nested too deep", archive)
		}
		pick := m.Manifests[0]
		for _, d := range m.Manifests {
			if d.Platform != nil && d.Platform.Architecture == "arm64" {
				pick = d
			}
		}
		data, err := read(blob(pick))
		if err != nil {
			return nil, err
		}
		m = manifest{}
		if err := json.Unmarshal(data, &m); err != nil {
			return nil, err
		}
	}
	cfg, err := read(blob(m.Config))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(cfg, &img.Config); err != nil {
		return nil, err
	}
	for _, l := range m.Layers {
		img.Layers = append(img.Layers, open(blob(l), l.MediaType))
	}
	return img, nil
}

// sniff opens a layer file whose compression may not be stated, by its first bytes.
func sniff(f *os.File, mediaType string) (io.ReadCloser, error) {
	if mediaType != "" {
		return decompress(mediaType, f)
	}
	magic := make([]byte, 4)
	n, _ := io.ReadFull(f, magic)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	switch {
	case n >= 2 && magic[0] == 0x1f && magic[1] == 0x8b:
		return decompress("+gzip", f)
	case n == 4 && magic[0] == 0x28 && magic[1] == 0xb5 && magic[2] == 0x2f && magic[3] == 0xfd:
		return decompress("+zstd", f)
	default:
		return f, nil
	}
}

// node is one path of the flattened filesystem.
type node struct {
	h     tar.Header
	data  string // a temporary file holding a regular file's contents
	layer int
}

// Flatten writes the image's filesystem (its layers applied in order, whiteouts honoured, then
// `extra`, layers added on top) as one tar to w. File contents wait in tmp meanwhile.
func Flatten(layers []Layer, tmp string, w io.Writer) error {
	nodes := map[string]*node{}
	files := 0
	remove := func(p string, below int, self bool) {
		for k, n := range nodes {
			if n.layer >= below {
				continue
			}
			if (self && k == p) || strings.HasPrefix(k, p+"/") || p == "" {
				delete(nodes, k)
			}
		}
	}
	for i, open := range layers {
		r, err := open()
		if err != nil {
			return fmt.Errorf("layer %d: %w", i+1, err)
		}
		tr := tar.NewReader(r)
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				r.Close()
				return fmt.Errorf("layer %d: %w", i+1, err)
			}
			name := strings.Trim(path.Clean("/"+h.Name), "/")
			if name == "" || name == "." {
				continue
			}
			dir, base := path.Dir(name), path.Base(name)
			if dir == "." {
				dir = ""
			}
			if base == ".wh..wh..opq" {
				remove(dir, i, false) // an opaque directory hides what lower layers had in it
				continue
			}
			if strings.HasPrefix(base, ".wh.") {
				remove(path.Join(dir, base[len(".wh."):]), i+1, true)
				continue
			}
			if old, ok := nodes[name]; ok && old.h.Typeflag == tar.TypeDir && h.Typeflag != tar.TypeDir {
				remove(name, i+1, false) // a directory replaced by a file takes its contents with it
			}
			n := &node{h: *h, layer: i}
			n.h.Name = name
			if h.Typeflag == tar.TypeLink {
				n.h.Linkname = strings.Trim(path.Clean("/"+h.Linkname), "/")
			}
			if h.Typeflag == tar.TypeReg || h.Typeflag == tar.TypeRegA {
				n.h.Typeflag = tar.TypeReg
				files++
				n.data = filepath.Join(tmp, fmt.Sprintf("%d", files))
				f, err := os.Create(n.data)
				if err != nil {
					r.Close()
					return err
				}
				_, err = io.Copy(f, tr)
				f.Close()
				if err != nil {
					r.Close()
					return fmt.Errorf("layer %d: %s: %w", i+1, name, err)
				}
			}
			nodes[name] = n
		}
		// To its end: a tar stops at its end-of-archive blocks, and only a layer read to the end is
		// checked against its digest (and a gzip against its checksum)
		_, err = io.Copy(io.Discard, r)
		r.Close()
		if err != nil {
			return fmt.Errorf("layer %d: %w", i+1, err)
		}
	}
	// Directories every path needs, if a layer left them implicit
	for name := range nodes {
		for d := path.Dir(name); d != "." && d != "/"; d = path.Dir(d) {
			if _, ok := nodes[d]; !ok {
				nodes[d] = &node{h: tar.Header{Name: d, Typeflag: tar.TypeDir, Mode: 0o755}}
			}
		}
	}
	names := make([]string, 0, len(nodes))
	for k := range nodes {
		names = append(names, k)
	}
	sort.Strings(names)
	tw := tar.NewWriter(w)
	write := func(n *node) error {
		h := n.h
		if h.Typeflag == tar.TypeDir {
			h.Name += "/"
		}
		h.Format = tar.FormatPAX
		if err := tw.WriteHeader(&h); err != nil {
			return err
		}
		if n.data != "" {
			f, err := os.Open(n.data)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, f)
			f.Close()
			return err
		}
		return nil
	}
	// Hard links after what they link to
	for _, k := range names {
		if nodes[k].h.Typeflag != tar.TypeLink {
			if err := write(nodes[k]); err != nil {
				return err
			}
		}
	}
	for _, k := range names {
		n := nodes[k]
		if n.h.Typeflag == tar.TypeLink {
			if _, ok := nodes[n.h.Linkname]; !ok {
				continue // its target was whited out
			}
			if err := write(n); err != nil {
				return err
			}
		}
	}
	return tw.Close()
}

// Files is a layer made of the given files, for adding to an image.
type File struct {
	Name     string
	Mode     int64
	Data     []byte
	Dir      bool
	Linkname string // a symlink
}

// FilesLayer is a layer holding files.
func FilesLayer(files []File) Layer {
	return func() (io.ReadCloser, error) {
		pr, pw := io.Pipe()
		go func() {
			tw := tar.NewWriter(pw)
			for _, f := range files {
				h := &tar.Header{Name: f.Name, Mode: f.Mode, Typeflag: tar.TypeReg, Size: int64(len(f.Data))}
				switch {
				case f.Dir:
					h.Typeflag, h.Size = tar.TypeDir, 0
				case f.Linkname != "":
					h.Typeflag, h.Linkname, h.Size = tar.TypeSymlink, f.Linkname, 0
				}
				if err := tw.WriteHeader(h); err != nil {
					pw.CloseWithError(err)
					return
				}
				if h.Typeflag == tar.TypeReg {
					if _, err := tw.Write(f.Data); err != nil {
						pw.CloseWithError(err)
						return
					}
				}
			}
			pw.CloseWithError(tw.Close())
		}()
		return pr, nil
	}
}

// TarGzLayer is a layer read from a .tar.gz file.
func TarGzLayer(file string) Layer {
	return func() (io.ReadCloser, error) {
		f, err := os.Open(file)
		if err != nil {
			return nil, err
		}
		return decompress("+gzip", f)
	}
}
