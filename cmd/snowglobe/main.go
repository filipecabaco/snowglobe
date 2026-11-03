// snowglobe packages a Docker image into a static website that runs it in the browser: the
// image boots on Linux inside armless, a 64-bit ARM machine compiled to WebAssembly, is
// snapshotted once its app is ready, and visitors restore that snapshot in about a second.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	goruntime "runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/boot"
	"github.com/filipecabaco/snowglobe/internal/build"
	"github.com/filipecabaco/snowglobe/internal/bundle"
	"github.com/filipecabaco/snowglobe/internal/instance"
	"github.com/filipecabaco/snowglobe/internal/mcp"
	"github.com/filipecabaco/snowglobe/internal/native"
	"github.com/filipecabaco/snowglobe/internal/pack"
	"github.com/filipecabaco/snowglobe/internal/pool"
	"github.com/filipecabaco/snowglobe/internal/pwa"
	"github.com/filipecabaco/snowglobe/internal/remote"
	"github.com/filipecabaco/snowglobe/internal/serve"
	"github.com/filipecabaco/snowglobe/internal/tools"
)

// Set at release time with -ldflags "-X main.version=..."; `go install ...@v1.2.3` can't pass
// ldflags, so main falls back to the module version Go records in the binary
var version string

func moduleVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

