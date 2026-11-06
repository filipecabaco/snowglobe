package daemon

import (
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
)

// PortMapping is a host port the daemon holds and the guest port it leads to: a machine's
// (`up -p`), or a service's, whose connections go to its replicas.
type PortMapping struct {
	IP    string `json:"ip"`
	Host  int    `json:"host"`
	Guest int    `json:"guest"`
	// "machine" or "service", and its name and template
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Template string `json:"template"`
	// The daemon is listening on it now
	Open bool `json:"open"`
	// A service's replicas running now (0: at zero, the next connection starts one)
	Replicas int `json:"replicas,omitempty"`
}

// Ports is every port mapping, by host port.
func (s *Server) Ports() []PortMapping {
	out := []PortMapping{}
	s.mu.Lock()
	for _, m := range s.st.Machines {
		_, open := s.forwards[m.Name]
		for _, p := range m.Ports {
			out = append(out, PortMapping{IP: p.IP, Host: p.Host, Guest: p.Guest, Kind: "machine", Name: m.Name, Template: m.Template, Open: open})
		}
	}
	s.mu.Unlock()
	for _, svc := range s.Services() {
		s.svc.mu.Lock()
		_, open := s.svc.listeners[svc.Name]
		s.svc.mu.Unlock()
		for _, p := range svc.Ports {
			out = append(out, PortMapping{IP: p.IP, Host: p.Host, Guest: p.Guest, Kind: "service", Name: svc.Name, Template: svc.Template,
				Open: open, Replicas: len(svc.Replicas)})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].IP < out[j].IP
	})
	return out
}

// PortCheck says whether a host port is free to forward, and if not, what holds it.
type PortCheck struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
	Free bool   `json:"free"`
	// What holds it: "machine NAME" or "service NAME" of this daemon, or "another program"
	By string `json:"by,omitempty"`
	// What the system said, when another program holds it
	Detail string `json:"detail,omitempty"`
}

// CheckPort says whether host port port on ip (127.0.0.1 when empty) is free: not one of the
// daemon's, and one this host lets it listen on now.
func (s *Server) CheckPort(ip string, port int) (*PortCheck, error) {
	if ip == "" {
		ip = "127.0.0.1"
	}
	if net.ParseIP(ip) == nil {
		return nil, errStatus(400, "ip: an address")
	}
	if port < 1 || port > 65535 {
		return nil, errStatus(400, "port: 1 to 65535")
	}
	c := &PortCheck{IP: ip, Port: port}
	for _, m := range s.Ports() {
		if m.Host == port && overlaps(m.IP, ip) {
			c.By = m.Kind + " " + m.Name
			return c, nil
		}
	}
	l, err := net.Listen("tcp", net.JoinHostPort(ip, strconv.Itoa(port)))
	if err != nil {
		c.By, c.Detail = "another program", err.Error()
		return c, nil
	}
	l.Close()
	c.Free = true
	return c, nil
}

// overlaps says whether two listening addresses can't both take a port: the same address, or
// either being every address.
func overlaps(a, b string) bool {
	any := func(ip string) bool { return ip == "0.0.0.0" || ip == "::" || ip == "" }
	return a == b || any(a) || any(b)
}

func (s *Server) portRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/ports", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Ports(), nil)
	})
	mux.HandleFunc("GET /v1/ports/check", func(w http.ResponseWriter, r *http.Request) {
		port, err := strconv.Atoi(r.URL.Query().Get("port"))
		if err != nil {
			reply(w, nil, errStatus(400, "port: a number"))
			return
		}
		v, err := s.CheckPort(r.URL.Query().Get("ip"), port)
		reply(w, v, err)
	})
}

// Describe is a mapping as a line: 127.0.0.1:8080 → web:8000 (machine of py).
func (m PortMapping) Describe() string {
	state := "open"
	if !m.Open {
		state = "not listening"
	}
	if m.Kind == "service" {
		state = fmt.Sprintf("%s, %d replicas", state, m.Replicas)
		if m.Replicas == 0 {
			state += " (at zero)"
		}
	}
	return fmt.Sprintf("%s:%d → %s %s:%d (template %s; %s)", m.IP, m.Host, m.Kind, m.Name, m.Guest, m.Template, state)
}
