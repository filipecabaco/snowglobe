package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"text/tabwriter"
)

// runPorts: ports [--json] | ports check <port> [--ip IP]
func runPorts(args []string) error {
	if len(args) > 0 && args[0] == "check" {
		fs := flag.NewFlagSet("ports check", flag.ContinueOnError)
		ip := fs.String("ip", "", "")
		asJSON := fs.Bool("json", false, "")
		fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
		positional, err := parse(fs, args[1:])
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return fmt.Errorf("ports check takes a port")
		}
		port, err := strconv.Atoi(positional[0])
		if err != nil {
			return fmt.Errorf("ports check: %q is not a port", positional[0])
		}
		c, err := daemonClient()
		if err != nil {
			return err
		}
		res, err := c.CheckPort(*ip, port)
		if err != nil {
			return err
		}
		if *asJSON {
			return json.NewEncoder(os.Stdout).Encode(res)
		}
		switch {
		case res.Free:
			fmt.Printf("%s:%d is free\n", res.IP, res.Port)
		case res.Detail != "":
			fmt.Printf("%s:%d is taken by %s (%s)\n", res.IP, res.Port, res.By, res.Detail)
		default:
			fmt.Printf("%s:%d is taken by %s\n", res.IP, res.Port, res.By)
		}
		if !res.Free {
			os.Exit(1)
		}
		return nil
	}
	fs := flag.NewFlagSet("ports", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	ps, err := c.Ports()
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(ps)
	}
	if len(ps) == 0 {
		fmt.Println("no ports: `up -p` and `service add -p` forward host ports to machines")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "HOST\tGUEST\tKIND\tNAME\tTEMPLATE\tSTATE")
	for _, p := range ps {
		state := "open"
		if !p.Open {
			state = "not listening"
		}
		if p.Kind == "service" {
			state = fmt.Sprintf("%d replicas", p.Replicas)
			if p.Replicas == 0 {
				state = "at zero"
			}
		}
		fmt.Fprintf(w, "%s:%d\t%d\t%s\t%s\t%s\t%s\n", p.IP, p.Host, p.Guest, p.Kind, p.Name, p.Template, state)
	}
	return w.Flush()
}
