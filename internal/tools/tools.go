// Package tools manages the build container: snowglobe-vm (the armless arm64 machine, to boot
// the guest, snapshot it and run built sites) and the browser runtime copied into every site.
// It runs on the host's native architecture.
package tools

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/filipecabaco/snowglobe/internal/docker"
	"github.com/filipecabaco/snowglobe/internal/native"
	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

//go:embed Dockerfile runtime/Cargo.toml runtime/Cargo.lock runtime/src
var context embed.FS

// Registry is where releases publish the tools image, tagged with its Version. Setting
// SNOWGLOBE_TOOLS_BUILD always builds it locally instead.
const Registry = "ghcr.io/filipecabaco/snowglobe-tools"

// VM is snowglobe-vm's path in the image.
const VM = "/tools/snowglobe-vm"

// Image is a built tools image.
type Image struct{ tag string }

// Tag is the image reference, for running it directly.
func (i *Image) Tag() string { return i.tag }

// Build builds (or reuses from Docker's cache) the tools image for this snowglobe version.
func Build(version string) (*Image, error) {
	// Named after what goes into it, so an image already there (built earlier, or loaded from
	// a CI artifact) is used as is: building it compiles snowglobe-vm, which takes minutes
	tag := "snowglobe-tools:" + Version()
	if _, err := docker.Output("image", "inspect", "--format", "{{.Id}}", tag); err == nil {
		return &Image{tag: tag}, nil
	}

	// Releases publish it under the same name, for amd64 and arm64: pulling takes seconds. A
	// version that was never published (a change to the image not yet released) builds it here
	published := Registry + ":" + Version()
	if os.Getenv("SNOWGLOBE_TOOLS_BUILD") == "" {
		if _, err := docker.Output("pull", "--quiet", published); err == nil {
			if _, err := docker.Output("tag", published, tag); err == nil {
				return &Image{tag: tag}, nil
			}
		}
	}

	dir, err := os.MkdirTemp("", "snowglobe-tools-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	err = fs.WalkDir(context, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == "." {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dir, path), 0o755)
		}
		data, err := context.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, path), data, 0o644)
	})
	if err != nil {
		return nil, err
	}

	// Quiet unless it fails: `snowglobe run` keeps stdout for the session
	if _, err := docker.Output("build", "--quiet", "--tag", tag, dir); err != nil {
		return nil, err
	}
	return &Image{tag: tag}, nil
}

// CopySite copies the browser runtime (armless, xterm.js) into out. build.pruneRuntime then
// drops the machine build the site doesn't load.
func (i *Image) CopySite(out string) error {
	if err := i.run(out, nil, "cp", "-R", "/tools/site/.", "/out/"); err != nil {
		return err
	}
	file := filepath.Join(out, "armless", "armless.js")
	source, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	patched, err := snapshotMemoryHeadroom(source)
	if err != nil {
		return err
	}
	return os.WriteFile(file, patched, 0o644)
}

