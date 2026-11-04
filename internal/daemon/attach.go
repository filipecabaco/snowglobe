package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

// serveAttach joins a machine's terminal over a WebSocket (/v1/machines/{name}/attach?rows=R&cols=C):
// the screen so far, then what the machine prints as binary messages; what the client sends is
// typed in. A new size takes a new connection (the screen is replayed).
//
// Origins aren't checked here: the API is only reachable on the daemon's own socket (0600) or
// with its token, and a browser comes through `snowglobe ui`, which checks them.
func (s *Server) serveAttach(w http.ResponseWriter, r *http.Request) {
	m, err := s.Machine(r.PathValue("name"))
	if err != nil {
		reply(w, nil, err)
		return
	}
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	if rows <= 0 || rows > 500 {
		rows = 24
	}
	if cols <= 0 || cols > 500 {
		cols = 80
	}
	vm, err := net.DialTimeout("unix", m.Socket, 5*time.Second)
	if err != nil {
		reply(w, nil, errStatus(502, "machine %s: %v", m.Name, err))
		return
	}
	defer vm.Close()
	hello, _ := json.Marshal(map[string]any{"mode": "attach", "rows": rows, "cols": cols})
	if _, err := vm.Write(append(hello, '\n')); err != nil {
		reply(w, nil, errStatus(502, "machine %s: %v", m.Name, err))
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(1 << 20)
	// A service's replica is busy while someone is on its terminal
	if m.Labels[serviceLabel] != "" {
		s.touch(m.Name, 1)
		defer s.touch(m.Name, -1)
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// The machine's output to the client
	go func() {
		defer cancel()
		buf := make([]byte, 32<<10)
		for {
			n, err := vm.Read(buf)
			if n > 0 {
				if ws.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				ws.Close(websocket.StatusNormalClosure, fmt.Sprintf("machine %s: its terminal closed", m.Name))
				return
			}
		}
	}()
	// The client's keys to the machine
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if _, err := vm.Write(data); err != nil {
			return
		}
	}
}
