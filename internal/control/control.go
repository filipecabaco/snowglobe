// Package control speaks snowglobe-vm's control sockets: a running machine's (jobs on its serial
// shell, connections to its ports) and a fork server's (machines forked from its restore). The CLI
// and the daemon both drive machines through it.
package control

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// JobRequest is a job: files written into its workspace, the command, its environment.
type JobRequest struct {
	Files   map[string][]byte `json:"files,omitempty"`
	Cmd     string            `json:"cmd"`
	Env     map[string]string `json:"env,omitempty"`
	Timeout float64           `json:"timeout"`
}

// JobResult is what a job left: its exit status (nil: out of time, or the machine stopped), output
// and out/. Out of time or stopped, Killed says the guest killed everything the command started.
type JobResult struct {
	Status    *int              `json:"status"`
	Output    []byte            `json:"output"`
	Out       map[string][]byte `json:"out"`
	TimedOut  bool              `json:"timed_out"`
	Cancelled bool              `json:"cancelled"`
	Killed    bool              `json:"killed"`
	Ms        int64             `json:"ms"`
	Error     string            `json:"error,omitempty"`
}

// DefaultTimeout is a job's when its request gives none, in seconds.
const DefaultTimeout = 300

// Job runs a job on the machine whose control socket is sock; name is what errors call it.
func Job(sock, name string, req JobRequest) (*JobResult, error) {
	if req.Timeout < 0 {
		return nil, fmt.Errorf("timeout %v: 0 or more seconds", req.Timeout)
	}
	if req.Timeout == 0 {
		req.Timeout = DefaultTimeout
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	defer conn.Close()
	body := map[string]any{"mode": "job", "cmd": req.Cmd, "env": req.Env, "timeout": req.Timeout, "files": req.Files}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	conn.SetReadDeadline(time.Now().Add(time.Duration(req.Timeout+30) * time.Second))
	line, err := bufio.NewReaderSize(conn, 1<<20).ReadBytes('\n')
	if errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s stopped while the job ran (its logs say why)", name)
	}
	if err != nil {
		return nil, fmt.Errorf("%s: no answer: %w", name, err)
	}
	var res JobResult
	if err := json.Unmarshal(line, &res); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if res.Error != "" {
		return nil, errors.New(res.Error)
	}
	return &res, nil
}

// ask sends one JSON line to sock and reads one back into v, within d.
func ask(sock string, req any, v any, d time.Duration) (net.Conn, *bufio.Reader, error) {
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, nil, err
	}
	data, err := json.Marshal(req)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	conn.SetDeadline(time.Now().Add(d))
	if _, err := conn.Write(append(data, '\n')); err != nil {
		conn.Close()
		return nil, nil, err
	}
	r := bufio.NewReader(conn)
	line, err := r.ReadBytes('\n')
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("no answer: %w", err)
	}
	if err := json.Unmarshal(line, v); err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("answer %q: %w", strings.TrimSpace(string(line)), err)
	}
	conn.SetDeadline(time.Time{})
	return conn, r, nil
}

// Spawned is a machine a fork server forked: its process and control socket.
type Spawned struct {
	Pid    int    `json:"pid"`
	Socket string `json:"socket"`
	Error  string `json:"error"`
}

// Spawn asks the fork server on server for a machine called name (letters, digits, - and _),
// which serves its control socket beside the server's. With state (a machine's Save, under the
// server's jobs root) the machine starts from that instead of the template.
func Spawn(server, name, state string) (*Spawned, error) {
	var s Spawned
	req := map[string]any{"mode": "spawn", "name": name}
	if state != "" {
		req["state"] = state
	}
	conn, _, err := ask(server, req, &s, 2*time.Minute)
	if err != nil {
		return nil, fmt.Errorf("spawn %s: %w", name, err)
	}
	conn.Close()
	if s.Error != "" {
		return nil, errors.New(s.Error)
	}
	if s.Pid <= 0 || s.Socket == "" {
		return nil, fmt.Errorf("spawn %s: no machine in the answer", name)
	}
	return &s, nil
}

// Saved is what a machine's Save wrote.
type Saved struct {
	Bytes int64 `json:"bytes"`
	Ms    int64 `json:"ms"`
}

// Save writes the whole machine whose control socket is sock (RAM, CPUs, devices, the files its
// guest wrote) to path, which its sandbox must let it write. Its CPUs pause meanwhile.
func Save(sock, path string) (*Saved, error) {
	var answer struct {
		Saved
		Error string `json:"error"`
	}
	conn, _, err := ask(sock, map[string]any{"mode": "save", "path": path}, &answer, 5*time.Minute)
	if err != nil {
		return nil, fmt.Errorf("save: %w", err)
	}
	conn.Close()
	if answer.Error != "" {
		return nil, errors.New(answer.Error)
	}
	return &answer.Saved, nil
}

// Connect opens a connection to port on the machine whose control socket is sock: once it
// returns, what is written goes to the guest's port and what the guest sends comes back.
func Connect(sock string, port int) (net.Conn, error) {
	var answer struct {
		Connected int    `json:"connected"`
		Error     string `json:"error"`
	}
	conn, r, err := ask(sock, map[string]any{"mode": "connect", "port": port}, &answer, 30*time.Second)
	if err != nil {
		return nil, err
	}
	if answer.Error != "" || answer.Connected != port {
		conn.Close()
		return nil, fmt.Errorf("connect %d: %s", port, answer.Error)
	}
	if r.Buffered() > 0 {
		// What the guest sent at once belongs to the caller
		return &bufferedConn{Conn: conn, r: r}, nil
	}
	return conn, nil
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// CloseWrite ends what is sent, keeping what comes back (a TCP half-close), when the connection
// can.
func CloseWrite(c net.Conn) {
	if b, ok := c.(*bufferedConn); ok {
		c = b.Conn
	}
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	}
}

// Alive says whether something answers on the control socket sock.
func Alive(sock string) bool {
	c, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}