// FetchSite writes what CopySite copies out of the image (armless's browser runtime and xterm.js)
// into out without Docker: downloaded from where the tools image's Dockerfile gets them, checked
// against the checksums it pins, and kept in the user cache.
func FetchSite(out string) error {
	df, err := context.ReadFile("Dockerfile")
	if err != nil {
		return err
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	sources := map[string]string{} // file name -> local copy
	// Instructions, with their continuation lines joined
	joined := strings.ReplaceAll(string(df), "\\\n", " ")
	for _, line := range strings.Split(joined, "\n") {
		line = strings.TrimSpace(line)
		rest, ok := strings.CutPrefix(line, "ADD --checksum=sha256:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 2 {
			continue
		}
		sum, url := fields[0], fields[1]
		name := url[strings.LastIndex(url, "/")+1:]
		local := filepath.Join(cache, "snowglobe", "site", sum[:16]+"-"+name)
		if _, err := os.Stat(local); err != nil {
			if err := native.Download(url, local); err != nil {
				return err
			}
		}
		data, err := os.ReadFile(local)
		if err != nil {
			return err
		}
		if got := sha256.Sum256(data); hex.EncodeToString(got[:]) != sum {
			os.Remove(local)
			return fmt.Errorf("%s: checksum mismatch", url)
		}
		sources[name] = local
	}
	// Where each archive member goes, as the Dockerfile copies them
	want := map[string]map[string]string{
		"armless-web.tar.gz": {"armless-web/armless.js": "armless/armless.js", "armless-web/armless.wasm": "armless/armless.wasm",
			"armless-web/armless-smp.wasm": "armless/armless-smp.wasm", "armless-web/LICENSE": "armless/LICENSE"},
		"xterm-6.0.0.tgz":      {"package/lib/xterm.js": "xterm/xterm.js", "package/css/xterm.css": "xterm/xterm.css"},
		"addon-fit-0.11.0.tgz": {"package/lib/addon-fit.js": "xterm/addon-fit.js"},
	}
	for archive, members := range want {
		local, ok := sources[archive]
		if !ok {
			return fmt.Errorf("the tools Dockerfile doesn't fetch %s any more: update FetchSite", archive)
		}
		if err := extractMembers(local, members, out); err != nil {
			return fmt.Errorf("%s: %w", archive, err)
		}
	}
	file := filepath.Join(out, "armless", "armless.js")
	source, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	patched, err := snapshotMemoryHeadroom(source)
	if err != nil {
		return err
	}
	return os.WriteFile(file, patched, 0o644)
}

func extractMembers(archive string, members map[string]string, out string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	found := 0
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		dest, ok := members[strings.TrimPrefix(h.Name, "./")]
		if !ok {
			continue
		}
		p := filepath.Join(out, filepath.FromSlash(dest))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		w, err := os.Create(p)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, tr)
		w.Close()
		if err != nil {
			return err
		}
		found++
	}
	if found != len(members) {
		return fmt.Errorf("found %d of its %d files", found, len(members))
	}
	return nil
}

// armless (v0.2.6 to v0.3.0) reserves only RAM+1 GiB for SMP. A live snapshot also allocates serialized
// filesystem metadata and a growing RAM buffer; Supabase can exceed that limit during capture.
// Raise the maximum, not the initial allocation, while retaining wasm32's 4 GiB hard ceiling.
// Guard the pinned source shape so a runtime upgrade requires deliberate re-evaluation.
func snapshotMemoryHeadroom(source []byte) ([]byte, error) {
	const old = "Math.ceil((o.memory_mb + 1024) * 16)"
	if strings.Count(string(source), old) != 1 {
		return nil, fmt.Errorf("armless snapshot memory adaptation: unexpected pinned runtime")
	}
	return []byte(strings.Replace(string(source), old, "Math.ceil((o.memory_mb * 3 + 1024) * 16)", 1)), nil
}

// The console size the guest boots and is snapshotted with. The page replays the snapshot's
// screen at this size before fitting the terminal to the window, so full-screen apps and line
// editors find the screen exactly as they left it, then get a resize like any other.
const (
	ConsoleCols = 90
	ConsoleRows = 30
)

// ExtractVM copies the image's snowglobe-vm (Linux, for the image's architecture) to dest.
func (i *Image) ExtractVM(dest string) error {
	id, err := docker.Output("create", i.tag)
	if err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	defer docker.Quiet("rm", id)
	return docker.Quiet("cp", id+":"+VM, dest)
}

// NativeSource is the tools image as a source of snowglobe-vm for running natively on Linux
// (built or pulled when first needed); nil without Docker.
func NativeSource(version string) *native.Image {
	if !native.DockerAvailable() {
		return nil
	}
	return &native.Image{Key: Version(), Extract: func(dest string) error {
		t, err := Build(version)
		if err != nil {
			return err
		}
		return t.ExtractVM(dest)
	}}
}

// Snapshot boots <out>/system and writes the state, console replay and reads.json there.
//
// After the snapshot it types each exercise command into the app and records what it reads.
func (i *Image) Snapshot(out string, memoryMB int, ready string, exercises []string, network string,
	tunnels []tunnel.Tunnel, allowPrivate bool, cpus, buildCPUs int, sandbox bool) error {
	args := append([]string{VM}, SnapshotArgs("/out/system", memoryMB, ready, exercises, network, tunnels, allowPrivate, cpus, buildCPUs, sandbox)...)
	var extra []string
	if network != "none" {
		extra = NetworkArgs()
	}
	return i.run(out, extra, args...)
}

// ExitBootStalled is snowglobe-vm snapshot's exit status for a boot that stalled: nothing
// printed, fetched or computed for minutes before the app was ready. It printed its CPUs' state;
// booting again is worth one try.
const ExitBootStalled = 75

