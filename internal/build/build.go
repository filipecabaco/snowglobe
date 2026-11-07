// Package build turns a Docker image into a static site that runs it in the browser:
// source image -> boot layer -> 9p filesystem -> page -> snapshot -> warm pack.
package build

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/boot"
	"github.com/filipecabaco/snowglobe/internal/docker"
	"github.com/filipecabaco/snowglobe/internal/lifeline"
	"github.com/filipecabaco/snowglobe/internal/native"
	"github.com/filipecabaco/snowglobe/internal/oci"
	"github.com/filipecabaco/snowglobe/internal/rootfs"
	"github.com/filipecabaco/snowglobe/internal/sandboxca"
	"github.com/filipecabaco/snowglobe/internal/site"
	"github.com/filipecabaco/snowglobe/internal/tools"
	"github.com/filipecabaco/snowglobe/internal/tunnel"
)

const (
	sourceTag = "snowglobe-source"
	marker    = ".snowglobe"
	// Image labels that let a Dockerfile describe its own snowglobe settings
	labelPrefix = "snowglobe."
)

// Options are the user's choices; empty fields fall back to image labels, then defaults.
type Options struct {
	Source   string // a directory with a Dockerfile, or an image reference
	Out      string
	Title    string
	Cmd      string
	Ready    string
	Memory   int
	Warm     string
	Exercise []string
	Network  string
	// Tunnels are guest TCP destinations carried over WebSockets, "[HOST:]PORT=URL"
	Tunnels []string
	// TunnelToken answers a GET with an access token for tunnel URLs with {token} in them
	TunnelToken string
	// AllowPrivate lets the build's snapshot reach loopback and private addresses (a tunnel
	// endpoint or service on this machine); the page is unaffected
	AllowPrivate bool
	CPUs         int // default 1
	// BuildCPUs boots and warms the guest on more CPUs than it ships with; the snapshot keeps
	// CPUs. Default: max(CPUs, DefaultBuildCPUs)
	BuildCPUs int
	// NoChunks keeps every guest file in one blob, however large: the filesystem format armless
	// 0.2.x reads. By default files of 2 MiB and more are stored in content-defined chunks.
	NoChunks bool
	// Sandbox snapshots for running natively (snowglobe run, a bundle) rather than in a page:
	// the guest keeps its file cache, and exercises run before the snapshot instead of after
	Sandbox bool
	// Builder is "docker" (the default: Docker builds and exports the image, the tools image
	// boots and snapshots it) or "native" (no Docker: the image comes from its registry or an
	// archive, the boot layer is written rather than built, and snowglobe-vm runs here). Native
	// takes an image reference or archive, not a Dockerfile
	Builder string
	// Agent lets an agent run commands in the page's machine: window.snowglobeAgent, and WebMCP
	// tools where the browser has WebMCP. Off unless asked for (or the label snowglobe.agent=true)
	Agent bool
	// AgentExposedTo is the origins, beyond the page's own, its WebMCP tools are shared with
	AgentExposedTo []string
}

// Settings are the resolved values a build runs with.
type Settings struct {
	Title       string
	Command     string
	Ready       string
	Memory      int
	Warm        *regexp.Regexp
	Exercise    []string
	Network     string
	Tunnels     []tunnel.Tunnel
	TunnelToken string
	CPUs        int
	BuildCPUs   int
	Console     boot.Console
	// Agent and AgentExposedTo: as in Options
	Agent          bool
	AgentExposedTo []string
	// AgentPurpose and AgentSample (labels snowglobe.agent-purpose and snowglobe.agent-sample): what the
	// machine is good for, in a line, and a command to try in it, as the agent page lists them
	AgentPurpose, AgentSample string
	// AgentWatch (label snowglobe.agent-watch): a project directory in the machine; the agent page
	// shows which files in it each command changed, with their diffs
	AgentWatch string
}

// The guest is 64-bit ARM: the armless machine
const (
	platform = "linux/arm64"
	// MaxCPUs is the most CPUs a guest can have (armless's limit)
	MaxCPUs = 8
	// DefaultBuildCPUs is how many CPUs a guest boots on at build time, so a one-CPU site boots
	// as fast as a four-CPU one; the extra CPUs go offline before the snapshot
	DefaultBuildCPUs = 4
)

