// Package control speaks snowglobe-vm's control sockets: a running machine's (jobs on its serial
// shell, connections to its ports) and a fork server's (machines forked from its restore). The CLI
// and the daemon both drive machines through it.
package control

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// JobRequest is a job: files written into its workspace, the command, its environment. The
// command starts in the workspace (where its files are, and out/ is), or with Home in the home
// directory, as a command typed into the machine's terminal does: for a person or an agent
// (snowglobe sh, run_command), the workspace still its own as $EXCLAVE_WORKSPACE.
//
// Everything after Home is optional, off unless set; a limit the machine can't enforce fails the
// job, saying so, rather than running it without (docs/design/exclave-contract.md).
type JobRequest struct {
	Files   map[string][]byte `json:"files,omitempty"`
	Cmd     string            `json:"cmd"`
	Env     map[string]string `json:"env,omitempty"`
	Timeout float64           `json:"timeout"`
	Home    bool              `json:"home,omitempty"`
	// An absolute guest path to run in instead of the job's own directory: its Files are copied
	// there, and its out/ is read from there (only what the job wrote). A job forked from a
	// build's snapshot runs in the workspace the build left (/workspace)
	Workdir string `json:"workdir,omitempty"`
	// The command's memory (cgroup v2 memory.max, no swap): past it the guest kills it (OOM,
	// status 137)
	MemoryLimitMB int64 `json:"memory_limit_mb,omitempty"`
	// The command's CPUs (cpu.max quota, may be fractional)
	CPUsLimit float64 `json:"cpus_limit,omitempty"`
	// The command's processes and threads (pids.max)
	PidsLimit int64 `json:"pids_limit,omitempty"`
	// What the guest's file writes may hold (they are in host memory): past it, ENOSPC (DiskFull)
	DiskLimitMB int64 `json:"disk_limit_mb,omitempty"`
	// The job's process's resident memory on the host: past it the job ends (OOM, status 137). On
	// a machine (a long-lived one) it is the machine's memory, at its most
	MaxRSSMB int64 `json:"max_rss_mb,omitempty"`
	// The job's host CPU time (every emulator thread): past it the job ends (CPUTimeExceeded)
	CPUTimeS float64 `json:"cpu_time_s,omitempty"`
	// What the command may print, in bytes: past it it is killed, its output cut there
	// (OutputTruncated)
	OutputLimit int64 `json:"output_limit,omitempty"`
	// What is copied in (Files) and back (out/), each (default 2048 MB)
	CopyLimitMB int64 `json:"copy_limit_mb,omitempty"`
	// none, https (TCP 443 and DNS, public addresses only), internet or private: at most what
	// the machine's network allows. A job on a running machine has the machine's (ask for it as
	// the machine starts: Up's Egress) and may only name that one
	Egress string `json:"egress,omitempty"`
	// The working directory's in/ is read-only in the guest
	ReadOnlyIn bool `json:"read_only_in,omitempty"`
	// Recorded with the job: in its log and the daemon's events
	Labels map[string]string `json:"labels,omitempty"`
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
	// Bytes of the output and of out/'s files dropped as the answer was read (JobLimited)
	OutputCut int64 `json:"output_cut,omitempty"`
	OutCut    int64 `json:"out_cut,omitempty"`
	// Out of memory: the guest killed it (MemoryLimitMB), or its process went past MaxRSSMB.
	// Status is 137 either way
	OOM bool `json:"oom"`
	// A write was refused for DiskLimitMB (ENOSPC)
	DiskFull bool `json:"disk_full"`
	// It printed more than OutputLimit: killed, its output cut there
	OutputTruncated bool `json:"output_truncated"`
	// Its process went past CPUTimeS, and it ended
	CPUTimeExceeded bool `json:"cpu_time_exceeded"`
	// out/ held more than CopyLimitMB: what is past it was left behind
	OutTruncated bool `json:"out_truncated,omitempty"`
}

// JobError is a job the machine answered it couldn't run, saying why (a limit it can't enforce, an
// egress it hasn't, a bad workdir): the job's failure, not the API's. The daemon answers it as a
// JobResult with Error, with 200.
type JobError struct{ Msg string }

func (e *JobError) Error() string { return e.Msg }

