// Package instance runs a built site headlessly: the guest is restored from its snapshot in
// armless (snowglobe-vm), natively where there is a snowglobe-vm for this system (it sandboxes
// itself) or else in a sandboxed container, and its app console is connected to the terminal (or
// to a pipe, or left running for `exec` and `attach`).
package instance

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/filipecabaco/snowglobe/internal/docker"
	"github.com/filipecabaco/snowglobe/internal/native"
	"github.com/filipecabaco/snowglobe/internal/tools"
	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

// label marks the containers snowglobe started, for ps
const label = "snowglobe.instance"

// Options for Run.
type Options struct {
	Site   string
	Name   string
	Detach bool
	// Ports to forward into the guest: "guest", "host:guest" or "ip:host:guest"
	Publish []string
	// Tunnels replace the site's own ("[HOST:]PORT=URL"), e.g. to point it at a local proxy
	Tunnels []string
	// AllowPrivate lets the guest reach loopback and private addresses
	AllowPrivate bool
	// TunnelToken replaces the site's token endpoint for tunnel URLs with {token}
	TunnelToken string
	// RecordReads is a file to write every file the guest reads to, for `snowglobe warm`
	RecordReads string
	// Docker runs it in a container (the tools image) rather than natively
	Docker bool
}

// Port is one forwarded port.
type Port struct {
	IP    string // host address to bind; loopback unless asked otherwise
	Host  int
	Guest int
}

// ParsePort reads "8000", "8080:8000" or "0.0.0.0:8080:8000". The host side binds to 127.0.0.1
// unless an address is given: the guest is a sandbox, so reaching it from the network is opt-in.
func ParsePort(spec string) (Port, error) {
	parts := strings.Split(spec, ":")
	p := Port{IP: "127.0.0.1"}
	var err error
	switch len(parts) {
	case 1:
		p.Guest, err = strconv.Atoi(parts[0])
		p.Host = p.Guest
	case 2:
		if p.Host, err = strconv.Atoi(parts[0]); err == nil {
			p.Guest, err = strconv.Atoi(parts[1])
		}
	case 3:
		p.IP = parts[0]
		if p.Host, err = strconv.Atoi(parts[1]); err == nil {
			p.Guest, err = strconv.Atoi(parts[2])
		}
	default:
		err = errors.New("too many parts")
	}
	if err != nil || p.Host < 1 || p.Host > 65535 || p.Guest < 1 || p.Guest > 65535 {
		return Port{}, fmt.Errorf("-p %s: use GUEST, HOST:GUEST or IP:HOST:GUEST", spec)
	}
	return p, nil
}