// Run builds the site.
func Run(o Options, version string) error {
	out, err := filepath.Abs(o.Out)
	if err != nil {
		return err
	}
	if err := prepareOut(out); err != nil {
		return err
	}

	builder := o.Builder
	if builder == "" {
		builder = "docker"
		if !native.DockerAvailable() && !isDockerfileDir(o.Source) {
			fmt.Println("    no Docker here: building natively (--builder native)")
			builder = "native"
		}
	}
	if builder != "docker" && builder != "native" {
		return fmt.Errorf("--builder %s: docker or native", builder)
	}
	nativeBuild := builder == "native"

	var t *tools.Image
	var vm string
	var source *oci.Image
	var img *docker.Image
	tmp, err := os.MkdirTemp("", "snowglobe-build-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if nativeBuild {
		if isDockerfileDir(o.Source) {
			return fmt.Errorf("%s is a Dockerfile: --builder native takes an image reference or an image archive "+
				"(docker save, or an OCI layout); build the Dockerfile with --builder docker", o.Source)
		}
		if err := step("Find snowglobe-vm", func() (err error) {
			vm, err = native.VM(version, nil)
			if err == nil {
				fmt.Printf("    %s\n", vm)
			}
			return
		}); err != nil {
			return err
		}
		if err := step("Fetch source image", func() (err error) {
			if st, e := os.Stat(o.Source); e == nil && !st.IsDir() {
				source, err = oci.FromArchive(o.Source, filepath.Join(tmp, "archive"))
			} else {
				source, err = oci.Pull(o.Source)
			}
			if err == nil {
				fmt.Printf("    %d layers\n", len(source.Layers))
			}
			return
		}); err != nil {
			return err
		}
		img = &source.Config
	} else {
		if err := step("Build tools image", func() (err error) { t, err = tools.Build(version); return }); err != nil {
			return err
		}
		if err := step("Resolve source image", func() error { return resolveSource(o.Source, platform) }); err != nil {
			return err
		}
		// From here on as a native build does: the boot layer is files added to the image's
		// layers, not an image built on it, so nothing runs in it and the guest boots with
		// BusyBox's init rather than OpenRC
		if err := step("Save source image", func() error {
			return docker.Stream(func(r io.Reader) (err error) {
				source, err = oci.FromTar(r, sourceTag, filepath.Join(tmp, "archive"))
				return
			}, "save", sourceTag)
		}); err != nil {
			return err
		}
		img = &source.Config
	}
	if img.Architecture != "arm64" {
		return fmt.Errorf("%s is %s, not arm64: build it FROM a multi-arch or arm64 Alpine image (e.g. alpine or arm64v8/alpine)",
			o.Source, img.Architecture)
	}
	s, err := Resolve(o, img)
	if err != nil {
		return err
	}
	fmt.Printf("    command: %s\n    ready:   %s\n    memory:  %d MB\n    network: %s\n    cpus:    %d (booted on %d)\n",
		s.Command, describeReady(s.Ready), s.Memory, s.Network, s.CPUs, s.BuildCPUs)
	for _, t := range s.Tunnels {
		fmt.Printf("    tunnel:  %s:%d -> %s\n", first(t.Host, "*"), t.Port, t.URL)
	}

	// With networking on, the page terminates the guest's HTTPS with certificates from a CA
	// made for this build
	var ca *sandboxca.CA
	if s.Network != "none" {
		if ca, err = sandboxca.New(); err != nil {
			return err
		}
	}
	var caPEM []byte
	if ca != nil {
		caPEM = ca.CertPEM
	}
	if err := step("Add boot layer", func() error {
		// Written, not built: the kernel archive, then BusyBox's init configured for the app
		kernel, err := boot.Kernel(version)
		if err != nil {
			return err
		}
		source.Layers = append(source.Layers, oci.TarGzLayer(kernel), oci.FilesLayer(boot.Files(s.Console, s.Network, caPEM)))
		return nil
	}); err != nil {
		return err
	}

	var fs *rootfs.Result
	if err := step("Convert to a 9p filesystem", func() (err error) {
		fs, err = flattenRootfs(source, filepath.Join(out, "system"), o.NoChunks)
		if err == nil {
			fmt.Printf("    %d entries, %d MB uncompressed, %d unique files\n", fs.Entries, fs.TotalSize>>20, len(fs.Blobs))
		}
		return
	}); err != nil {
		return err
	}

	if err := step("Assemble page", func() error {
		copySite := func() error { return tools.FetchSite(out) }
		if !nativeBuild {
			copySite = func() error { return t.CopySite(out) }
		}
		if err := copySite(); err != nil {
			return err
		}
		if err := pruneRuntime(out, s.CPUs); err != nil {
			return err
		}
		if ca != nil {
			if err := ca.WritePage(filepath.Join(out, "system", "tls.json")); err != nil {
				return err
			}
		}
		return nil // the final page fingerprints the snapshot once it exists
	}); err != nil {
		return err
	}

	if err := step("Boot and snapshot", func() error {
		snapshot := func() error {
			// The snapshot opens its tunnels natively: one token for the whole boot, fetched
			// for each, so a boot again after a stall doesn't start on a token minutes old
			tunnels, err := tunnel.Fill(s.Tunnels, s.TunnelToken)
			if err != nil {
				return err
			}
			if nativeBuild {
				cmd := exec.Command(vm, tools.SnapshotArgs(filepath.Join(out, "system"), s.Memory, s.Ready, s.Exercise,
					s.Network, tunnels, o.AllowPrivate, s.CPUs, s.BuildCPUs, o.Sandbox)...)
				cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
				// It ends with this build, however the build ends (a SIGTERM, a kill -9, the
				// daemon that started the build stopping): never left booting on its own
				if err := lifeline.Pass(cmd); err != nil {
					return err
				}
				return cmd.Run()
			}
			return t.Snapshot(out, s.Memory, s.Ready, s.Exercise, s.Network, tunnels, o.AllowPrivate, s.CPUs, s.BuildCPUs, o.Sandbox)
		}
		return retryStalled(snapshot, os.Stderr)
	}); err != nil {
		return err
	}

	return step("Write warm pack", func() error {
		readsFile := filepath.Join(out, "system", "reads.json")
		reads, err := rootfs.ReadReads(readsFile)
		if err != nil {
			return err
		}
		os.Remove(readsFile)

		files, bytes, err := rootfs.WriteWarmPack(fs, rootfs.WarmSelection{Reads: reads.All(), Match: s.Warm}, filepath.Join(out, "system"))
		if err != nil {
			return err
		}
		fmt.Printf("    warm.pack: %d files, %.1f MB\n", files, float64(bytes)/(1<<20))

		report := rootfs.BuildReport(fs, reads, s.Exercise, s.Warm, blobSize(fs))
		printReport(report, s.Exercise)
		data, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(out, "warm-report.json"), data, 0o644); err != nil {
			return err
		}
		if err := writeRunInfo(out, o, s, fs, files, bytes, version); err != nil {
			return err
		}
		return site.Render(out, Page(s, version))
	})
}