const usage = `snowglobe packages a Docker image into a static website that runs it in the browser.

Usage:
  snowglobe build <dockerfile dir | image> [flags]   build the site
  snowglobe serve [dir] [--port 8000]                preview a built site
  snowglobe pool <dir>                               let every site under dir share one blob
                                                     directory (for hosting several together)
  snowglobe pwa <dir> [--name N] [--short-name N]     make a built site an installable app that works
                                                     offline once it has run (manifest, icons,
                                                     service worker)
  snowglobe pack <dir> [-o site.tar.gz]              pack a built site into one tarball (.tar.gz,
                                                     .tar.zst) to publish on a CDN
  snowglobe bundle <dir | url> [-o FILE]             make the site one executable that runs it with
                     [--target linux|darwin]         no Docker or hypervisor: snowglobe-vm and the
                     [--runtime snowglobe-vm]        site in one file, sandboxed from inside
                                                     (Landlock + seccomp, or Seatbelt). Linux on
                                                     this machine's architecture (the tools
                                                     image's), macOS on Apple silicon (this
                                                     release's), or the snowglobe-vm --runtime
                                                     (or SNOWGLOBE_VM) names
  snowglobe sh <name> [--json] [--timeout S] '<cmd>' run a command on a native instance's shell
                                                     (whatever its app is): its output and exit
                                                     status, or {"exit", "output"} with --json.
                                                     Out of time (300 s), it and everything it
                                                     started are killed (exit 124)
  snowglobe cp <src> <dst>                           copy files or directories in or out of a
                                                     native instance: name:/path on one side
  snowglobe mcp <dir | url> [--name N] [--keep]      serve a site to an agent over MCP (stdio): an
                                                     isolated Linux machine with run_command,
                                                     write_file and read_file tools; no Docker.
                     [--log-dir DIR]                 Logs to the cache's snowglobe/logs/mcp
                                                     (or <name> with --name) unless --log-dir
  snowglobe warm <dir> <reads.json ...>              add the files runs recorded (run
                                                     --record-reads) to the site's warm pack
  snowglobe run [dir | url] [--name N] [--detach]    run a built site, sandboxed: in a container
                [--runtime docker|native]            (docker, the default) or natively with no
                                                     Docker (native: snowglobe-vm sandboxes itself;
                                                     SNOWGLOBE_RUNTIME sets the default):
                                                     a session in a terminal; with stdin piped,
                                                     each line is typed in as a command. The site
                                                     can be a directory, a tarball, a tarball URL
                                                     or a deployed site's URL (fetched and cached
                                                     first; the sandbox stays offline).
                                                     -p 8000:8000 forwards a host port to a guest
                                                     port (127.0.0.1 unless IP:HOST:GUEST); needs a
                                                     site built with --network fetch
                                                     --record-reads FILE writes every file the guest
                                                     reads, for warm (drive it from outside with -p:
                                                     an API's test suite, say)
                                                     --tunnel [HOST:]PORT=URL replaces the site's
                                                     tunnels (a local proxy, say); --allow-private
                                                     lets the guest reach this machine's services
                                                     --max-runtime 30m ends the run after that long
                                                     (exit 124), --stop-file PATH once PATH exists
                                                     (exit 143): the job running in the guest is
                                                     killed, its whole process session; --log-dir
                                                     DIR keeps console.log, serial.log and
                                                     events.jsonl (jobs, how the run ended). A named
                                                     native instance logs to the cache's
                                                     snowglobe/logs/<name>, kept after it stops
                                                     --fork (with --detach --name, native): every
                                                     snowglobe sh on it runs in a fresh copy of the
                                                     restored machine, forked in milliseconds and
                                                     sharing its memory; nothing one command does
                                                     is seen by the next, and sh is all it takes
  snowglobe exec <name> <command>                    type a command into a running instance and
                                                     print what it printed
  snowglobe attach <name>                            join a running instance (ctrl-] detaches)
  snowglobe stop <name>                              throw a running instance away (native: it
                                                     kills its job and logs why it stopped first)
  snowglobe ps                                       list running instances (and the daemon's machines)
  snowglobe daemon [--listen ADDR --token-file F]    the orchestrator: keeps templates and the
                   [--memory 8G] [--wait 30s]
                                                     machines forked from them, with an HTTP/JSON
                                                     API on a Unix socket in the user cache (and
                                                     on ADDR for requests bearing the token). sh,
                                                     cp, exec, attach, stop and ps reach its
                                                     machines through it (SNOWGLOBE_DAEMON points
                                                     at another: http://HOST:PORT, with
                                                     SNOWGLOBE_DAEMON_TOKEN). --memory caps what
                                                     its servers and machines take together: a
                                                     machine that doesn't fit waits --wait for
                                                     room, then is refused
  snowglobe template add <site> [--name T]           restore a site once, for machines to be forked
                     [--max-machines N]              from; template ls lists them, template rm T
                     [--snapshot S] [--idle 30m]     removes one and its machines. --snapshot
                                                     restores a saved machine instead of the site;
                                                     --idle stops its server after that long with
                                                     no machine, and the next use restores it
  snowglobe up <template> [--name N] [-p PORT]...    a machine forked from a template in tens of
                [--label K=V]...                     milliseconds, sharing its memory: it lasts
                                                     until stopped, keeps what it writes, and its
                                                     ports are forwarded (-p 8000 picks a host
                                                     port, -p 8080:8000 or IP:8080:8000 names one);
                                                     --snapshot S starts it from a saved machine;
                                                     --ttl 1h stops it after that long
  snowglobe snapshot save <machine> [--name S]       save a machine whole (memory, processes, the
                                                     files it wrote), to start machines from again;
                                                     snapshot ls, snapshot rm S
  snowglobe service add <name> --template T          a template's machines behind host ports the
                [-p [IP:]HOST:GUEST]... [--min 0]    daemon holds: each connection (or sh <name>)
                [--max 1] [--idle 5m]                goes to a replica, started on demand. --min 0
                [--concurrency 10]                   scales to zero: replicas idle for --idle stop,
                [--state discard|keep]               and the next connection starts one in tens of
                                                     milliseconds; --state keep saves the replica
                                                     first and the next one carries on from it
                                                     (one replica). service ls, service rm <name>
  snowglobe tools                                    build the tools image (or find it) and print its tag
  snowglobe version

Build flags:
  --out DIR       output directory (default: dist)
  --cmd CMD       shell command to run on the terminal (default: the image's ENTRYPOINT + CMD)
  --ready TEXT    terminal output that means the app is ready to snapshot
                  (default: once the terminal has been quiet for 5 seconds)
  --title TEXT    page title (default: the source)
  --memory MB     guest RAM (default: 512)
  --warm REGEX    extra guest paths to preload, on top of what the guest read
  --network NAME  none (default) or fetch: the guest's plain HTTP requests go out through the
                  browser's fetch(), upgraded to HTTPS on HTTPS pages; servers must allow CORS
  --tunnel [HOST:]PORT=URL
                  carry the guest's TCP to HOST:PORT (any name, if HOST is left out) over a
                  WebSocket to URL (ws:// or wss://), as binary messages: websockify, websocat
                  or Neon's wsproxy in front of the service. The only way out for raw TCP in a
                  browser (a database, Redis...). Repeatable; needs --network fetch
  --tunnel-token URL
                  a GET answering with an access token, for tunnel URLs with {token} in them:
                  the page asks it for a fresh one per connection (the snapshot, for one per
                  boot). With a gateway behind the tunnels that holds the real credentials,
                  none is in the page or the guest
  --allow-private let the build's snapshot reach loopback and private addresses (a tunnel
                  endpoint on this machine, say); the page is unaffected
  --exercise CMD  a command to type into the app after the snapshot, recording the files it reads
                  so they're preloaded too; repeatable. A warm-report.json explains the result
  --cpus N        guest CPUs, 1 to 8 (default: 1). More than one runs each CPU in its own Web
                  Worker; the page then makes itself cross-origin isolated with a service worker
  --build-cpus N  CPUs to boot and warm up on before the snapshot (default: the larger of --cpus
                  and 4); the extra ones go offline first, so build time doesn't depend on --cpus.
                  Programs that size thread pools at start (the BEAM's schedulers) keep N
  --builder B     docker (default) or native: no Docker at all, from an image reference
                  (pulled from its registry) or an image archive (docker save, OCI layout); the
                  boot layer is written rather than built and snowglobe-vm snapshots here
                  (SNOWGLOBE_BUILDER sets the default)
  --sandbox       snapshot for running natively (run, bundle) rather than in a page: the guest
                  keeps its file cache, and exercises (optional) run before the snapshot
  --no-chunks     store every guest file in one blob, however large (default: files of 2 MiB
                  and more are split into content-defined chunks, so a read fetches only what it
                  covers and sites share identical chunks; the page then needs armless 0.3.0)

An image can carry its own settings as labels, which flags override:
  LABEL snowglobe.ready="iex(1)> " snowglobe.title="My app" snowglobe.memory="256" \
        snowglobe.exercise='["h Enum.map", "Task.async(fn -> 1 end)"]'
  LABEL snowglobe.network="fetch" snowglobe.cpus="2" snowglobe.build-cpus="2"
  LABEL snowglobe.tunnels='["db.internal:5432=wss://db-proxy.example.com/"]'

The image must be 64-bit ARM Alpine: FROM alpine (multi-arch; snowglobe builds it for arm64)
or arm64v8/alpine. Docker is the only requirement. On an x86 host, building arm64 images needs
QEMU's binfmt handlers (Docker Desktop has them; on Linux:
docker run --privileged --rm tonistiigi/binfmt --install arm64).

With --network fetch, the guest's HTTP, HTTPS and WebSockets go out through the browser's fetch()
and WebSocket on the page (servers must allow CORS), and straight out of "snowglobe run"'s
container (through the proxy in HTTPS_PROXY/HTTP_PROXY/NO_PROXY if set, trusting SSL_CERT_FILE).
`