// Run restores the site and connects to it, or leaves it running when detached.
func Run(o Options, version string) error {
	site, err := filepath.Abs(o.Site)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(site, "run.json"))
	if err != nil {
		return fmt.Errorf("%s isn't a built snowglobe site (no run.json)", o.Site)
	}
	var run struct {
		MemoryMB int             `json:"memory_mb"`
		Network  string          `json:"network"`
		Tunnels  []tunnel.Tunnel `json:"tunnels"`
		Token    string          `json:"tunnel_token"`
	}
	if err := json.Unmarshal(data, &run); err != nil {
		return err
	}
	tunnels := run.Tunnels
	if len(o.Tunnels) > 0 {
		if tunnels, err = tunnel.ParseAll(o.Tunnels); err != nil {
			return err
		}
	}
	if len(tunnels) > 0 && run.Network != "fetch" {
		return errors.New("tunnels need a guest with a network: build the site with --network fetch")
	}
	token := run.Token
	if o.TunnelToken != "" {
		token = o.TunnelToken
	}
	if tunnels, err = tunnel.Fill(tunnels, token); err != nil {
		return err
	}

	// Natively, when there is a snowglobe-vm for this system: it sandboxes itself
	if !o.Docker {
		vm, err := native.VM(version, tools.NativeSource(version))
		if err == nil {
			return runNative(o, site, vm, run.Network, tunnels)
		}
		if !native.DockerAvailable() {
			return err
		}
		fmt.Fprintf(os.Stderr, "%v: running it in a container\n", err)
	}

	t, err := tools.Build(version)
	if err != nil {
		return err
	}

	// The sandbox: the guest is an emulated machine with no access to the host, and the container
	// around it runs unprivileged, read-only, memory-capped and offline unless the site was built
	// with a network
	args := []string{"run", "--rm", "--init",
		"--label", label + "=" + site,
		"--user", "65534:65534", "--read-only", "--tmpfs", "/tmp",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--memory", fmt.Sprintf("%dm", run.MemoryMB+768), "--pids-limit", "256",
		"-v", site + ":/site:ro"}
	args = append(args, tools.JITArgs()...)
	if run.Network != "fetch" {
		if len(o.Publish) > 0 {
			return fmt.Errorf("-p needs a guest with a network: build the site with --network fetch")
		}
		args = append(args, "--network", "none")
	}
	hostNetwork := false
	if run.Network == "fetch" {
		// Out the way the host goes out: its proxy and CA bundle, if it has them
		net := tools.NetworkArgs()
		hostNetwork = slices.Contains(net, "host")
		args = append(args, net...)
	}
	command := append([]string{tools.VM, "run", "/site"}, tools.TunnelArgs(tunnels, o.AllowPrivate)...)
	if o.RecordReads != "" {
		// The container runs as nobody: it writes to a file made here, open to it
		record, err := filepath.Abs(o.RecordReads)
		if err != nil {
			return err
		}
		if err := os.WriteFile(record, []byte(`{"boot":[],"exercise":{}}`), 0o666); err != nil {
			return err
		}
		if err := os.Chmod(record, 0o666); err != nil {
			return err
		}
		args = append(args, "-v", record+":/record/reads.json")
		command = append(command, "--record-reads", "/record/reads.json")
	}

	// The container runs unprivileged, so it listens on high ports and forwards each to its guest port
	for i, spec := range o.Publish {
		p, err := ParsePort(spec)
		if err != nil {
			return err
		}
		if hostNetwork {
			// Sharing the host's network: listen on the host port itself
			command = append(command, "--forward", fmt.Sprintf("%s:%d:%d", p.IP, p.Host, p.Guest))
		} else {
			inner := 20000 + i
			args = append(args, "-p", fmt.Sprintf("%s:%d:%d", p.IP, p.Host, inner))
			command = append(command, "--forward", fmt.Sprintf("%d:%d", inner, p.Guest))
		}
		fmt.Fprintf(os.Stderr, "forwarding %s:%d to the guest's port %d\n", p.IP, p.Host, p.Guest)
	}

	// A pooled site keeps its blobs in the directory next to it
	if _, err := os.Stat(filepath.Join(site, "system", "filesystem")); err != nil {
		blobs := filepath.Join(filepath.Dir(site), "blobs")
		if _, err := os.Stat(blobs); err != nil {
			return fmt.Errorf("%s has neither system/filesystem nor a pooled ../blobs", o.Site)
		}
		args = append(args, "-v", blobs+":/blobs:ro")
		command = append(command, "--blobs", "/blobs")
	}
	if o.Name != "" {
		args = append(args, "--name", o.Name)
	}

	if o.Detach {
		if o.Name == "" {
			return fmt.Errorf("a detached instance needs --name, to exec into it later")
		}
		args = append(append(args, "--detach", t.Tag()), append(command, "--detached")...)
		if _, err := docker.Output(args...); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "%s is restoring in the background.\n  snowglobe exec %s '<command>'\n  snowglobe attach %s\n  snowglobe stop %s\n",
			o.Name, o.Name, o.Name, o.Name)
		return nil
	}

	args = append(args, "--interactive")
	if isTerminal(os.Stdin) && isTerminal(os.Stdout) {
		args = append(args, "--tty")
	}
	return docker.Attached(append(append(args, t.Tag()), command...)...)
}

// Exec types one command into a running instance and prints what it printed.
func Exec(name string, command []string) error {
	if st, _, ok := loadNative(name); ok {
		return execNative(st, command)
	}
	if !inContainer(name) {
		return fmt.Errorf("no instance called %s (snowglobe ps lists them)", name)
	}
	return docker.Attached(append([]string{"exec", "--interactive", name, tools.VM, "exec"}, command...)...)
}

// Attach joins a running instance's session; ctrl-] detaches.
func Attach(name string) error {
	if st, _, ok := loadNative(name); ok {
		return attachNative(st)
	}
	if !inContainer(name) {
		return fmt.Errorf("no instance called %s (snowglobe ps lists them)", name)
	}
	args := []string{"exec", "--interactive"}
	if isTerminal(os.Stdin) {
		args = append(args, "--tty")
	}
	return docker.Attached(append(args, name, tools.VM, "attach")...)
}

// Stop throws an instance away.
func Stop(name string) error {
	if st, dir, ok := loadNative(name); ok {
		return stopNative(st, dir)
	}
	if !inContainer(name) {
		return fmt.Errorf("no instance called %s (snowglobe ps lists them)", name)
	}
	_, err := docker.Output("rm", "--force", name)
	return err
}

// inContainer says whether name is an instance running in a container.
func inContainer(name string) bool {
	if !native.DockerAvailable() {
		return false
	}
	out, err := docker.Output("ps", "--filter", "label="+label, "--filter", "name=^"+name+"$", "--format", "{{.Names}}")
	return err == nil && strings.TrimSpace(out) == name
}

// List prints the running instances.
func List() error {
	n, err := listNative()
	if err != nil {
		return err
	}
	if native.DockerAvailable() {
		out, err := docker.Output("ps", "--filter", "label="+label, "--format",
			`{{.Names}}\t{{.Label "`+label+`"}}\t{{.RunningFor}}`)
		if err == nil && out != "" {
			if n == 0 {
				fmt.Println("NAME\tSITE\tSTARTED\tRUNTIME")
			}
			for _, line := range strings.Split(out, "\n") {
				fmt.Println(line + "\tcontainer")
				n++
			}
		}
	}
	if n == 0 {
		fmt.Println("no instances running")
	}
	return nil
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
