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
	vm, err := native.VM(version, tools.NativeSource(version))
	if err != nil {
		return err
	}
	dir, err := daemon.Dir()
	if err != nil {
		return err
	}
	logger := log.New(os.Stderr, "snowglobe daemon: ", log.LstdFlags)
	s, err := daemon.New(daemon.Options{Dir: dir, VM: vm, Listen: *listen, Token: token, Logf: logger.Printf})
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
		positional, err := parse(fs, args[1:])
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return errors.New("template add takes a site (a directory, tarball or URL)")
		}
		req.Site = positional[0]
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
		fmt.Println("NAME\tSITE\tSERVER PID")
		for _, t := range ts {
			fmt.Printf("%s\t%s\t%d\n", t.Name, t.Site, t.Pid)
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