// DefaultTimeout is a job's when its request gives none, in seconds.
const DefaultTimeout = 300

// Job runs a job on the machine whose control socket is sock; name is what errors call it.
func Job(sock, name string, req JobRequest) (*JobResult, error) {
	return JobLimited(context.Background(), sock, name, req, 0)
}

// JobLimited is Job, given up on (its connection closed) when ctx is done, keeping at most keep
// bytes of the output and keep of out/'s files together (0: all of them): the rest is dropped as
// it is read, never held, and OutputCut and OutCut say how much went.
func JobLimited(ctx context.Context, sock, name string, req JobRequest, keep int64) (*JobResult, error) {
	if req.Timeout < 0 {
		return nil, fmt.Errorf("timeout %v: 0 or more seconds", req.Timeout)
	}
	if req.Timeout == 0 {
		req.Timeout = DefaultTimeout
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", sock)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	defer conn.Close()
	// Given up: the connection closed, which ends the wait below
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	// The request as it is, and the mode: what the machine's control socket reads
	data, err := json.Marshal(struct {
		Mode string `json:"mode"`
		JobRequest
	}{"job", req})
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	conn.SetReadDeadline(time.Now().Add(time.Duration(req.Timeout+30) * time.Second))
	// 64 KiB: readClipped takes the line in pieces, so a bigger buffer only costs memory, once
	// per job in flight (50 at once held 50 MiB of them)
	line, cutOutput, cutOut, err := readClipped(bufio.NewReaderSize(conn, 64<<10), keep)
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s: the job was given up: %w", name, ctx.Err())
	}
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
		return nil, &JobError{Msg: res.Error}
	}
	res.OutputCut, res.OutCut = cutOutput, cutOut
	return &res, nil
}

// readClipped reads one JSON line (a job's answer), keeping at most keep bytes of its "output"
// and keep of the files in its "out" together (0: everything). Both are base64 strings, cut on a
// whole group of 4 characters so that what is kept still decodes; what is dropped is counted, in
// bytes decoded (about: to a few bytes). Keys and every other value are kept whole.
func readClipped(r *bufio.Reader, keep int64) (line []byte, cutOutput, cutOut int64, err error) {
	type level struct{ object, key bool }
	var (
		stack                   []level
		inString, escape, isKey bool
		clipping                bool
		n                       int64 // characters of the current string kept
		top, key                string
		keyBuf                  []byte
		// Characters of base64 left to keep, for the output and for out/'s files
		left = map[string]int64{"output": keep / 3 * 4, "out": keep / 3 * 4}
		cut  = map[string]int64{}
	)
	for {
		chunk, rerr := r.ReadSlice('\n')
		for _, c := range chunk {
			if inString {
				if clipping && (escape || c != '"') {
					// Dropped, to the string's end
					escape = !escape && c == '\\'
					cut[top]++
					continue
				}
				switch {
				case escape:
					escape = false
				case c == '\\':
					escape = true
				case c == '"':
					inString, clipping = false, false
					if isKey && len(stack) == 1 {
						key = string(keyBuf)
					}
				default:
					budget, limited := left[top]
					if keep > 0 && !isKey && limited && !clipping && budget <= 0 && n%4 == 0 {
						clipping = true
					}
					if clipping {
						cut[top]++
						continue
					}
					n++
					if limited && !isKey {
						left[top]--
					}
					if isKey && len(stack) == 1 {
						keyBuf = append(keyBuf, c)
					}
				}
				line = append(line, c)
				continue
			}
			switch c {
			case '"':
				inString, n, keyBuf = true, 0, keyBuf[:0]
				isKey = len(stack) > 0 && stack[len(stack)-1].object && stack[len(stack)-1].key
			case '{', '[':
				stack = append(stack, level{object: c == '{', key: c == '{'})
			case '}', ']':
				if len(stack) > 0 {
					stack = stack[:len(stack)-1]
				}
			case ':':
				if len(stack) > 0 {
					stack[len(stack)-1].key = false
					if len(stack) == 1 {
						top = key
					}
				}
			case ',':
				if len(stack) > 0 && stack[len(stack)-1].object {
					stack[len(stack)-1].key = true
				}
				if len(stack) == 1 {
					top = ""
				}
			}
			line = append(line, c)
		}
		switch {
		case errors.Is(rerr, bufio.ErrBufferFull):
			continue
		case rerr != nil:
			return line, cut["output"] * 3 / 4, cut["out"] * 3 / 4, rerr
		}
		return line, cut["output"] * 3 / 4, cut["out"] * 3 / 4, nil
	}
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
	return SpawnWith(server, name, SpawnOptions{State: state})
}