// Page is the page a build with these settings renders.
func Page(s *Settings, version string) site.Page {
	return site.Page{Title: s.Title, MemoryMB: s.Memory, Network: s.Network, CPUs: s.CPUs,
		Tunnels: s.Tunnels, TunnelToken: s.TunnelToken, ConsoleCols: tools.ConsoleCols, ConsoleRows: tools.ConsoleRows,
		Agent: s.Agent, AgentExposedTo: s.AgentExposedTo, Version: version}
}

// RunInfo is what a site says about itself: the measured facts of its build, for pages that
// present several runs (snowglobe's own demo index reads it).
type RunInfo struct {
	Title         string          `json:"title"`
	Source        string          `json:"source"`
	Command       string          `json:"command"`
	Ready         string          `json:"ready,omitempty"`    // what the snapshot waited for
	Exercise      []string        `json:"exercise,omitempty"` // typed in after it (bench/ replays them)
	MemoryMB      int             `json:"memory_mb"`
	Network       string          `json:"network"`
	Tunnels       []tunnel.Tunnel `json:"tunnels,omitempty"`
	TunnelToken   string          `json:"tunnel_token,omitempty"`
	Arch          string          `json:"arch"` // always arm64
	CPUs          int             `json:"cpus"`
	BuildCPUs     int             `json:"build_cpus"`
	BootSeconds   float64         `json:"boot_seconds"`
	SnapshotBytes int64           `json:"snapshot_bytes"`
	StateBytes    int64           `json:"state_bytes"`
	WarmPackFiles int             `json:"warm_pack_files"`
	WarmPackBytes int64           `json:"warm_pack_bytes"`
	Files         int             `json:"files"`
	BlobBytes     int64           `json:"blob_bytes"`
	BuiltAt       time.Time       `json:"built_at"`
	Snowglobe     string          `json:"snowglobe"`
	HasTranscript bool            `json:"has_transcript"`
	// Agent: the site is one of the agent page's machines (built with --agent)
	Agent *AgentInfo `json:"agent,omitempty"`
}

