package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

// runEvents prints the daemon's events (the ones it kept, then each as it happens) until
// interrupted: a line each, or JSON with --json.
func runEvents(args []string) error {
	fs := flag.NewFlagSet("events", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	after := fs.Int64("after", 0, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return c.Events(ctx, *after, func(ev daemon.Event) bool {
		if *asJSON {
			data, _ := json.Marshal(ev)
			fmt.Println(string(data))
		} else {
			fmt.Println(eventLine(ev))
		}
		return true
	})
}

func eventLine(ev daemon.Event) string {
	return fmt.Sprintf("%s  %-24s %-20s %s", ev.Time.Format("15:04:05"), ev.Kind, ev.Subject, ev.Message)
}

// runTop shows the daemon live, redrawn every second: memory, templates, services, machines and
// its latest events. --once prints it once.
func runTop(args []string) error {
	fs := flag.NewFlagSet("top", flag.ContinueOnError)
	once := fs.Bool("once", false, "")
	every := fs.Duration("every", time.Second, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var mu sync.Mutex
	var recent []daemon.Event
	if !*once {
		go c.Events(ctx, 0, func(ev daemon.Event) bool {
			mu.Lock()
			recent = append(recent, ev)
			if len(recent) > 8 {
				recent = recent[len(recent)-8:]
			}
			mu.Unlock()
			return true
		})
	}
	for {
		mu.Lock()
		evs := append([]daemon.Event(nil), recent...)
		mu.Unlock()
		var b strings.Builder
		if err := top(&b, c, evs); err != nil {
			return err
		}
		if *once {
			fmt.Print(b.String())
			return nil
		}
		// Home, then the frame, clearing what the last one left below it
		fmt.Print("\033[H\033[2J" + b.String())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(*every):
		}
	}
}

func top(w io.Writer, c *daemon.Client, events []daemon.Event) error {
	st, err := c.Stats()
	if err != nil {
		return err
	}
	ts, err := c.Templates()
	if err != nil {
		return err
	}
	svcs, err := c.Services()
	if err != nil {
		return err
	}
	ms, err := c.Machines(nil)
	if err != nil {
		return err
	}
	budget := "no budget"
	if st.MemoryBudget > 0 {
		budget = fmt.Sprintf("budget %s (%d%%)", mbs(st.MemoryBudget), st.MemoryUsed*100/st.MemoryBudget)
	}
	fmt.Fprintf(w, "snowglobe daemon %s   memory %s, %s\n", c.Addr, mbs(st.MemoryUsed), budget)
	fmt.Fprintf(w, "%d templates (%d awake), %d machines, %d services, %d snapshots\n\n",
		st.Templates, st.TemplatesAwake, st.Machines, st.Services, st.Snapshots)

	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "TEMPLATE\tSERVER\tMEMORY\tMACHINES")
	count := map[string]int{}
	for _, m := range ms {
		count[m.Template]++
	}
	for _, t := range ts {
		server, mem := fmt.Sprintf("pid %d", t.Pid), mbs(st.Memory["template/"+t.Name])
		if t.Asleep {
			server, mem = "asleep", "–"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%d\n", t.Name, server, mem, count[t.Name])
	}
	if len(svcs) > 0 {
		fmt.Fprintln(tw, "\t\t\t")
		fmt.Fprintln(tw, "SERVICE\tREPLICAS\tCONNECTIONS\tPORTS")
		for _, s := range svcs {
			active := 0
			for _, r := range s.Replicas {
				active += r.Active
			}
			var ports []string
			for _, p := range s.Ports {
				ports = append(ports, p.String())
			}
			fmt.Fprintf(tw, "%s\t%d (%d–%d)\t%d\t%s\n", s.Name, len(s.Replicas), s.Min, s.Max, active, strings.Join(ports, ", "))
		}
	}
	if len(ms) > 0 {
		fmt.Fprintln(tw, "\t\t\t")
		fmt.Fprintln(tw, "MACHINE\tTEMPLATE\tMEMORY\tUP")
		for _, m := range ms {
			up := time.Since(m.Created).Round(time.Second).String()
			if m.Expires != nil {
				up += fmt.Sprintf(" (stops in %s)", time.Until(*m.Expires).Round(time.Second))
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", m.Name, m.Template, mbs(st.Memory[m.Name]), up)
		}
	}
	tw.Flush()
	if len(events) > 0 {
		fmt.Fprintln(w, "\nRECENT")
		for _, ev := range events {
			fmt.Fprintln(w, eventLine(ev))
		}
	}
	return nil
}

func mbs(n int64) string { return fmt.Sprintf("%d MB", n>>20) }