func main() {
	if version == "" {
		version = moduleVersion()
	}
	os.Exit(run(os.Args[1:]))
}

// run runs the command in args (the program's arguments) and returns its exit status.
func run(args []string) int {
	if len(args) < 1 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}

	var err error
	switch args[0] {
	case "build":
		err = runBuild(args[1:])
	case "serve":
		err = runServe(args[1:])
	case "pool":
		err = runPool(args[1:])
	case "pwa":
		err = runPWA(args[1:])
	case "run":
		err = runRun(args[1:])
	case "pack":
		err = runPack(args[1:])
	case "bundle":
		err = runBundle(args[1:])
	case "warm":
		err = runWarm(args[1:])
	case "exec":
		if len(args) < 3 {
			err = fmt.Errorf("exec takes an instance name and a command")
		} else {
			err = instance.Exec(args[1], args[2:])
		}
	case "sh":
		err = runSh(args[1:])
	case "cp":
		if len(args) != 3 {
			err = fmt.Errorf("cp takes a source and a destination, one of them name:/path in an instance")
		} else {
			err = instance.Copy(args[1], args[2])
		}
	case "mcp":
		err = runMCP(args[1:])
	case "attach":
		if len(args) != 2 {
			err = fmt.Errorf("attach takes an instance name")
		} else {
			err = instance.Attach(args[1])
		}
	case "stop":
		if len(args) != 2 {
			err = fmt.Errorf("stop takes an instance name")
		} else {
			err = instance.Stop(args[1])
		}
	case "ps":
		err = instance.List()
	case "daemon":
		err = runDaemon(args[1:])
	case "template":
		err = runTemplate(args[1:])
	case "up":
		err = runUp(args[1:])
	case "snapshot":
		err = runSnapshot(args[1:])
	case "service":
		err = runService(args[1:])
	case "tools":
		if len(args) == 3 && args[1] == "kernel" {
			// The kernel archive builds without Docker add (a release asset), built with Docker
			err = boot.BuildKernel(args[2])
			break
		}
		// Build (or find) the tools image and print its tag, e.g. to build it once in CI
		var t *tools.Image
		if t, err = tools.Build(version); err == nil {
			fmt.Println(t.Tag())
		}
	case "version", "--version":
		fmt.Println("snowglobe", version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}

	var exit instance.ExitError
	if errors.As(err, &exit) {
		// The runtime's own exit status (what a piped session or exec ended with)
		return exit.Code
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\033[31merror:\033[0m %v\n", err)
		return 1
	}
	return 0
}

func runBuild(args []string) error {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	o := build.Options{}
	fs.StringVar(&o.Out, "out", "dist", "")
	fs.StringVar(&o.Cmd, "cmd", "", "")
	fs.StringVar(&o.Ready, "ready", "", "")
	fs.StringVar(&o.Title, "title", "", "")
	fs.IntVar(&o.Memory, "memory", 0, "")
	fs.StringVar(&o.Warm, "warm", "", "")
	fs.Func("exercise", "", func(v string) error { o.Exercise = append(o.Exercise, v); return nil })
	fs.StringVar(&o.Network, "network", "", "")
	fs.Func("tunnel", "", func(v string) error { o.Tunnels = append(o.Tunnels, v); return nil })
	fs.StringVar(&o.TunnelToken, "tunnel-token", "", "")
	fs.BoolVar(&o.AllowPrivate, "allow-private", false, "")
	fs.IntVar(&o.CPUs, "cpus", 0, "")
	fs.BoolVar(&o.Sandbox, "sandbox", false, "")
	fs.StringVar(&o.Builder, "builder", os.Getenv("SNOWGLOBE_BUILDER"), "")
	fs.IntVar(&o.BuildCPUs, "build-cpus", 0, "")
	fs.BoolVar(&o.NoChunks, "no-chunks", false, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }

	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		fs.Usage()
		return fmt.Errorf("build takes exactly one source: a directory with a Dockerfile, or an image")
	}
	o.Source = positional[0]

	if err := build.Run(o, version); err != nil {
		return err
	}
	fmt.Printf("\n\033[32m%s is ready to deploy.\033[0m Preview it with: snowglobe serve %s\n", o.Out, o.Out)
	return nil
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := fs.Int("port", 8000, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }

	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	dir := "dist"
	if len(positional) > 0 {
		dir = positional[0]
	}
	return serve.Run(dir, *port)
}

func runPWA(args []string) error {
	fs := flag.NewFlagSet("pwa", flag.ContinueOnError)
	o := pwa.Options{}
	fs.StringVar(&o.Name, "name", "", "")
	fs.StringVar(&o.ShortName, "short-name", "", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }

	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return fmt.Errorf("pwa takes one built site directory")
	}
	o.Site = positional[0]
	if err := pwa.Run(o); err != nil {
		return err
	}
	fmt.Printf("%s is an installable app now: manifest.webmanifest, icons and sw.js added\n", o.Site)
	return nil
}

