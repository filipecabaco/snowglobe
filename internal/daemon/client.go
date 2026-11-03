package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// Client talks to a daemon's API.
type Client struct {
	http  *http.Client
	base  string
	token string
	// Where it is, for messages
	Addr string
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
		c.http = &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", sock)
			},
		}}
	case strings.HasPrefix(addr, "http://"), strings.HasPrefix(addr, "https://"):
		u, err := url.Parse(addr)
		if err != nil {
			return nil, err
		}
		c.base = strings.TrimSuffix(u.String(), "/")
		c.http = &http.Client{}
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
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &e)
		if e.Error == "" {
			e.Error = strings.TrimSpace(string(data))
		}
		return &apiError{status: resp.StatusCode, msg: e.Error}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (c *Client) call(method, path string, in, out any) error {
	return c.do(context.Background(), method, path, in, out)
}

func (c *Client) Templates() ([]Template, error) {
	var ts []Template
	return ts, c.call("GET", "/v1/templates", nil, &ts)
}

func (c *Client) AddTemplate(req AddTemplate) (*Template, error) {
	var t Template
	return &t, c.call("POST", "/v1/templates", req, &t)
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
	var s Snapshot
	return &s, c.call("POST", "/v1/machines/"+url.PathEscape(machine)+"/snapshots", map[string]string{"name": name}, &s)
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

func (c *Client) TemplateJob(name string, req control.JobRequest) (*control.JobResult, error) {
	var res control.JobResult
	return &res, c.call("POST", "/v1/templates/"+url.PathEscape(name)+"/jobs", req, &res)
}
