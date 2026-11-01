// snowglobe packages a Docker image into a static website that runs it in the browser: the
// image boots on Linux inside armless, a 64-bit ARM machine compiled to WebAssembly, is
// snapshotted once its app is ready, and visitors restore that snapshot in about a second.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"runtime/debug"

	"github.com/filipecabaco/snowglobe/internal/boot"
	"github.com/filipecabaco/snowglobe/internal/build"
	"github.com/filipecabaco/snowglobe/internal/bundle"
	"github.com/filipecabaco/snowglobe/internal/instance"
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
  snowglobe exec <name> <command>                    type a command into a running instance and
                                                     print what it printed
  snowglobe attach <name>                            join a running instance (ctrl-] detaches)
  snowglobe stop <name>                              throw a running instance away
  snowglobe ps                                       list running instances
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
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "build":
		err = runBuild(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "pool":
		err = runPool(os.Args[2:])
	case "pwa":
		err = runPWA(os.Args[2:])
	case "run":
		err = runRun(os.Args[2:])
	case "pack":
		err = runPack(os.Args[2:])
	case "bundle":
		err = runBundle(os.Args[2:])
	case "warm":
		err = runWarm(os.Args[2:])
	case "exec":
		if len(os.Args) < 4 {
			err = fmt.Errorf("exec takes an instance name and a command")
		} else {
			err = instance.Exec(os.Args[2], os.Args[3:])
		}
	case "attach":
		if len(os.Args) != 3 {
			err = fmt.Errorf("attach takes an instance name")
		} else {
			err = instance.Attach(os.Args[2])
		}
	case "stop":
		if len(os.Args) != 3 {
			err = fmt.Errorf("stop takes an instance name")
		} else {
			err = instance.Stop(os.Args[2])
		}
	case "ps":
		err = instance.List()
	case "tools":
		if len(os.Args) == 4 && os.Args[2] == "kernel" {
			// The kernel archive builds without Docker add (a release asset), built with Docker
			err = boot.BuildKernel(os.Args[3])
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
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}

	var exit instance.ExitError
	if errors.As(err, &exit) {
		// The runtime's own exit status (what a piped session or exec ended with)
		os.Exit(exit.Code)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\033[31merror:\033[0m %v\n", err)
		os.Exit(1)
	}
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
	publish := func(v string) error { o.Publish = append(o.Publish, v); return nil }
	fs.Func("p", "", publish)
	fs.Func("publish", "", publish)
	fs.Func("tunnel", "", func(v string) error { o.Tunnels = append(o.Tunnels, v); return nil })
	fs.BoolVar(&o.AllowPrivate, "allow-private", false, "")
	fs.StringVar(&o.RecordReads, "record-reads", "", "")
	fs.StringVar(&o.TunnelToken, "tunnel-token", "", "")
	fs.StringVar(&o.Runtime, "runtime", os.Getenv("SNOWGLOBE_RUNTIME"), "")
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