// AgentInfo is what the agent page (snowglobe agent-pages) lists a machine with
type AgentInfo struct {
	Purpose   string   `json:"purpose,omitempty"`
	Sample    string   `json:"sample,omitempty"`
	Watch     string   `json:"watch,omitempty"`
	ExposedTo []string `json:"exposed_to,omitempty"`
}

// writeRunInfo writes run.json and moves the exercise transcript next to it
func writeRunInfo(out string, o Options, s *Settings, fs *rootfs.Result, packFiles int, packBytes int64, version string) error {
	system := filepath.Join(out, "system")
	var meta struct {
		BootSeconds   float64 `json:"bootSeconds"`
		StateBytes    int64   `json:"stateBytes"`
		SnapshotBytes int64   `json:"snapshotBytes"`
	}
	if data, err := os.ReadFile(filepath.Join(system, "run-meta.json")); err == nil {
		json.Unmarshal(data, &meta)
		os.Remove(filepath.Join(system, "run-meta.json"))
	}

	info := RunInfo{
		Title: s.Title, Source: o.Source, Command: s.Command, Ready: s.Ready, Exercise: s.Exercise,
		MemoryMB: s.Memory, Network: s.Network,
		Tunnels: s.Tunnels, TunnelToken: s.TunnelToken,
		Arch: "arm64", CPUs: s.CPUs, BuildCPUs: s.BuildCPUs,
		BootSeconds: meta.BootSeconds, SnapshotBytes: meta.SnapshotBytes, StateBytes: meta.StateBytes,
		WarmPackFiles: packFiles, WarmPackBytes: packBytes, Files: len(fs.Files),
		BuiltAt: time.Now().UTC().Truncate(time.Second), Snowglobe: version,
	}
	if s.Agent {
		info.Agent = &AgentInfo{Purpose: s.AgentPurpose, Sample: s.AgentSample, Watch: s.AgentWatch, ExposedTo: s.AgentExposedTo}
	}
	for _, path := range fs.Blobs {
		if st, err := os.Stat(path); err == nil {
			info.BlobBytes += st.Size()
		}
	}
	if err := os.Rename(filepath.Join(system, "transcript.json"), filepath.Join(out, "transcript.json")); err == nil {
		info.HasTranscript = true
	}

	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "run.json"), data, 0o644)
}

func blobSize(fs *rootfs.Result) func(string) int64 {
	return func(name string) int64 {
		if info, err := os.Stat(fs.Blobs[name]); err == nil {
			return info.Size()
		}
		return 0
	}
}

// printReport shows where each phase's reads come from, biggest directories first
func printReport(r rootfs.Report, order []string) {
	show := func(label string, p rootfs.Phase) {
		fmt.Printf("    %-34s %5d files %8.1f MB\n", label, p.Files, float64(p.Bytes)/(1<<20))
		for i, g := range p.Groups {
			if i == 3 {
				fmt.Printf("      … %d more directories\n", len(p.Groups)-3)
				break
			}
			fmt.Printf("      %-50s %4d %8.1f MB\n", g.Dir, g.Files, float64(g.Bytes)/(1<<20))
		}
	}
	show("read while booting", r.Boot)
	for _, command := range order {
		show("first read by: "+truncate(command, 18), r.Exercise[command])
	}
	if r.Pattern.Files > 0 {
		show("added by the warm pattern", r.Pattern)
	}
	fmt.Printf("    %-34s %5d files %8.1f MB  (fetched on demand)\n", "never read", r.Cold.Files, float64(r.Cold.Bytes)/(1<<20))
}

