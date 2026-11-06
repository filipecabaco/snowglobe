package daemon

import (
	"fmt"
	"net/http"
	"sort"
	"time"
)

// Graph is the daemon as nodes and edges: what runs, what each was made from, what reaches what
// (links), and what the outside reaches (host ports). The UI draws it; agents read it.
type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// Node is a template, service, machine, snapshot, or a host port (kind "port").
type Node struct {
	// kind:name, unique in the graph
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	// "live", "asleep", "idle" (a service at zero, a port no one listens on) or "saved"
	State string `json:"state"`
	// What it is, in a few words ("of python", "2 of 0–4 replicas", "127.0.0.1:8080")
	Detail   string            `json:"detail,omitempty"`
	Template string            `json:"template,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	Since    *time.Time        `json:"since,omitempty"`
	// The fleet and instance it belongs to, if any
	Fleet    string `json:"fleet,omitempty"`
	Instance string `json:"instance,omitempty"`
}

// Edge goes from one node to another: "fork" (a template's machine), "serves" (a template's
// service), "replica" (a service's machine), "link" (a link: the rule, between what it names, as
// Label), "reach" (a machine that takes a link, to what its connections go to now), "port" (a
// host port to what it leads), "saved" (a machine's snapshot), "made" (a snapshot's template).
type Edge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
	// For a link: its name, to remove it
	Link string `json:"link,omitempty"`
}

// Graph is the daemon now.
func (s *Server) Graph() Graph {
	g := Graph{Nodes: []Node{}, Edges: []Edge{}}
	id := func(kind, name string) string { return kind + ":" + name }
	for _, t := range s.Templates() {
		state := "live"
		if t.Asleep {
			state = "asleep"
		}
		started := t.Started
		g.Nodes = append(g.Nodes, Node{ID: id(KindTemplate, t.Name), Kind: KindTemplate, Name: t.Name, State: state, Labels: t.Labels, Since: &started})
		if t.Snapshot != "" {
			g.Edges = append(g.Edges, Edge{From: id("snapshot", t.Snapshot), To: id(KindTemplate, t.Name), Kind: "made"})
		}
	}
	for _, sv := range s.Services() {
		state := "live"
		if len(sv.Replicas) == 0 {
			state = "idle"
		}
		created := sv.Created
		g.Nodes = append(g.Nodes, Node{ID: id(KindService, sv.Name), Kind: KindService, Name: sv.Name, State: state, Template: sv.Template,
			Detail: fmt.Sprintf("%d of %d–%d replicas", len(sv.Replicas), sv.Min, sv.Max), Labels: sv.Labels, Since: &created})
		g.Edges = append(g.Edges, Edge{From: id(KindTemplate, sv.Template), To: id(KindService, sv.Name), Kind: "serves"})
	}
	for _, m := range s.Machines(nil) {
		created := m.Created
		g.Nodes = append(g.Nodes, Node{ID: id(KindMachine, m.Name), Kind: KindMachine, Name: m.Name, State: "live", Template: m.Template,
			Labels: m.Labels, Since: &created})
		if svc := m.Labels[serviceLabel]; svc != "" {
			g.Edges = append(g.Edges, Edge{From: id(KindService, svc), To: id(KindMachine, m.Name), Kind: "replica"})
		} else {
			g.Edges = append(g.Edges, Edge{From: id(KindTemplate, m.Template), To: id(KindMachine, m.Name), Kind: "fork"})
		}
	}
	for _, sn := range s.Snapshots() {
		created := sn.Created
		g.Nodes = append(g.Nodes, Node{ID: id("snapshot", sn.Name), Kind: "snapshot", Name: sn.Name, State: "saved", Template: sn.Template,
			Labels: sn.Labels, Since: &created})
		if s.hasLocked(KindMachine, sn.Machine) {
			g.Edges = append(g.Edges, Edge{From: id(KindMachine, sn.Machine), To: id("snapshot", sn.Name), Kind: "saved"})
		}
	}
	for _, p := range s.Ports() {
		pid := id("port", fmt.Sprintf("%s:%d", p.IP, p.Host))
		state := "live"
		if p.Kind == KindService && p.Replicas == 0 || p.Kind == KindMachine && !p.Open {
			state = "idle"
		}
		g.Nodes = append(g.Nodes, Node{ID: pid, Kind: "port", Name: fmt.Sprintf("%s:%d", p.IP, p.Host), State: state, Template: p.Template,
			Detail: fmt.Sprintf("to %s %s:%d", p.Kind, p.Name, p.Guest)})
		g.Edges = append(g.Edges, Edge{From: pid, To: id(p.Kind, p.Name), Kind: "port", Label: fmt.Sprintf("%d→%d", p.Host, p.Guest)})
	}
	machines := s.Machines(nil)
	for _, l := range s.Links() {
		label := fmt.Sprintf("%s:%d", l.As, l.AsPort)
		g.Edges = append(g.Edges, Edge{From: id(l.FromKind, l.From), To: id(l.ToKind, l.To), Kind: "link", Label: label, Link: l.Name})
		// What each machine taking it reaches
		var to []string
		switch l.ToKind {
		case KindTemplate:
			for _, m := range machines {
				if m.Template == l.To && (l.Instance == "" || m.Labels[InstanceLabel] == l.Instance) {
					to = append(to, id(KindMachine, m.Name))
				}
			}
		default:
			to = []string{id(l.ToKind, l.To)}
		}
		for _, m := range machines {
			if !takes(&l, &m) {
				continue
			}
			for _, t := range to {
				if t != id(KindMachine, m.Name) {
					g.Edges = append(g.Edges, Edge{From: id(KindMachine, m.Name), To: t, Kind: "reach", Label: label, Link: l.Name})
				}
			}
		}
	}
	// Fleets and instances, from labels
	for i, n := range g.Nodes {
		g.Nodes[i].Fleet = n.Labels["snowglobe.fleet"]
		g.Nodes[i].Instance = n.Labels[InstanceLabel]
	}
	sort.SliceStable(g.Nodes, func(i, j int) bool { return g.Nodes[i].ID < g.Nodes[j].ID })
	return g
}

func (s *Server) graphRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/graph", func(w http.ResponseWriter, r *http.Request) {
		reply(w, s.Graph(), nil)
	})
}
