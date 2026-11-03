package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"

	"github.com/filipecabaco/snowglobe/internal/fleet"
)

// fleetFile is the -f flag: the fleet file, snowglobe.toml by default.
func fleetFile(fs *flag.FlagSet) *string {
	return fs.String("f", "snowglobe.toml", "")
}

// runDiff: diff [-f snowglobe.toml] — what apply would do.
func runDiff(args []string) error {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	file := fleetFile(fs)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	f, err := fleet.Load(*file)
	if err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	p, err := f.Plan(c)
	if err != nil {
		return err
	}
	printPlan(f, p)
	return nil
}

func printPlan(f *fleet.File, p *fleet.Plan) {
	if p.Empty() {
		fmt.Printf("fleet %s: as the file says (%d entries)\n", f.Name, p.Unchanged)
		return
	}
	fmt.Printf("fleet %s:\n", f.Name)
	for _, s := range p.Steps {
		fmt.Println("  " + s.String())
	}
	if p.Unchanged > 0 {
		fmt.Printf("  (%d as the file says)\n", p.Unchanged)
	}
}

// runApply: apply [-f snowglobe.toml] — get the daemon to what the file says.
func runApply(args []string) error {
	fs := flag.NewFlagSet("apply", flag.ContinueOnError)
	file := fleetFile(fs)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	f, err := fleet.Load(*file)
	if err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	p, err := f.Plan(c)
	if err != nil {
		return err
	}
	printPlan(f, p)
	if p.Empty() {
		return nil
	}
	return p.Apply(c, buildSite, func(format string, a ...any) { fmt.Printf(format+"\n", a...) })
}

// runDown: down [-f snowglobe.toml | --name FLEET] — remove everything of the fleet.
func runDown(args []string) error {
	fs := flag.NewFlagSet("down", flag.ContinueOnError)
	file := fleetFile(fs)
	name := fs.String("name", "", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *name == "" {
		f, err := fleet.Load(*file)
		if err != nil {
			return err
		}
		*name = f.Name
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	n, err := fleet.Down(c, *name, func(format string, a ...any) { fmt.Printf(format+"\n", a...) })
	if err != nil {
		return err
	}
	if n == 0 {
		fmt.Printf("fleet %s: nothing to remove\n", *name)
	}
	return nil
}

// buildSite builds a Dockerfile directory for a template, as `snowglobe build` does, for running
// natively (--sandbox).
func buildSite(dir, out, network string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{"build", dir, "--out", out, "--sandbox"}
	if network != "" {
		args = append(args, "--network", network)
	}
	cmd := exec.Command(self, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var x *exec.ExitError
		if errors.As(err, &x) {
			return fmt.Errorf("snowglobe build %s exited %d", dir, x.ExitCode())
		}
		return err
	}
	return nil
}