// truncate shortens s to n characters (runes, as the report's columns count them), the last an
// ellipsis; never a byte slice, which could cut a character in two.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// Resolve merges options, image labels and defaults.
func Resolve(o Options, img *docker.Image) (*Settings, error) {
	labels := img.Config.Labels
	label := func(name string) string { return labels[labelPrefix+name] }

	s := &Settings{
		Title:  first(o.Title, label("title"), o.Source),
		Ready:  first(o.Ready, label("ready")),
		Memory: o.Memory,
	}

	// The ready marker and exercises in the labels describe the image's own command, not one
	// swapped in with --cmd
	s.Exercise = o.Exercise
	if o.Cmd != "" {
		s.Command = o.Cmd
		s.Ready = o.Ready
	} else {
		s.Command = boot.Join(append(append([]string{}, img.Config.Entrypoint...), img.Config.Cmd...))
		if len(s.Exercise) == 0 && label("exercise") != "" {
			if err := json.Unmarshal([]byte(label("exercise")), &s.Exercise); err != nil {
				return nil, fmt.Errorf("label %sexercise must be a JSON array of commands: %w", labelPrefix, err)
			}
		}
	}
	if s.Command == "" {
		return nil, errors.New("the image has no ENTRYPOINT or CMD; pass --cmd")
	}

	if s.Memory == 0 {
		if m := label("memory"); m != "" {
			n, err := strconv.Atoi(m)
			if err != nil {
				return nil, fmt.Errorf("label %smemory: %q is not a number of MB", labelPrefix, m)
			}
			s.Memory = n
		} else {
			s.Memory = 512
		}
	}
	if s.Memory < 1 {
		return nil, fmt.Errorf("memory %d: a number of MB", s.Memory)
	}

	// Networking is opt-in: "fetch" turns the guest's HTTP requests into the browser's fetch()
	s.Network = first(o.Network, label("network"), "none")
	if s.Network != "none" && s.Network != "fetch" {
		return nil, fmt.Errorf("network %q: use none or fetch", s.Network)
	}

	// Raw TCP the browser can't make, carried over WebSockets: only with a network
	specs := o.Tunnels
	if len(specs) == 0 && label("tunnels") != "" {
		if err := json.Unmarshal([]byte(label("tunnels")), &specs); err != nil {
			return nil, fmt.Errorf("label %stunnels must be a JSON array of [HOST:]PORT=URL: %w", labelPrefix, err)
		}
	}
	var err error
	if s.Tunnels, err = tunnel.ParseAll(specs); err != nil {
		return nil, err
	}
	if len(s.Tunnels) > 0 && s.Network != "fetch" {
		return nil, errors.New("tunnels need a guest with a network: build with --network fetch")
	}
	s.TunnelToken = first(o.TunnelToken, label("tunnel-token"))
	if tunnel.NeedsToken(s.Tunnels) && s.TunnelToken == "" {
		return nil, fmt.Errorf("a tunnel URL has %s: name its token endpoint with --tunnel-token", tunnel.Placeholder)
	}

	s.CPUs = o.CPUs
	if s.CPUs == 0 {
		if c := label("cpus"); c != "" {
			n, err := strconv.Atoi(c)
			if err != nil {
				return nil, fmt.Errorf("label %scpus: %q is not a number", labelPrefix, c)
			}
			s.CPUs = n
		} else {
			s.CPUs = 1
		}
	}
	if s.CPUs < 1 || s.CPUs > MaxCPUs {
		return nil, fmt.Errorf("cpus %d: use 1 to %d", s.CPUs, MaxCPUs)
	}

	s.BuildCPUs = o.BuildCPUs
	if s.BuildCPUs == 0 {
		if c := label("build-cpus"); c != "" {
			n, err := strconv.Atoi(c)
			if err != nil {
				return nil, fmt.Errorf("label %sbuild-cpus: %q is not a number", labelPrefix, c)
			}
			s.BuildCPUs = n
		} else {
			s.BuildCPUs = max(s.CPUs, DefaultBuildCPUs)
		}
	}
	if s.BuildCPUs < s.CPUs || s.BuildCPUs > MaxCPUs {
		return nil, fmt.Errorf("build-cpus %d: use %d (the cpus) to %d", s.BuildCPUs, s.CPUs, MaxCPUs)
	}

	if w := first(o.Warm, label("warm")); w != "" {
		re, err := regexp.Compile(w)
		if err != nil {
			return nil, fmt.Errorf("warm pattern: %w", err)
		}
		s.Warm = re
	}

	// Agent jobs: opt-in (on several CPUs, they need a cross-origin isolated page, which the agent
	// page and the site's own are)
	s.Agent = o.Agent
	if !s.Agent && label("agent") != "" {
		b, err := strconv.ParseBool(label("agent"))
		if err != nil {
			return nil, fmt.Errorf("label %sagent: %q is not true or false", labelPrefix, label("agent"))
		}
		s.Agent = b
	}
	s.AgentExposedTo = o.AgentExposedTo
	if len(s.AgentExposedTo) == 0 && label("agent-exposed-to") != "" {
		if err := json.Unmarshal([]byte(label("agent-exposed-to")), &s.AgentExposedTo); err != nil {
			return nil, fmt.Errorf("label %sagent-exposed-to must be a JSON array of origins: %w", labelPrefix, err)
		}
	}
	for _, origin := range s.AgentExposedTo {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("agent-exposed-to %q: an origin, https://host[:port]", origin)
		}
	}
	if len(s.AgentExposedTo) > 0 && !s.Agent {
		return nil, errors.New("agent-exposed-to needs --agent")
	}
	s.AgentPurpose, s.AgentSample = label("agent-purpose"), label("agent-sample")
	if s.AgentWatch = label("agent-watch"); s.AgentWatch != "" && (!strings.HasPrefix(s.AgentWatch, "/") || strings.ContainsAny(s.AgentWatch, "\x00\n\r")) {
		return nil, fmt.Errorf("label %sagent-watch must be an absolute directory in the machine, on one line", labelPrefix)
	}

	s.Console = boot.Console{Env: img.Config.Env, Workdir: img.Config.WorkingDir, Command: s.Command}
	return s, nil
}

