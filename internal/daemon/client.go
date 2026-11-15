package daemon

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
	"github.com/klauspost/compress/zstd"
)

// Client talks to a daemon's API.
type Client struct {
	http  *http.Client
	base  string
	token string
	// Where it is, for messages
	Addr string
	// Whether it is on another host (http(s)://): it can't read this host's paths
	remote bool
	// Requests made for another host's (ForRemote)
	origin string
}

// headers puts the client's origin on each request it sends, whichever way it is sent.
type headers struct {
	c    *Client
	next http.RoundTripper
}

func (h headers) RoundTrip(r *http.Request) (*http.Response, error) {
	if h.c.origin != "" {
		r = r.Clone(r.Context())
		r.Header.Set(OriginHeader, h.c.origin)
	}
	return h.next.RoundTrip(r)
}

// ForRemote makes this client's requests ones made for a request from another host: the daemon
// holds them to its policy (the fleet routes, applying a fleet a remote client asked for).
func (c *Client) ForRemote() {
	c.origin = "remote"
}

// Remote says whether the daemon is on another host.
func (c *Client) Remote() bool {
	return c.remote
}

// Find is the daemon to talk to: $SNOWGLOBE_DAEMON (http://HOST:PORT, with
// $SNOWGLOBE_DAEMON_TOKEN, or unix:///PATH), else the local one if it runs. False if there is none.
func Find() (*Client, bool) {
	if addr := os.Getenv("SNOWGLOBE_DAEMON"); addr != "" {
		c, err := NewClient(addr, os.Getenv("SNOWGLOBE_DAEMON_TOKEN"))
		return c, err == nil
	}
	sock, err := SocketPath()
	if err != nil {
		return nil, false
	}
	if _, err := os.Stat(sock); err != nil {
		return nil, false
	}
	c, err := NewClient("unix://"+sock, "")
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if c.do(ctx, "GET", "/v1/health", nil, nil) != nil {
		return nil, false
	}
	return c, true
}

// NewClient is a client for the daemon at addr: unix:///PATH or http(s)://HOST:PORT.
func NewClient(addr, token string) (*Client, error) {
	c := &Client{token: token, Addr: addr}
	switch {
	case strings.HasPrefix(addr, "unix://"):
		sock := strings.TrimPrefix(addr, "unix://")
		c.base = "http://daemon"
		c.http = &http.Client{Transport: headers{c, &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", sock)
			},
		}}}
	case strings.HasPrefix(addr, "http://"), strings.HasPrefix(addr, "https://"):
		u, err := url.Parse(addr)
		if err != nil {
			return nil, err
		}
		c.base = strings.TrimSuffix(u.String(), "/")
		c.remote = true
		// Bounded connecting, not answering: a build, an apply or a stream takes as long as it does
		dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		c.http = &http.Client{Transport: headers{c, &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
			IdleConnTimeout:       90 * time.Second,
		}}}
	default:
		return nil, fmt.Errorf("daemon %q: unix:///PATH or http://HOST:PORT", addr)
	}
	return c, nil
}

