package daemon

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestAMachinesTerminalOverAWebSocket(t *testing.T) {
	t.Setenv("SNOWGLOBE_FAKE_VM", "serve")
	dir := shortTemp(t)
	d := startDaemon(t, dir, Options{})
	defer d.stop(t)
	d.c.AddTemplate(AddTemplate{Site: fakeSite(t), Name: "t"})
	defer d.c.RemoveTemplate("t")
	d.c.Up(Up{Template: "t", Name: "m"})

	sock := filepath.Join(dir, "daemon.sock")
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://daemon/v1/machines/m/attach?rows=30&cols=100", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	read := func() string {
		t.Helper()
		_, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if got := read(); got != "screen 30x100\r\n" {
		t.Errorf("the screen, at the size asked for: %q", got)
	}
	ws.Write(ctx, websocket.MessageText, []byte("ls\r"))
	if got := read(); got != "ls\r" {
		t.Errorf("typed in: %q", got)
	}

	// No such machine: no upgrade
	_, resp, err := websocket.Dial(ctx, "ws://daemon/v1/machines/nope/attach", &websocket.DialOptions{HTTPClient: client})
	if err == nil || resp == nil || resp.StatusCode != 404 {
		t.Errorf("no machine: %v %v", resp, err)
	}
}
