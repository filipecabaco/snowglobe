package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// runProvide: provide <image | Dockerfile dir | Dockerfile> [--kernel none|linux] [--network
// fetch] [--cpus N] [--memory MB] [--name N] [-o site.tar.zst]. A daemon (a provider, or a full
// one) builds it for the page and packs it; this waits, with the build's log, and downloads the
// packed site: a static site for any CDN. Built already, it is the one built.
func runProvide(args []string) error {
	fs := flag.NewFlagSet("provide", flag.ContinueOnError)
	var req daemon.BuildRequest
	fs.StringVar(&req.Kernel, "kernel", "", "")
	fs.StringVar(&req.Network, "network", "", "")
	fs.IntVar(&req.CPUs, "cpus", 0, "")
	fs.IntVar(&req.Memory, "memory", 0, "")
	fs.StringVar(&req.Name, "name", "", "")
	out := fs.String("o", "", "")
	quiet := fs.Bool("quiet", false, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return errors.New("provide takes an image, a directory with a Dockerfile, or a Dockerfile")
	}
	src := positional[0]
	format := ""
	switch {
	case *out == "":
		*out = "site.tar.zst"
	case strings.HasSuffix(*out, ".tar.gz"), strings.HasSuffix(*out, ".tgz"):
		format = "gz"
	case strings.HasSuffix(*out, ".tar.zst"):
	default:
		return fmt.Errorf("-o %s: name it .tar.zst or .tar.gz", *out)
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	req.Artifact, req.NoTemplate = true, true
	switch fi, err := os.Stat(src); {
	case err == nil && fi.IsDir():
		// A directory of this host: sent as the build's context, whichever host the daemon is on
		up, err := c.UploadContext(src)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "sent %s: %d files, %.1f MB\n", src, up.Files, float64(up.Bytes)/(1<<20))
		req.Context = up.Context
	case err == nil:
		data, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		req.Dockerfile = string(data)
	default:
		req.Source = src
	}
	if req.Name == "" {
		req.Name = siteName(src)
	}
	b, err := c.StartBuild(req)
	if err != nil {
		return err
	}
	if b.Cached {
		fmt.Fprintf(os.Stderr, "built already (build %s, %s)\n", b.ID, b.Ended.Format(time.DateTime))
	} else {
		fmt.Fprintf(os.Stderr, "build %s on the daemon at %s\n", b.ID, c.Addr)
		// Interrupted, it stops waiting; the build goes on (and is cached for the next time)
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		var log io.Writer = os.Stderr
		if *quiet {
			log = io.Discard
		}
		var offset int64
		for {
			if offset, err = c.FollowBuildLog(ctx, b.ID, offset, log); err != nil {
				return err
			}
			if ctx.Err() != nil {
				return fmt.Errorf("stopped waiting: build %s goes on (snowglobe provide again picks it up)", b.ID)
			}
			if b, err = c.Build(b.ID); err != nil {
				return err
			}
			if b.Status != "queued" && b.Status != "running" {
				break
			}
		}
	}
	if b.Status != "done" {
		return fmt.Errorf("build %s %s: %s", b.ID, b.Status, b.Error)
	}
	n, sum, err := c.DownloadArtifact(b.ID, format, *out)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %.1f MB, sha256 %s\n", *out, float64(n)/(1<<20), sum)
	fmt.Fprintf(os.Stderr, "A static site: unpack it anywhere on a static host or CDN and open its index.html (snowglobe serve DIR to preview).\n")
	return nil
}

// siteName is a build's name for what it builds: the image's or the directory's last part, as a
// name can be.
func siteName(src string) string {
	abs, _ := filepath.Abs(src)
	base := filepath.Base(abs)
	if fi, err := os.Stat(src); err == nil && !fi.IsDir() {
		base = filepath.Base(filepath.Dir(abs))
	} else if err != nil {
		base = src[strings.LastIndex(src, "/")+1:]
		base, _, _ = strings.Cut(base, "@")
		base = strings.ReplaceAll(base, ":", "-")
	}
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	name := strings.TrimLeft(b.String(), "-_")
	if len(name) > 48 {
		name = name[:48]
	}
	if name == "" {
		return "site"
	}
	return name
}