func runPack(args []string) error {
	fs := flag.NewFlagSet("pack", flag.ContinueOnError)
	out := fs.String("o", "", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }

	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return fmt.Errorf("pack takes one built site directory")
	}
	site := positional[0]
	if *out == "" {
		*out = filepath.Base(filepath.Clean(site)) + ".tar.gz"
	}
	n, err := pack.Run(site, *out)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %.1f MB. Publish it anywhere and run it with: snowglobe run <its URL>\n", *out, float64(n)/(1<<20))
	return nil
}

func runBundle(args []string) error {
	fs := flag.NewFlagSet("bundle", flag.ContinueOnError)
	out := fs.String("o", "", "")
	runtime := fs.String("runtime", os.Getenv("SNOWGLOBE_VM"), "")
	target := fs.String("target", "linux", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }

	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return fmt.Errorf("bundle takes one built site (a directory, a URL or a tarball)")
	}
	site := positional[0]
	if *out == "" {
		*out = filepath.Base(filepath.Clean(site))
	}
	switch {
	case remote.IsURL(site):
		if site, err = remote.Fetch(site); err != nil {
			return err
		}
	case remote.IsTarball(site):
		if site, err = remote.Unpack(site); err != nil {
			return err
		}
	}
	// The runtime: snowglobe-vm for the system the bundle will run on (this machine's
	// architecture): --runtime, else the release's, else (Linux) the tools image's
	if *runtime == "" {
		if *target != "linux" && *target != "darwin" {
			return fmt.Errorf("--target %s: linux or darwin", *target)
		}
		var img *native.Image
		if *target == "linux" {
			img = tools.NativeSource(version)
		}
		if *runtime, err = native.For(version, *target, goruntime.GOARCH, img); err != nil {
			return err
		}
	}
	s, err := bundle.Write(site, *runtime, *out)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %.1f MB (runtime %.1f MB, the site and %d guest files %.1f MB)\n"+
		"Run it anywhere it was built for, with no Docker:  ./%s   (echo '...' | ./%s, --detached, -p ...)\n",
		*out, float64(s.Runtime+s.Site)/(1<<20), float64(s.Runtime)/(1<<20), s.Blobs, float64(s.Site)/(1<<20),
		filepath.Base(*out), filepath.Base(*out))
	return nil
}

func runRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	o := instance.Options{Site: "dist"}
	fs.StringVar(&o.Name, "name", "", "")
	fs.BoolVar(&o.Detach, "detach", false, "")
	fs.BoolVar(&o.Fork, "fork", false, "")
	publish := func(v string) error { o.Publish = append(o.Publish, v); return nil }
	fs.Func("p", "", publish)
	fs.Func("publish", "", publish)
	fs.Func("tunnel", "", func(v string) error { o.Tunnels = append(o.Tunnels, v); return nil })
	fs.BoolVar(&o.AllowPrivate, "allow-private", false, "")
	fs.StringVar(&o.RecordReads, "record-reads", "", "")
	fs.StringVar(&o.TunnelToken, "tunnel-token", "", "")
	fs.StringVar(&o.Runtime, "runtime", os.Getenv("SNOWGLOBE_RUNTIME"), "")
	fs.Func("max-runtime", "", func(v string) (err error) { o.MaxRuntime, err = parseDuration(v); return err })
	fs.StringVar(&o.StopFile, "stop-file", "", "")
	fs.StringVar(&o.LogDir, "log-dir", "", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }

	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) > 0 {
		o.Site = positional[0]
	}
	// A URL or a tarball is fetched or unpacked into the cache first, then run like a directory
	switch {
	case remote.IsURL(o.Site):
		if o.Site, err = remote.Fetch(o.Site); err != nil {
			return err
		}
	case remote.IsTarball(o.Site):
		if o.Site, err = remote.Unpack(o.Site); err != nil {
			return err
		}
	}
	return instance.Run(o, version)
}

