package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/daemon"
	"github.com/filipecabaco/snowglobe/internal/native"
	"github.com/filipecabaco/snowglobe/internal/tools"
)

// runDaemon serves the orchestrator's API until it is interrupted. Templates and machines outlive
// it; started again, it takes back what is still running.
func runDaemon(args []string) error {
	fs := flag.NewFlagSet("daemon", flag.ContinueOnError)
	listen := fs.String("listen", "", "")
	tokenFile := fs.String("token-file", "", "")
	memory := fs.String("memory", "", "")
	wait := fs.Duration("wait", 30*time.Second, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	token := ""
	if *tokenFile != "" {
		data, err := os.ReadFile(*tokenFile)
		if err != nil {
			return err
		}
		if token = strings.TrimSpace(string(data)); len(token) < 16 {
			return fmt.Errorf("%s: a token of 16 characters or more", *tokenFile)
		}
	}
	var budget int64
	if *memory != "" {
		var err error
		if budget, err = daemon.ParseSize(*memory); err != nil {
			return fmt.Errorf("--memory: %w", err)
		}
	}
	vm, err := native.VM(version, tools.NativeSource(version))
	if err != nil {
		return err
	}
	dir, err := daemon.Dir()
	if err != nil {
		return err
	}
	logger := log.New(os.Stderr, "snowglobe daemon: ", log.LstdFlags)
	s, err := daemon.New(daemon.Options{Dir: dir, VM: vm, Listen: *listen, Token: token, Memory: budget, Wait: *wait, Logf: logger.Printf})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return s.Serve(ctx)
}

// daemonClient is the running daemon, or an error saying how to start one.
func daemonClient() (*daemon.Client, error) {
	c, ok := daemon.Find()
	if !ok {
		return nil, errors.New("no snowglobe daemon is running: start one with `snowglobe daemon` (or point SNOWGLOBE_DAEMON at one)")
	}
	return c, nil
}

// runTemplate: template add <site> [--name T] [--max-machines N] | ls | rm <T>
func runTemplate(args []string) error {
	if len(args) == 0 {
		return errors.New("template takes add, ls or rm")
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("template add", flag.ContinueOnError)
		var req daemon.AddTemplate
		fs.StringVar(&req.Name, "name", "", "")
		fs.IntVar(&req.MaxMachines, "max-machines", 0, "")
		fs.StringVar(&req.Snapshot, "snapshot", "", "")
		fs.Func("idle", "", func(v string) error {
			d, err := time.ParseDuration(v)
			req.Idle = daemon.Duration(d)
			return err
		})
		positional, err := parse(fs, args[1:])
		if err != nil {
			return err
		}
		switch {
		case len(positional) == 1:
			req.Site = positional[0]
		case len(positional) == 0 && req.Snapshot != "":
			// The snapshot's site
		default:
			return errors.New("template add takes a site (a directory, tarball or URL), or --snapshot S")
		}
		t, err := c.AddTemplate(req)
		if err != nil {
			return err
		}
		fmt.Printf("%s: %s\n  snowglobe up %s [--name N] [-p 8000]\n", t.Name, t.Ready, t.Name)
	case "ls":
		ts, err := c.Templates()
		if err != nil {
			return err
		}
		if len(ts) == 0 {
			fmt.Println("no templates")
			return nil
		}
		fmt.Println("NAME\tSITE\tSERVER")
		for _, t := range ts {
			server := fmt.Sprintf("pid %d", t.Pid)
			if t.Asleep {
				server = "asleep"
			}
			if t.Idle > 0 {
				server += fmt.Sprintf(" (sleeps after %s idle)", time.Duration(t.Idle))
			}
			fmt.Printf("%s\t%s\t%s\n", t.Name, t.Site, server)
		}
	case "rm":
		if len(args) != 2 {
			return errors.New("template rm takes a template's name")
		}
		return c.RemoveTemplate(args[1])
	default:
		return fmt.Errorf("template %s: add, ls or rm", args[0])
	}
	return nil
}

// runUp: up <template> [--name N] [-p [IP:][HOST:]GUEST]... [--label K=V]...
func runUp(args []string) error {
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	var req daemon.Up
	fs.StringVar(&req.Name, "name", "", "")
	fs.StringVar(&req.Snapshot, "snapshot", "", "")
	fs.Func("ttl", "", func(v string) error {
		d, err := time.ParseDuration(v)
		req.TTL = daemon.Duration(d)
		return err
	})
	port := func(v string) error { req.Ports = append(req.Ports, v); return nil }
	fs.Func("p", "", port)
	fs.Func("publish", "", port)
	fs.Func("label", "", func(v string) error {
		k, val, ok := strings.Cut(v, "=")
		if !ok || k == "" {
			return fmt.Errorf("--label %s: KEY=VALUE", v)
		}
		if req.Labels == nil {
			req.Labels = map[string]string{}
		}
		req.Labels[k] = val
		return nil
	})
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return errors.New("up takes a template's name (snowglobe template ls)")
	}
	req.Template = positional[0]
	c, err := daemonClient()
	if err != nil {
		return err
	}
	m, err := c.Up(req)
	if err != nil {
		return err
	}
	fmt.Println(m.Name)
	for _, p := range m.Ports {
		fmt.Fprintf(os.Stderr, "  port %s\n", p)
	}
	return nil
}

