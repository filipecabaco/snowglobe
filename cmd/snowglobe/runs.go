package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// runSubmit: submit <template> '<cmd>' [--timeout S] [--env K=V]... [--json] — fire and forget: the
// command runs once on a fresh fork, which is thrown away after; its id is printed at once.
func runSubmit(args []string) error {
	fs := flag.NewFlagSet("submit", flag.ContinueOnError)
	timeout := fs.Float64("timeout", 0, "")
	asJSON := fs.Bool("json", false, "")
	envs := map[string]string{}
	fs.Func("env", "", func(kv string) error {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			return fmt.Errorf("--env %s: K=V", kv)
		}
		envs[k] = v
		return nil
	})
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 2 {
		return fmt.Errorf("submit takes a template and a command, quoted as one argument")
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	r, err := c.SubmitRun(daemon.SubmitRun{Template: positional[0], Cmd: positional[1], Timeout: *timeout, Env: envs})
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(r)
	}
	fmt.Println(r.ID)
	return nil
}

// runRuns: runs [--json] | runs <id> [--wait] [--json] — the submitted runs, or one's result.
func runRuns(args []string) error {
	fs := flag.NewFlagSet("runs", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	wait := fs.Bool("wait", false, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	if len(positional) == 0 {
		rs, err := c.Runs()
		if err != nil {
			return err
		}
		if *asJSON {
			return json.NewEncoder(os.Stdout).Encode(rs)
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tTEMPLATE\tSTATUS\tSTARTED\tCOMMAND")
		for _, r := range rs {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s ago\t%s\n", r.ID, r.Template, runState(r), time.Since(r.Created).Round(time.Second), r.Cmd)
		}
		return w.Flush()
	}
	var r *daemon.Run
	for {
		if r, err = c.Run(positional[0]); err != nil {
			return err
		}
		if !*wait || r.Status != "running" {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(r)
	}
	os.Stdout.Write(r.Output)
	fmt.Fprintf(os.Stderr, "%s: %s\n", r.ID, runState(*r))
	switch {
	case r.Status == "running":
		return nil
	case r.Exit != nil:
		os.Exit(*r.Exit)
	}
	os.Exit(124)
	return nil
}

func runState(r daemon.Run) string {
	switch {
	case r.Status == "running":
		return "running"
	case r.Error != "":
		return "failed: " + r.Error
	case r.Exit == nil:
		return fmt.Sprintf("out of time after %d ms", r.Ms)
	default:
		return fmt.Sprintf("exit %d in %d ms", *r.Exit, r.Ms)
	}
}
