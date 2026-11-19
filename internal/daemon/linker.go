package daemon

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/filipecabaco/snowglobe/internal/control"
)

// A machine's link channel (control.Linker). The daemon confines a machine so that it connects
// to no Unix socket at all, its link sockets included: it can't reach its server's control
// socket, or another machine's. So the machine doesn't connect to its link sockets: it asks the
// daemon on this channel, and the daemon connects to the socket (one of that machine's, as the
// channel is) and hands the connection over as a descriptor. From there the socket's listener
// takes it as any other: it picks the target, wakes a service at zero, and splices.
//
// The daemon keeps its copy of a connection it handed over until the machine says it got it
// ({"got":ID}). A descriptor on its way whose last copy outside is closed may be taken for garbage
// by the kernel, and flushed (macOS does, when other Unix sockets close meanwhile): the guest
// would get a connection that ends at once.

// openLinker opens machine name's link channel, unless it has one.
func (s *Server) openLinker(name, sock string) {
	s.mu.Lock()
	_, open := s.linkers[name]
	s.mu.Unlock()
	if open {
		return
	}
	c, r, err := control.Linker(sock)
	if err != nil {
		s.note("link.error", "machine "+name, "%v", err)
		return
	}
	s.mu.Lock()
	_, open = s.linkers[name]
	_, alive := s.st.Machines[name]
	if open || !alive {
		s.mu.Unlock()
		c.Close()
		return
	}
	s.linkers[name] = c
	s.mu.Unlock()
	go s.serveLinker(name, c, r)
}

// linkOpen is what a machine says on its link channel: a connection it asks for, or one it got.
type linkOpen struct {
	Open *uint64 `json:"open"`
	URL  string  `json:"url"`
	Got  *uint64 `json:"got"`
}

// linkHoldMax is how long the daemon keeps its copy of a connection the machine never says it got
const linkHoldMax = 30 * time.Second

// heldConns are the connections a channel handed over that the machine hasn't said it got.
type heldConns struct {
	mu    sync.Mutex
	conns map[uint64]*net.UnixConn
}

// hold keeps c, the copy of connection id, until release(id), or for at most max.
func (h *heldConns) hold(id uint64, c *net.UnixConn, max time.Duration) {
	h.mu.Lock()
	if h.conns == nil {
		h.conns = map[uint64]*net.UnixConn{}
	}
	h.conns[id] = c
	h.mu.Unlock()
	time.AfterFunc(max, func() { h.release(id) })
}

// release closes the copy of connection id, if it is still kept.
func (h *heldConns) release(id uint64) {
	h.mu.Lock()
	c := h.conns[id]
	delete(h.conns, id)
	h.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

// closeAll closes every copy kept (the channel is gone).
func (h *heldConns) closeAll() {
	h.mu.Lock()
	cs := h.conns
	h.conns = nil
	h.mu.Unlock()
	for _, c := range cs {
		c.Close()
	}
}

func (h *heldConns) len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// serveLinker answers machine name's requests on its link channel c until it closes.
func (s *Server) serveLinker(name string, c *net.UnixConn, r *bufio.Reader) {
	var held heldConns
	defer held.closeAll()
	defer func() {
		s.mu.Lock()
		if s.linkers[name] == c {
			delete(s.linkers, name)
		}
		s.mu.Unlock()
		c.Close()
	}()
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var req linkOpen
		if json.Unmarshal(line, &req) != nil {
			continue
		}
		if req.Got != nil {
			held.release(*req.Got)
			continue
		}
		if req.Open == nil {
			continue
		}
		answer := map[string]any{"id": *req.Open}
		conn, err := s.dialLink(name, req.URL)
		if err != nil {
			answer["error"] = err.Error()
			s.note("link.error", "machine "+name, "%v", err)
		}
		data, _ := json.Marshal(answer)
		data = append(data, '\n')
		if conn == nil {
			if _, err := c.Write(data); err != nil {
				return
			}
			continue
		}
		if err := sendConn(c, data, conn); err != nil {
			conn.Close()
			return
		}
		held.hold(*req.Open, conn, linkHoldMax)
	}
}

// dialLink connects to machine name's socket for the link at url (unix://PATH, as SetLinks gave
// it): one of its own, never another machine's.
func (s *Server) dialLink(name, url string) (*net.UnixConn, error) {
	path, ok := strings.CutPrefix(url, "unix://")
	s.mu.Lock()
	mine := false
	for _, ls := range s.linkSocks[name] {
		mine = mine || ok && ls.path == path
	}
	s.mu.Unlock()
	if !mine {
		return nil, fmt.Errorf("no link of its at %s", url)
	}
	conn, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("its link at %s: %w", url, err)
	}
	return conn.(*net.UnixConn), nil
}

// sendConn writes data on c with conn's descriptor alongside it.
func sendConn(c *net.UnixConn, data []byte, conn *net.UnixConn) error {
	f, err := conn.File()
	if err != nil {
		return err
	}
	defer f.Close()
	n, _, err := c.WriteMsgUnix(data, syscall.UnixRights(int(f.Fd())), nil)
	if err == nil && n < len(data) {
		// The rest (an answer is far smaller than a socket's buffer)
		_, err = c.Write(data[n:])
	}
	return err
}
