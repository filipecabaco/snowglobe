// Package daemon is snowglobe's orchestrator: one process per host that keeps templates (a site
// restored once, by a snowglobe-vm fork server) and the machines forked from them, and serves an
// HTTP/JSON API to create, list, run jobs on and remove them, on a Unix socket (and on TCP with a
// token when asked). Machines' ports are forwarded by the daemon itself: a forked machine's
// sandbox binds no TCP port, so each connection goes in through its control socket.
//
// The daemon's state is written to state.json as it changes; a daemon that restarts takes back the
// templates and machines that are still running.
package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Template is a site restored once by a fork server, for machines to be forked from.
type Template struct {
	Name string `json:"name"`
	Site string `json:"site"`
	// The fork server: its process (its own process group) and socket
	Pid    int    `json:"pid"`
	Server string `json:"server"`
	// Where its machines' sockets go (beside the server's) and its jobs' workspaces
	SocketDir string `json:"socket_dir"`
	JobsRoot  string `json:"jobs_root"`
	Log       string `json:"log"`
	// Its log's line saying it is ready: how long the restore took, what was compiled
	Ready string `json:"ready"`
	// The snowglobe-vm running it, for exec and attach on its machines
	VM          string `json:"vm"`
	MaxMachines int    `json:"max_machines"`
	// The snapshot it was made of, if any (else the site's own state)
	Snapshot string `json:"snapshot,omitempty"`
	// How long it may serve no machine before its server stops (0: never), and whether it has:
	// asleep, it starts again on its next use
	Idle    Duration          `json:"idle,omitempty"`
	Asleep  bool              `json:"asleep,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
	Started time.Time         `json:"started"`
}

// Machine is a machine forked from a template, lasting until it is removed.
type Machine struct {
	Name     string            `json:"name"`
	Template string            `json:"template"`
	Pid      int               `json:"pid"`
	Socket   string            `json:"socket"`
	Ports    []Port            `json:"ports,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	// The snapshot it started from, if any
	Snapshot string    `json:"snapshot,omitempty"`
	Created  time.Time `json:"created"`
	// When it stops, whatever it is doing (up --ttl)
	Expires *time.Time `json:"expires,omitempty"`
}

// Snapshot is a machine saved whole (RAM, CPUs, devices, the files its guest wrote): machines start
// from it again (up --snapshot), on any template of the same site, or a template is made of it.
type Snapshot struct {
	Name     string            `json:"name"`
	Site     string            `json:"site"`
	Template string            `json:"template"`
	Machine  string            `json:"machine"`
	Path     string            `json:"path"`
	Bytes    int64             `json:"bytes"`
	Ms       int64             `json:"ms"`
	Labels   map[string]string `json:"labels,omitempty"`
	Created  time.Time         `json:"created"`
}

// Port is a host port the daemon forwards to a machine's guest port.
type Port struct {
	IP    string `json:"ip"`
	Host  int    `json:"host"`
	Guest int    `json:"guest"`
}

func (p Port) String() string {
	return fmt.Sprintf("%s:%d→%d", p.IP, p.Host, p.Guest)
}

// ParsePort reads "GUEST", "HOST:GUEST" or "IP:HOST:GUEST". The host side is 127.0.0.1 unless an
// address is given, and a host port of 0 (or none) is picked by the system.
func ParsePort(spec string) (Port, error) {
	parts := strings.Split(spec, ":")
	p := Port{IP: "127.0.0.1"}
	var err error
	bad := fmt.Errorf("port %q: GUEST, HOST:GUEST or IP:HOST:GUEST", spec)
	num := func(s string, zero bool) (int, error) {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 || n > 65535 || (n == 0 && !zero) {
			return 0, bad
		}
		return n, nil
	}
	switch len(parts) {
	case 1:
		p.Guest, err = num(parts[0], false)
	case 2:
		if p.Host, err = num(parts[0], true); err == nil {
			p.Guest, err = num(parts[1], false)
		}
	case 3:
		if net.ParseIP(parts[0]) == nil {
			return Port{}, bad
		}
		p.IP = parts[0]
		if p.Host, err = num(parts[1], true); err == nil {
			p.Guest, err = num(parts[2], false)
		}
	default:
		return Port{}, bad
	}
	return p, err
}

var nameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)

// validName says whether name can name a template or machine: it becomes a socket's file name.
func validName(name string) error {
	if !nameRE.MatchString(name) {
		return fmt.Errorf("name %q: 1 to 63 letters, digits, - or _, starting with a letter or digit", name)
	}
	return nil
}

// randomName is prefix with a few random characters, for what is not named.
func randomName(prefix string) string {
	b := make([]byte, 3)
	rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

// Dir is where the daemon keeps its socket, state and templates' logs and jobs:
// $SNOWGLOBE_DAEMON_DIR, else the user cache's snowglobe/daemon.
func Dir() (string, error) {
	if d := os.Getenv("SNOWGLOBE_DAEMON_DIR"); d != "" {
		return d, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "snowglobe", "daemon"), nil
}

// SocketPath is the daemon's Unix socket.
func SocketPath() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "daemon.sock"), nil
}

// state is what the daemon writes to state.json.
type state struct {
	Templates map[string]*Template `json:"templates"`
	Machines  map[string]*Machine  `json:"machines"`
	Snapshots map[string]*Snapshot `json:"snapshots"`
	Services  map[string]*Service  `json:"services"`
}

func emptyState() state {
	return state{Templates: map[string]*Template{}, Machines: map[string]*Machine{}, Snapshots: map[string]*Snapshot{}, Services: map[string]*Service{}}
}

func loadState(path string) state {
	st := emptyState()
	data, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	if json.Unmarshal(data, &st) != nil {
		return emptyState()
	}
	if st.Templates == nil {
		st.Templates = map[string]*Template{}
	}
	if st.Machines == nil {
		st.Machines = map[string]*Machine{}
	}
	if st.Snapshots == nil {
		st.Snapshots = map[string]*Snapshot{}
	}
	if st.Services == nil {
		st.Services = map[string]*Service{}
	}
	return st
}

func saveState(path string, st state) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// apiError is an error with the HTTP status it answers with.
type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

func errStatus(status int, format string, a ...any) error {
	return &apiError{status: status, msg: fmt.Sprintf(format, a...)}
}

// statusOf is the HTTP status an error answers with: its own, else 500.
func statusOf(err error) int {
	var a *apiError
	if errors.As(err, &a) {
		return a.status
	}
	return 500
}

// ErrNotFound is the error the daemon answers with for what it doesn't have (NotFound says yes to
// it): for programs standing in for the daemon.
func ErrNotFound(what string) error { return errStatus(404, "no %s", what) }