// NotFound says whether err is the daemon not having what was asked for.
func NotFound(err error) bool {
	var a *apiError
	return errors.As(err, &a) && a.status == 404
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("daemon %s: %w", c.Addr, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return errorOf(resp.StatusCode, data)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// errorOf is the error an answer of status says in data.
func errorOf(status int, data []byte) error {
	var e struct {
		Error string `json:"error"`
		Mode  string `json:"mode"`
	}
	json.Unmarshal(data, &e)
	if e.Error == "" {
		e.Error = strings.TrimSpace(string(data))
	}
	return &apiError{status: status, msg: e.Error, mode: e.Mode}
}

// Version is which snowglobe the daemon is and what its mode lets it do. A daemon from before
// modes doesn't say: it is a full one.
func (c *Client) Version() (*Version, error) {
	var v Version
	err := c.call("GET", "/v1/version", nil, &v)
	if err != nil && NotFound(err) {
		if _, off := Disabled(err); !off {
			f := modes["full"]
			return &Version{Mode: f.Mode, Features: f}, nil
		}
	}
	return &v, err
}

func (c *Client) call(method, path string, in, out any) error {
	return c.do(context.Background(), method, path, in, out)
}

// Shutdown stops the daemon and everything it started, and returns once they have stopped.
func (c *Client) Shutdown() error {
	return c.call("POST", "/v1/shutdown", nil, nil)
}

func (c *Client) Templates() ([]Template, error) {
	var ts []Template
	return ts, c.call("GET", "/v1/templates", nil, &ts)
}

// AddTemplate asks for a template. To a daemon on another host a site of this one (a directory or
// a tarball) is uploaded first: the daemon reads its own disk, not this one's.
func (c *Client) AddTemplate(req AddTemplate) (*Template, error) {
	if c.remote && req.Site != "" && !strings.HasPrefix(req.Site, "http://") && !strings.HasPrefix(req.Site, "https://") {
		if _, err := os.Stat(req.Site); err == nil {
			site, err := c.Upload(req.Site)
			if err != nil {
				return nil, err
			}
			req.Site = site
		}
	}
	var t Template
	return &t, c.call("POST", "/v1/templates", req, &t)
}

// Upload sends a built site of this host (its directory, or a tarball: .tar, .tar.gz, .tgz,
// .tar.zst) to the daemon, and returns where the daemon keeps it, for AddTemplate.Site.
func (c *Client) Upload(site string) (string, error) {
	fi, err := os.Stat(site)
	if err != nil {
		return "", err
	}
	var body io.Reader
	format := "tar"
	if fi.IsDir() {
		if _, err := os.Stat(filepath.Join(site, "run.json")); err != nil {
			return "", fmt.Errorf("%s isn't a built snowglobe site (no run.json)", site)
		}
		pr, pw := io.Pipe()
		go func() { pw.CloseWithError(packDir(pw, site)) }()
		defer pr.Close()
		body, format = pr, "zst"
	} else {
		f, err := os.Open(site)
		if err != nil {
			return "", err
		}
		defer f.Close()
		body = f
		switch {
		case strings.HasSuffix(site, ".gz"), strings.HasSuffix(site, ".tgz"):
			format = "gz"
		case strings.HasSuffix(site, ".zst"):
			format = "zst"
		case strings.HasSuffix(site, ".tar"):
		default:
			return "", fmt.Errorf("%s: a site's directory, or a tarball (.tar, .tar.gz, .tgz, .tar.zst)", site)
		}
	}
	req, err := http.NewRequest("POST", c.base+"/v1/sites?format="+format, body)
	if err != nil {
		return "", err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("daemon %s: uploading %s: %w", c.Addr, site, err)
	}
	defer resp.Body.Close()
	var out struct {
		Site  string `json:"site"`
		Error string `json:"error"`
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	json.Unmarshal(data, &out)
	if resp.StatusCode >= 300 {
		if out.Error == "" {
			out.Error = strings.TrimSpace(string(data))
		}
		return "", &apiError{status: resp.StatusCode, msg: out.Error}
	}
	return out.Site, nil
}

// packDir writes dir as a zstd tar: its regular files and directories (what a site is), with
// their modes.
func packDir(w io.Writer, dir string) error {
	zw, err := zstd.NewWriter(w)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(zw)
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil || rel == "." {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		// A link is followed (a pooled site's blobs are links to a shared directory)
		if info.Mode()&fs.ModeSymlink != 0 {
			if info, err = os.Stat(path); err != nil {
				return err
			}
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return nil
		}
		h, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		if info.IsDir() {
			h.Name += "/"
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return zw.Close()
}

func (c *Client) RemoveTemplate(name string) error {
	return c.call("DELETE", "/v1/templates/"+url.PathEscape(name), nil, nil)
}

func (c *Client) Machines(labels map[string]string) ([]Machine, error) {
	q := url.Values{}
	for k, v := range labels {
		q.Add("label", k+"="+v)
	}
	path := "/v1/machines"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var ms []Machine
	return ms, c.call("GET", path, nil, &ms)
}

func (c *Client) Machine(name string) (*Machine, error) {
	var m Machine
	return &m, c.call("GET", "/v1/machines/"+url.PathEscape(name), nil, &m)
}

func (c *Client) Up(req Up) (*Machine, error) {
	var m Machine
	return &m, c.call("POST", "/v1/machines", req, &m)
}

func (c *Client) RemoveMachine(name string) error {
	return c.call("DELETE", "/v1/machines/"+url.PathEscape(name), nil, nil)
}

func (c *Client) Job(name string, req control.JobRequest) (*control.JobResult, error) {
	var res control.JobResult
	return &res, c.call("POST", "/v1/machines/"+url.PathEscape(name)+"/jobs", req, &res)
}

func (c *Client) Snapshot(machine, name string) (*Snapshot, error) {
	return c.SnapshotWith(machine, name, nil)
}

// SnapshotWith is Snapshot, with labels.
func (c *Client) SnapshotWith(machine, name string, labels map[string]string) (*Snapshot, error) {
	var s Snapshot
	req := map[string]any{"name": name, "labels": labels}
	return &s, c.call("POST", "/v1/machines/"+url.PathEscape(machine)+"/snapshots", req, &s)
}

func (c *Client) Snapshots() ([]Snapshot, error) {
	var ss []Snapshot
	return ss, c.call("GET", "/v1/snapshots", nil, &ss)
}

func (c *Client) RemoveSnapshot(name string) error {
	return c.call("DELETE", "/v1/snapshots/"+url.PathEscape(name), nil, nil)
}

func (c *Client) Services() ([]ServiceStatus, error) {
	var ss []ServiceStatus
	return ss, c.call("GET", "/v1/services", nil, &ss)
}

func (c *Client) AddService(req Service) (*ServiceStatus, error) {
	var s ServiceStatus
	return &s, c.call("POST", "/v1/services", req, &s)
}

func (c *Client) Service(name string) (*ServiceStatus, error) {
	var s ServiceStatus
	return &s, c.call("GET", "/v1/services/"+url.PathEscape(name), nil, &s)
}

func (c *Client) RemoveService(name string) error {
	return c.call("DELETE", "/v1/services/"+url.PathEscape(name), nil, nil)
}

func (c *Client) ServiceJob(name string, req control.JobRequest) (*control.JobResult, error) {
	var res control.JobResult
	return &res, c.call("POST", "/v1/services/"+url.PathEscape(name)+"/jobs", req, &res)
}

func (c *Client) Stats() (*Stats, error) {
	var s Stats
	return &s, c.call("GET", "/v1/stats", nil, &s)
}

// Events calls f with each event the daemon has kept after seq after, then with each as it
// happens, until ctx is done, the daemon goes, or f returns false.
func (c *Client) Events(ctx context.Context, after int64, f func(Event) bool) error {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/v1/events?after=%d", c.base, after), nil)
	if err != nil {
		return err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	// No timeout: the stream lasts
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("daemon %s: %w", c.Addr, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		data, _ := io.ReadAll(resp.Body)
		return &apiError{status: resp.StatusCode, msg: strings.TrimSpace(string(data))}
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var ev Event
		if json.Unmarshal([]byte(data), &ev) == nil && !f(ev) {
			return nil
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	return sc.Err()
}

func (c *Client) TemplateJob(name string, req control.JobRequest) (*control.JobResult, error) {
	var res control.JobResult
	return &res, c.call("POST", "/v1/templates/"+url.PathEscape(name)+"/jobs", req, &res)
}

// Builds is every build, newest first.
func (c *Client) Builds() ([]Build, error) {
	var v []Build
	return v, c.call("GET", "/v1/builds", nil, &v)
}

// StartBuild starts building a site (and a template of it).
func (c *Client) StartBuild(req BuildRequest) (*Build, error) {
	if c.remote && req.Source != "" {
		if fi, err := os.Stat(req.Source); err == nil && fi.IsDir() {
			return nil, fmt.Errorf("%s is a directory of this host, and the daemon at %s is on another: build it here (snowglobe build), then template add the site, which uploads it", req.Source, c.Addr)
		}
	}
	var v Build
	return &v, c.call("POST", "/v1/builds", req, &v)
}

// Build is the build called id.
func (c *Client) Build(id string) (*Build, error) {
	var v Build
	return &v, c.call("GET", "/v1/builds/"+url.PathEscape(id), nil, &v)
}

// RemoveBuild cancels a build, or removes one that is done.
func (c *Client) RemoveBuild(id string) error {
	return c.call("DELETE", "/v1/builds/"+url.PathEscape(id), nil, nil)
}

// BuildLog is a build's log from offset on.
func (c *Client) BuildLog(id string, offset int64) (string, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/v1/builds/%s/log?offset=%d", c.base, url.PathEscape(id), offset), nil)
	if err != nil {
		return "", err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("daemon %s: %w", c.Addr, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &e)
		return "", &apiError{status: resp.StatusCode, msg: e.Error}
	}
	return string(data), err
}

// UploadContext sends a directory of this host with a Dockerfile to the daemon as a build
// context (its files with their modes, its directories and links, as `docker build` reads it),
// for BuildRequest.Context.
func (c *Client) UploadContext(dir string) (*ContextUpload, error) {
	if _, err := os.Stat(filepath.Join(dir, "Dockerfile")); err != nil {
		return nil, fmt.Errorf("%s has no Dockerfile", dir)
	}
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(packContext(pw, dir)) }()
	defer pr.Close()
	req, err := http.NewRequest("POST", c.base+"/v1/contexts?format=zst", pr)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("daemon %s: uploading %s: %w", c.Addr, dir, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, errorOf(resp.StatusCode, data)
	}
	var up ContextUpload
	return &up, json.Unmarshal(data, &up)
}

// packContext writes dir as a zstd tar: its regular files, directories and symbolic links (as
// links, not followed), with their modes.
func packContext(w io.Writer, dir string) error {
	zw, err := zstd.NewWriter(w)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(zw)
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil || rel == "." {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		link := ""
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			if link, err = os.Readlink(path); err != nil {
				return err
			}
		case !info.IsDir() && !info.Mode().IsRegular():
			return nil // a socket, a pipe: nothing a build reads
		}
		h, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		if info.IsDir() {
			h.Name += "/"
		}
		// Whose they are here means nothing there
		h.Uid, h.Gid, h.Uname, h.Gname = 0, 0, "", ""
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return zw.Close()
}

// FollowBuildLog copies a build's log to w from offset on, as it is written, until the build
// ends (or ctx does), and returns where it got to.
func (c *Client) FollowBuildLog(ctx context.Context, id string, offset int64, w io.Writer) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/v1/builds/%s/log?follow=1&offset=%d", c.base, url.PathEscape(id), offset), nil)
	if err != nil {
		return offset, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return offset, fmt.Errorf("daemon %s: %w", c.Addr, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return offset, errorOf(resp.StatusCode, data)
	}
	n, err := io.Copy(w, resp.Body)
	if ctx.Err() != nil {
		err = nil
	}
	return offset + n, err
}

// DownloadArtifact writes a done build's artifact to out (format "gz" for the .tar.gz, else the
// .tar.zst), checked against the sha256 the daemon says it has, and returns its size and sha256.
// Half a file is no file: out is there only once all of it is.
func (c *Client) DownloadArtifact(id, format, out string) (int64, string, error) {
	path := "/v1/builds/" + url.PathEscape(id) + "/artifact"
	if format != "" {
		path += "?format=" + url.QueryEscape(format)
	}
	req, err := http.NewRequest("GET", c.base+path, nil)
	if err != nil {
		return 0, "", err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("daemon %s: %w", c.Addr, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return 0, "", errorOf(resp.StatusCode, data)
	}
	tmp, err := os.CreateTemp(filepath.Dir(out), "."+filepath.Base(out)+".")
	if err != nil {
		return 0, "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), resp.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, "", fmt.Errorf("downloading the artifact: %w", err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if want := strings.Trim(resp.Header.Get("ETag"), `"`); want != "" && want != sum {
		return 0, "", fmt.Errorf("the artifact downloaded hashes to %s, and the daemon says %s", sum, want)
	}
	if resp.ContentLength >= 0 && n != resp.ContentLength {
		return 0, "", fmt.Errorf("the artifact downloaded is %d bytes of %d", n, resp.ContentLength)
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return 0, "", err
	}
	return n, sum, os.Rename(tmp.Name(), out)
}

// Metrics is the daemon's samples after since (all when zero) and its totals.
func (c *Client) Metrics(since time.Time) (*Metrics, error) {
	var v Metrics
	path := "/v1/metrics"
	if !since.IsZero() {
		path += fmt.Sprintf("?since=%d", since.UnixMilli())
	}
	return &v, c.call("GET", path, nil, &v)
}

// Proxy forwards requests to the daemon's API as they are (WebSockets included), bearing its
// token: for `snowglobe ui`, which checks who asks first.
func (c *Client) Proxy() http.Handler {
	target, _ := url.Parse(c.base)
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
			r.Out.Header.Del("Cookie")
			if c.token != "" {
				r.Out.Header.Set("Authorization", "Bearer "+c.token)
			}
		},
		Transport:     c.http.Transport,
		FlushInterval: -1,
	}
}

// Ports is every host port the daemon holds and where it leads.
func (c *Client) Ports() ([]PortMapping, error) {
	var v []PortMapping
	return v, c.call("GET", "/v1/ports", nil, &v)
}

// CheckPort says whether a host port is free to forward (ip empty: 127.0.0.1).
func (c *Client) CheckPort(ip string, port int) (*PortCheck, error) {
	var v PortCheck
	return &v, c.call("GET", fmt.Sprintf("/v1/ports/check?ip=%s&port=%d", url.QueryEscape(ip), port), nil, &v)
}

// SubmitRun starts a command on a fresh fork of a template and answers at once (fire and forget).
func (c *Client) SubmitRun(req SubmitRun) (*Run, error) {
	var v Run
	return &v, c.call("POST", "/v1/runs", req, &v)
}

// Runs is the kept runs, newest first, without their output.
func (c *Client) Runs() ([]Run, error) {
	var v []Run
	return v, c.call("GET", "/v1/runs", nil, &v)
}

// Run is one run, with its output once it ended.
func (c *Client) Run(id string) (*Run, error) {
	var v Run
	return &v, c.call("GET", "/v1/runs/"+url.PathEscape(id), nil, &v)
}

func (c *Client) Links() ([]Link, error) {
	var ls []Link
	return ls, c.call("GET", "/v1/links", nil, &ls)
}

func (c *Client) AddLink(req Link) (*Link, error) {
	var l Link
	return &l, c.call("POST", "/v1/links", req, &l)
}

func (c *Client) RemoveLink(name string) error {
	return c.call("DELETE", "/v1/links/"+url.PathEscape(name), nil, nil)
}

func (c *Client) Graph() (*Graph, error) {
	var g Graph
	return &g, c.call("GET", "/v1/graph", nil, &g)
}

// Fleets is every fleet the daemon knows (its fleet routes: cmd/snowglobe gives it them).
func (c *Client) Fleets() ([]FleetInfo, error) {
	var fs []FleetInfo
	return fs, c.call("GET", "/v1/fleets", nil, &fs)
}

// AddFleet adds the fleet file at file (a full path on the daemon's host).
func (c *Client) AddFleet(file string) error {
	return c.call("POST", "/v1/fleets", map[string]string{"file": file}, nil)
}

// WriteFleet checks text and writes it as fleet name's file (a new fleet's goes in the daemon's
// directory).
func (c *Client) WriteFleet(name, text string) error {
	return c.call("PUT", "/v1/fleets/"+url.PathEscape(name), map[string]string{"text": text}, nil)
}

// Fleet is fleet name's file and plan, as JSON.
func (c *Client) Fleet(name string) (json.RawMessage, error) {
	var v json.RawMessage
	return v, c.call("GET", "/v1/fleets/"+url.PathEscape(name), nil, &v)
}

// ApplyFleet applies one step of an instance of fleet name (main when instance is empty), or all
// of them: its log and plan.
func (c *Client) ApplyFleet(name, instance, step string) (json.RawMessage, error) {
	var v json.RawMessage
	return v, c.call("POST", "/v1/fleets/"+url.PathEscape(name)+"/apply", map[string]string{"step": step, "instance": instance}, &v)
}

// StartInstance starts an instance of fleet name (numbered when instance is empty).
func (c *Client) StartInstance(name, instance string) (json.RawMessage, error) {
	var v json.RawMessage
	return v, c.call("POST", "/v1/fleets/"+url.PathEscape(name)+"/instances", map[string]string{"instance": instance}, &v)
}

// StopInstance removes an instance of fleet name; what its instances share stays.
func (c *Client) StopInstance(name, instance string) (json.RawMessage, error) {
	var v json.RawMessage
	return v, c.call("DELETE", "/v1/fleets/"+url.PathEscape(name)+"/instances/"+url.PathEscape(instance), nil, &v)
}

// ForgetFleet drops fleet name from the daemon's list, removing what it made first when down.
func (c *Client) ForgetFleet(name string, down bool) (json.RawMessage, error) {
	var v json.RawMessage
	q := ""
	if down {
		q = "?down=1"
	}
	return v, c.call("DELETE", "/v1/fleets/"+url.PathEscape(name)+q, nil, &v)
}