// SnapshotArgs are snowglobe-vm's arguments to boot the site's system directory and snapshot it,
// in the tools container or natively.
func SnapshotArgs(system string, memoryMB int, ready string, exercises []string, network string,
	tunnels []tunnel.Tunnel, allowPrivate bool, cpus, buildCPUs int, sandbox bool) []string {
	args := []string{"snapshot", system,
		"--memory", fmt.Sprint(memoryMB), "--network", network,
		"--cpus", fmt.Sprint(cpus), "--build-cpus", fmt.Sprint(buildCPUs),
		"--cols", fmt.Sprint(ConsoleCols), "--rows", fmt.Sprint(ConsoleRows)}
	if ready != "" {
		args = append(args, "--ready", ready)
	}
	if sandbox {
		args = append(args, "--sandbox")
	}
	for _, e := range exercises {
		args = append(args, "--exercise", e)
	}
	return append(args, TunnelArgs(tunnels, allowPrivate)...)
}

// run executes a command in the tools image with out mounted at /out, as the current user so
// files written there aren't owned by root on Linux.
func (i *Image) run(out string, extra []string, command ...string) error {
	args := []string{"run", "--rm", "--user", fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()),
		"-v", out + ":/out"}
	if v := os.Getenv("SNOWGLOBE_BOOT_STALL_SECS"); v != "" {
		args = append(args, "-e", "SNOWGLOBE_BOOT_STALL_SECS="+v)
	}
	args = append(append(append(args, JITArgs()...), extra...), i.tag)
	return docker.Run(append(args, command...)...)
}

// JITArgs pass the host's ARMLESS_JIT to the container: snowglobe-vm compiles hot guest code
// to host code unless it is "off".
func JITArgs() []string {
	if v := os.Getenv("ARMLESS_JIT"); v != "" {
		return []string{"-e", "ARMLESS_JIT=" + v}
	}
	return nil
}

// TunnelArgs are snowglobe-vm's flags for the guest's tunnels, and for reaching private addresses.
func TunnelArgs(tunnels []tunnel.Tunnel, allowPrivate bool) []string {
	var args []string
	for _, t := range tunnels {
		dest := strconv.Itoa(t.Port)
		if t.Host != "" {
			dest = t.Host + ":" + dest
		}
		args = append(args, "--tunnel", dest+"="+t.URL)
	}
	if allowPrivate {
		args = append(args, "--allow-private")
	}
	return args
}

var proxyVars = []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
	"NO_PROXY", "no_proxy"}

// NetworkArgs are the `docker run` arguments that let a guest with a network out the way the
// host goes out: the host's proxy settings and CA bundle (sandboxes often only allow HTTPS
// through a TLS-intercepting proxy). A proxy on the host's loopback is only reachable from the
// host's network namespace, so then the container shares it; the guest itself still can't reach
// private addresses (armless refuses them).
func NetworkArgs() []string {
	var args []string
	hostNet := false
	for _, v := range proxyVars {
		value := os.Getenv(v)
		if value == "" {
			continue
		}
		args = append(args, "-e", v+"="+value)
		if !strings.HasPrefix(strings.ToLower(v), "no_") && loopback(value) {
			hostNet = true
		}
	}
	if hostNet {
		args = append(args, "--network", "host")
	}
	if ca := os.Getenv("SSL_CERT_FILE"); ca != "" {
		if abs, err := filepath.Abs(ca); err == nil {
			if _, err := os.Stat(abs); err == nil {
				args = append(args, "-v", abs+":/etc/snowglobe/ca-bundle.pem:ro", "-e", "SSL_CERT_FILE=/etc/snowglobe/ca-bundle.pem")
			}
		}
	}
	return args
}

func loopback(proxy string) bool {
	if !strings.Contains(proxy, "://") {
		proxy = "http://" + proxy
	}
	u, err := url.Parse(proxy)
	if err != nil {
		return false
	}
	h := u.Hostname()
	return h == "localhost" || strings.HasPrefix(h, "127.") || h == "::1"
}

// Version identifies the tools image: a hash of the files it is built from.
func Version() string {
	h := sha256.New()
	fs.WalkDir(context, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, _ := context.ReadFile(path)
		fmt.Fprintf(h, "%s %d\n", path, len(data))
		h.Write(data)
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:16]
}