func isDockerfileDir(source string) bool {
	_, err := os.Stat(filepath.Join(source, "Dockerfile"))
	return err == nil
}

// flattenRootfs streams the image's flattened layers (the boot layer among them) straight into
// the converter.
func flattenRootfs(img *oci.Image, systemDir string, noChunks bool) (*rootfs.Result, error) {
	tmp, err := os.MkdirTemp("", "snowglobe-layers-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(oci.Flatten(img.Layers, tmp, pw)) }()
	res, err := rootfs.Convert(pr, systemDir, rootfs.Options{NoChunks: noChunks})
	pr.CloseWithError(err)
	return res, err
}

func resolveSource(source, platform string) error {
	if isDockerfileDir(source) {
		return docker.Run("build", "--platform", platform, "--tag", sourceTag, source)
	}
	if err := docker.Run("pull", "--platform", platform, source); err != nil {
		return err
	}
	return docker.Run("tag", source, sourceTag)
}

// pruneRuntime keeps only the machine build this site loads: armless.wasm for one CPU,
// armless-smp.wasm (shared memory, a Web Worker per CPU) for several.
func pruneRuntime(out string, cpus int) error {
	drop := "armless/armless-smp.wasm"
	if cpus > 1 {
		drop = "armless/armless.wasm"
	}
	return os.RemoveAll(filepath.Join(out, drop))
}

// prepareOut only ever deletes a directory snowglobe created, never an arbitrary --out.
func prepareOut(out string) error {
	if entries, err := os.ReadDir(out); err == nil && len(entries) > 0 {
		if _, err := os.Stat(filepath.Join(out, marker)); err != nil {
			return fmt.Errorf("%s exists and wasn't created by snowglobe; pick another --out or empty it", out)
		}
	}
	if err := os.RemoveAll(out); err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, marker), nil, 0o644)
}

func step(name string, fn func() error) error {
	// NO_COLOR (no-color.org): plain text, for logs read elsewhere (the daemon's builds)
	bold, dim, reset := "\033[1m", "\033[2m", "\033[0m"
	if os.Getenv("NO_COLOR") != "" {
		bold, dim, reset = "", "", ""
	}
	fmt.Printf("\n%s==> %s%s\n", bold, name, reset)
	start := time.Now()
	err := fn()
	fmt.Printf("%s    %.1fs%s\n", dim, time.Since(start).Seconds(), reset)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func describeReady(ready string) string {
	if ready == "" {
		return "after 5s of quiet"
	}
	return strconv.Quote(ready)
}

func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// retryStalled runs a boot, and once more if it stalled (tools.ExitBootStalled): a rare stall
// costs one more boot rather than the build, and the stalled one's CPU state stays in the log.
func retryStalled(boot func() error, log io.Writer) error {
	err := boot()
	var x *exec.ExitError
	if errors.As(err, &x) && x.ExitCode() == tools.ExitBootStalled {
		fmt.Fprintln(log, "The boot stalled (its CPUs' state is above, for a bug report); booting again.")
		err = boot()
		if errors.As(err, &x) && x.ExitCode() == tools.ExitBootStalled {
			return fmt.Errorf("the boot stalled twice: is the app waiting for something that never comes " +
				"(--ready text it never prints, a network it can't reach)? Each stall's CPU state is above")
		}
	}
	return err
}
