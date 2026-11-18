package main

import (
	"errors"
	"flag"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// healthFlags are a health check's flags: --health-http PORT[/PATH] [--health-status 200-399] or
// --health-cmd CMD, --health-interval, --health-timeout, --health-failures, --health-grace,
// --heal, --heal-cmd, --drain and --wait-ready.
type healthFlags struct {
	hc                              daemon.Health
	http, status                    string
	interval, timeout, grace, drain time.Duration
}

func addHealthFlags(fs *flag.FlagSet) *healthFlags {
	f := &healthFlags{}
	fs.StringVar(&f.http, "health-http", "", "")
	fs.StringVar(&f.status, "health-status", "", "")
	fs.StringVar(&f.hc.Cmd, "health-cmd", "", "")
	fs.DurationVar(&f.interval, "health-interval", 0, "")
	fs.DurationVar(&f.timeout, "health-timeout", 0, "")
	fs.IntVar(&f.hc.Failures, "health-failures", 0, "")
	fs.DurationVar(&f.grace, "health-grace", 0, "")
	fs.StringVar(&f.hc.Heal, "heal", "", "")
	fs.StringVar(&f.hc.HealCmd, "heal-cmd", "", "")
	fs.DurationVar(&f.drain, "drain", 0, "")
	fs.BoolVar(&f.hc.WaitReady, "wait-ready", false, "")
	return f
}

// health is the check the flags ask for (nil: none).
func (f *healthFlags) health() (*daemon.Health, error) {
	hc := f.hc
	if f.http == "" && hc.Cmd == "" && hc.Heal == "" && hc.HealCmd == "" && f.status == "" && !hc.WaitReady {
		return nil, nil
	}
	if f.http != "" {
		portS, path, _ := strings.Cut(f.http, "/")
		p, err := strconv.Atoi(portS)
		if err != nil {
			return nil, fmt.Errorf("--health-http %q: PORT or PORT/PATH, like 8000/healthz", f.http)
		}
		hc.HTTP = &daemon.HTTPCheck{Port: p, Path: "/" + path, Status: f.status}
	} else if f.status != "" {
		return nil, errors.New("--health-status is for --health-http")
	}
	hc.Interval, hc.Timeout, hc.Grace, hc.Drain = daemon.Duration(f.interval), daemon.Duration(f.timeout), daemon.Duration(f.grace), daemon.Duration(f.drain)
	return &hc, nil
}

// describeHealth is a health check in a line.
func describeHealth(h *daemon.Health) string {
	what := "cmd " + h.Cmd
	if h.HTTP != nil {
		what = fmt.Sprintf("GET :%d%s (%s)", h.HTTP.Port, h.HTTP.Path, h.HTTP.Status)
	}
	return fmt.Sprintf("health %s every %s, %d failures, heal %s", what, time.Duration(h.Interval), h.Failures, h.Heal)
}

// runHealth: health <service|machine|template> <name> [health flags | --none]: a health check
// changed in place
func runHealth(args []string) error {
	if len(args) < 2 {
		return errors.New("health takes service, machine or template, a name, and a check's flags (or --none)")
	}
	kind, name := args[0], args[1]
	switch kind {
	case daemon.KindService, daemon.KindMachine, daemon.KindTemplate:
	default:
		return fmt.Errorf("health %s: service, machine or template", kind)
	}
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	hf := addHealthFlags(fs)
	none := fs.Bool("none", false, "")
	positional, err := parse(fs, args[2:])
	if err != nil {
		return err
	}
	if len(positional) > 0 {
		return fmt.Errorf("health: %s?", strings.Join(positional, " "))
	}
	h, err := hf.health()
	if err != nil {
		return err
	}
	if (h == nil) != *none {
		return errors.New("health: a check's flags (--health-http or --health-cmd, ...), or --none")
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	if err := c.SetHealth(kind, name, h, nil); err != nil {
		return err
	}
	if h == nil {
		fmt.Printf("%s %s: no health check of its own\n", kind, name)
	} else {
		fmt.Printf("%s %s: health check changed in place\n", kind, name)
	}
	return nil
}

// runSupervisor: supervisor add <name> --child KIND/NAME[:RESTART]... [--strategy S]
// [--max-restarts N] [--max-seconds D] | ls | restart <name> | rm <name>
func runSupervisor(args []string) error {
	if len(args) == 0 {
		return errors.New("supervisor takes add, ls, restart or rm")
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("supervisor add", flag.ContinueOnError)
		var req daemon.Supervisor
		var window time.Duration
		fs.StringVar(&req.Strategy, "strategy", "", "")
		fs.IntVar(&req.MaxRestarts, "max-restarts", 0, "")
		fs.DurationVar(&window, "max-seconds", 0, "")
		fs.Func("child", "", func(v string) error {
			kind, rest, ok := strings.Cut(v, "/")
			if !ok {
				return fmt.Errorf("--child %s: KIND/NAME[:RESTART], like service/db or machine/worker:transient", v)
			}
			name, restart, _ := strings.Cut(rest, ":")
			req.Children = append(req.Children, daemon.Child{Kind: kind, Name: name, Restart: restart})
			return nil
		})
		positional, err := parse(fs, args[1:])
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return errors.New("supervisor add takes a name and its children (--child KIND/NAME, in order)")
		}
		req.Name, req.MaxSeconds = positional[0], daemon.Duration(window)
		s, err := c.AddSupervisor(req)
		if err != nil {
			return err
		}
		fmt.Printf("%s: %s over %s, at most %d restarts in %s\n", s.Name, s.Strategy, childNames(s.Children), s.MaxRestarts, time.Duration(s.MaxSeconds))
	case "ls":
		ss, err := c.Supervisors()
		if err != nil {
			return err
		}
		if len(ss) == 0 {
			fmt.Println("no supervisors")
			return nil
		}
		fmt.Println("NAME\tSTRATEGY\tSTATE\tRESTARTS\tCHILDREN")
		for _, s := range ss {
			var kids []string
			for _, st := range s.States {
				kids = append(kids, fmt.Sprintf("%s/%s (%s)", st.Kind, st.Name, st.State))
			}
			fmt.Printf("%s\t%s\t%s\t%d of %d in %s\t%s\n", s.Name, s.Strategy, s.State, s.Restarts, s.MaxRestarts, time.Duration(s.MaxSeconds), strings.Join(kids, ", "))
		}
	case "restart":
		if len(args) != 2 {
			return errors.New("supervisor restart takes a supervisor's name")
		}
		s, err := c.RestartSupervisor(args[1])
		if err != nil {
			return err
		}
		fmt.Printf("%s: restarted, %s\n", s.Name, s.State)
	case "rm":
		if len(args) != 2 {
			return errors.New("supervisor rm takes a supervisor's name")
		}
		return c.RemoveSupervisor(args[1])
	default:
		return fmt.Errorf("supervisor %s: add, ls, restart or rm", args[0])
	}
	return nil
}

func childNames(cs []daemon.Child) string {
	var out []string
	for _, c := range cs {
		n := c.Kind + "/" + c.Name
		if c.Restart != daemon.Permanent {
			n += ":" + c.Restart
		}
		out = append(out, n)
	}
	return strings.Join(out, " ")
}
