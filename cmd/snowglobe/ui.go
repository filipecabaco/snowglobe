package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/ui"
)

// runUI: ui [--port 7777] [--no-open] — the daemon in a browser, on 127.0.0.1.
func runUI(args []string) error {
	fs := flag.NewFlagSet("ui", flag.ContinueOnError)
	port := fs.Int("port", 7777, "")
	noOpen := fs.Bool("no-open", false, "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if _, err := parse(fs, args); err != nil {
		return err
	}
	c, err := daemonClient()
	if err != nil {
		return err
	}
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		// Taken: any free port
		if l, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			return err
		}
	}
	s := &ui.Server{API: c.Proxy(), Token: ui.NewToken()}
	url := fmt.Sprintf("http://%s/?token=%s", l.Addr(), s.Token)
	fmt.Printf("snowglobe ui for the daemon at %s:\n  %s\n(only this link opens it; ctrl-c stops it)\n", c.Addr, url)
	if !*noOpen {
		openBrowser(url)
	}
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	if err := srv.Serve(l); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start()
}