// SpawnOptions are what a machine is spawned with besides its name.
type SpawnOptions struct {
	// A machine's Save, under the server's jobs root, to start from instead of the template
	State string
	// Its network (none, https, internet, private), at most its server's ("": its server's)
	Egress string
	// A directory of its own under the jobs root: all it may touch of the root once it has read
	// State (its Saves go there). "": the server's whole root
	Dir string
}

// SpawnWith is Spawn, with its options.
func SpawnWith(server, name string, o SpawnOptions) (*Spawned, error) {
	var s Spawned
	req := map[string]any{"mode": "spawn", "name": name}
	if o.State != "" {
		req["state"] = o.State
	}
	if o.Egress != "" {
		req["egress"] = o.Egress
	}
	if o.Dir != "" {
		req["dir"] = o.Dir
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

// Link is a destination a machine's guest connects to (a name, or "" for any, and a port) that
// goes to a tcp://HOST:PORT address instead.
type Link struct {
	Host string `json:"host,omitempty"`
	Port int    `json:"port"`
	URL  string `json:"url"`
}

// Linker opens the link channel of the machine whose control socket is sock: a machine its
// sandbox lets connect to no Unix socket asks on it for each connection its guest opens to a
// link, {"open":ID,"url":URL} (a URL SetLinks gave), and is answered {"id":ID} with the
// connection as a descriptor (SCM_RIGHTS), or {"id":ID,"error":"..."} without one. The machine
// keeps one channel, the newest.
func Linker(sock string) (*net.UnixConn, *bufio.Reader, error) {
	var answer struct {
		Linker bool `json:"linker"`
	}
	conn, r, err := ask(sock, map[string]any{"mode": "linker"}, &answer, 10*time.Second)
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		// "snowglobe: unknown request": a snowglobe-vm from before link channels
		return nil, nil, errors.New("link channel: this machine's snowglobe-vm has none (update it)")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("link channel: %w", err)
	}
	uc, ok := conn.(*net.UnixConn)
	if !answer.Linker || !ok {
		conn.Close()
		return nil, nil, errors.New("link channel: this machine's snowglobe-vm has none (update it)")
	}
	return uc, r, nil
}

// RestartApp starts the site's app again in the machine whose control socket is sock (a
// template's restart_app), and returns once the app printed its ready text: a process of its own,
// with a random state of its own, not the copy of the snapshot's every machine of it has.
func RestartApp(sock string) error {
	var answer struct {
		Restarted bool   `json:"restarted"`
		Error     string `json:"error"`
	}
	conn, _, err := ask(sock, map[string]any{"mode": "restart_app"}, &answer, 2*time.Minute)
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		return errors.New("restart_app: this machine's snowglobe-vm can't (update it)")
	}
	if err != nil {
		return fmt.Errorf("restart_app: %w", err)
	}
	conn.Close()
	if answer.Error != "" {
		return errors.New(answer.Error)
	}
	if !answer.Restarted {
		return errors.New("restart_app: this machine's snowglobe-vm can't (update it)")
	}
	return nil
}

// SetLinks replaces the links of the machine whose control socket is sock: its new connections
// follow them at once.
func SetLinks(sock string, links []Link) error {
	var answer struct {
		Links *int   `json:"links"`
		Error string `json:"error"`
	}
	if links == nil {
		links = []Link{}
	}
	conn, _, err := ask(sock, map[string]any{"mode": "links", "links": links}, &answer, 10*time.Second)
	if err != nil {
		return fmt.Errorf("links: %w", err)
	}
	conn.Close()
	if answer.Error != "" {
		return errors.New(answer.Error)
	}
	if answer.Links == nil {
		return errors.New("links: this machine's snowglobe-vm doesn't take links (update it)")
	}
	return nil
}