func runWarm(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("warm takes a built site and the reads.json files runs recorded")
	}
	s, err := build.Warm(args[0], args[1:])
	if err != nil {
		return err
	}
	fmt.Printf("Recorded %d files: %d new in the warm pack, now %d files, %.1f MB\n",
		s.Recorded, s.Added, s.Files, float64(s.Bytes)/(1<<20))
	return nil
}

func runPool(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("pool takes one directory holding the sites to pool")
	}
	stats, err := pool.Run(args[0])
	if err != nil {
		return err
	}
	fmt.Printf("Pooled %d sites: %d files, %d unique, %.0f MB saved\n",
		stats.Sites, stats.Files, stats.Unique, float64(stats.Saved)/(1<<20))
	return nil
}

// parseDuration reads a Go duration ("90s", "1h30m") or plain seconds ("90", "2.5")
func parseDuration(v string) (time.Duration, error) {
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		if secs <= 0 || math.IsInf(secs, 0) || math.IsNaN(secs) {
			return 0, fmt.Errorf("%s: more than 0", v)
		}
		return time.Duration(secs * float64(time.Second)), nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s: a duration (90s, 5m) or seconds", v)
	}
	return d, nil
}

// parse lets flags come before or after positional arguments; the flag package alone stops at
// the first positional one
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return positional, nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

func runSh(args []string) error {
	fs := flag.NewFlagSet("sh", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	timeout := fs.Float64("timeout", 300, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	positional, err := parse(fs, args)
	if err != nil {
		if strings.HasPrefix(err.Error(), "flag provided but not defined") {
			// Most likely the command's own flag: its words were left unquoted
			return fmt.Errorf("%w: quote the command, as in snowglobe sh web 'ls -l'", err)
		}
		return err
	}
	if len(positional) < 2 {
		return fmt.Errorf("sh takes an instance name and a command")
	}
	return instance.Shell(positional[0], strings.Join(positional[1:], " "), *asJSON, *timeout)
}

// runMCP serves a site to an agent over MCP: a native instance of it (started here, or one that is
// running), stopped when the agent goes unless --keep.
func runMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	name := fs.String("name", "", "")
	keep := fs.Bool("keep", false, "")
	logDir := fs.String("log-dir", "", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return fmt.Errorf("mcp takes a built site (a directory, a URL or a tarball)")
	}
	site := positional[0]
	if *name == "" {
		*name = fmt.Sprintf("mcp-%d", os.Getpid())
		// Sessions of their own all log to one place (rotated), not a directory each
		if *logDir == "" {
			dir, err := instance.LogsDir("mcp")
			if err != nil {
				return err
			}
			*logDir = dir
		}
	}
	switch {
	case remote.IsURL(site):
		if site, err = remote.Fetch(site); err != nil {
			return err
		}
	case remote.IsTarball(site):
		if site, err = remote.Unpack(site); err != nil {
			return err
		}
	}
	started := false
	if err := instance.Shell(*name, "true", false, 30); err != nil {
		// Not running yet: start it, natively (stdout stays the protocol's)
		if err := instance.Run(instance.Options{Site: site, Name: *name, Detach: true, Runtime: "native", LogDir: *logDir}, version); err != nil {
			return err
		}
		started = true
	}
	if started && !*keep {
		defer instance.Stop(*name)
	}
	title := site
	if data, err := os.ReadFile(filepath.Join(site, "run.json")); err == nil {
		var info struct {
			Title string `json:"title"`
		}
		if json.Unmarshal(data, &info) == nil && info.Title != "" {
			title = info.Title
		}
	}
	return (&mcp.Server{Name: *name, Title: title, Version: version}).Stdio()
}