// runSnapshot: snapshot save <machine> [--name S] | ls | rm <S>
func runSnapshot(args []string) error {
	if len(args) == 0 {
		return errors.New("snapshot takes save, ls or rm")
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "save":
		fs := flag.NewFlagSet("snapshot save", flag.ContinueOnError)
		name := fs.String("name", "", "")
		positional, err := parse(fs, args[1:])
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return errors.New("snapshot save takes a machine's name")
		}
		s, err := c.Snapshot(positional[0], *name)
		if err != nil {
			return err
		}
		fmt.Printf("%s: %s saved, %.1f MB in %d ms\n  snowglobe up %s --snapshot %s   (or template add --snapshot %s)\n",
			s.Name, s.Machine, float64(s.Bytes)/(1<<20), s.Ms, s.Template, s.Name, s.Name)
	case "ls":
		ss, err := c.Snapshots()
		if err != nil {
			return err
		}
		if len(ss) == 0 {
			fmt.Println("no snapshots")
			return nil
		}
		fmt.Println("NAME\tOF\tTEMPLATE\tSIZE\tTAKEN")
		for _, s := range ss {
			fmt.Printf("%s\t%s\t%s\t%.1f MB\t%s\n", s.Name, s.Machine, s.Template, float64(s.Bytes)/(1<<20), s.Created.Format("2006-01-02 15:04:05"))
		}
	case "rm":
		if len(args) != 2 {
			return errors.New("snapshot rm takes a snapshot's name")
		}
		return c.RemoveSnapshot(args[1])
	default:
		return fmt.Errorf("snapshot %s: save, ls or rm", args[0])
	}
	return nil
}

// runService: service add <name> --template T [-p PORT]... [--min N] [--max N] [--idle D]
// [--concurrency N] [--state discard|keep] | ls | rm <name>
func runService(args []string) error {
	if len(args) == 0 {
		return errors.New("service takes add, ls or rm")
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("service add", flag.ContinueOnError)
		var req daemon.Service
		var ports []string
		var idle time.Duration
		fs.StringVar(&req.Template, "template", "", "")
		port := func(v string) error { ports = append(ports, v); return nil }
		fs.Func("p", "", port)
		fs.Func("publish", "", port)
		fs.IntVar(&req.Min, "min", 0, "")
		fs.IntVar(&req.Max, "max", 0, "")
		fs.DurationVar(&idle, "idle", 5*time.Minute, "")
		fs.IntVar(&req.Concurrency, "concurrency", 0, "")
		fs.StringVar(&req.State, "state", "discard", "")
		fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
		positional, err := parse(fs, args[1:])
		if err != nil {
			return err
		}
		if len(positional) != 1 || req.Template == "" {
			return errors.New("service add takes a name and --template T")
		}
		req.Name = positional[0]
		req.Idle = daemon.Duration(idle)
		for _, spec := range ports {
			p, err := daemon.ParsePort(spec)
			if err != nil {
				return err
			}
			req.Ports = append(req.Ports, p)
		}
		s, err := c.AddService(req)
		if err != nil {
			return err
		}
		fmt.Printf("%s: %d to %d replicas of %s, idle %s, state %s\n", s.Name, s.Min, s.Max, s.Template, time.Duration(s.Idle), s.State)
		for _, p := range s.Ports {
			fmt.Printf("  port %s\n", p)
		}
	case "ls":
		ss, err := c.Services()
		if err != nil {
			return err
		}
		if len(ss) == 0 {
			fmt.Println("no services")
			return nil
		}
		fmt.Println("NAME\tTEMPLATE\tRUNNING\tREPLICAS\tIDLE\tSTATE\tPORTS")
		for _, s := range ss {
			ports := ""
			for i, p := range s.Ports {
				if i > 0 {
					ports += ", "
				}
				ports += p.String()
			}
			fmt.Printf("%s\t%s\t%d\t%d-%d\t%s\t%s\t%s\n", s.Name, s.Template, len(s.Replicas), s.Min, s.Max, time.Duration(s.Idle), s.State, ports)
		}
	case "rm":
		if len(args) != 2 {
			return errors.New("service rm takes a service's name")
		}
		return c.RemoveService(args[1])
	default:
		return fmt.Errorf("service %s: add, ls or rm", args[0])
	}
	return nil
}
