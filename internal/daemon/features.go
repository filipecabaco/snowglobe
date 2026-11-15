package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// Features are what a daemon does. A mode (snowglobe daemon --mode) is a named preset of them, so
// another kind of daemon is another preset: the routes are switched on and off by them in one
// place (Handler), not each by a check of its own.
type Features struct {
	// The preset's name, and what it says of itself when a request asks for what it is without
	Mode string `json:"mode"`
	Says string `json:"says,omitempty"`
	// Templates, and the sites uploaded for them; machines (attach, runs); jobs on either;
	// snapshots; services; links (and the graph); the host ports it forwards; fleets
	Templates bool `json:"templates"`
	Machines  bool `json:"machines"`
	Jobs      bool `json:"jobs"`
	Snapshots bool `json:"snapshots"`
	Services  bool `json:"services"`
	Links     bool `json:"links"`
	Ports     bool `json:"ports"`
	Fleets    bool `json:"fleets"`
	// The event stream and the metrics (the stats are always there)
	Events  bool `json:"events"`
	Metrics bool `json:"metrics"`
	// Builds of sites
	Builds bool `json:"builds"`
	// Every build is packed into an artifact to download (cached by what it was built of) and
	// makes no template: what a template provider gives back
	ArtifactsOnly bool `json:"artifacts_only,omitempty"`
	// The guest kernel a build asks for when its request names none ("": snowglobe build's own)
	Kernel string `json:"kernel,omitempty"`
}

// MCP says whether `snowglobe mcp --daemon` has what it serves.
func (f Features) MCP() bool { return f.Templates && f.Machines && f.Jobs }

// modes are the presets --mode names.
var modes = map[string]Features{
	// Everything: what the daemon always was
	"full": {Mode: "full", Templates: true, Machines: true, Jobs: true, Snapshots: true, Services: true, Links: true, Ports: true,
		Fleets: true, Events: true, Metrics: true, Builds: true},
	// A template provider: it builds images into sites for the browser and gives each back packed,
	// and nothing else. Nothing it builds runs here but the build.
	"provider": {Mode: "provider", Says: "builds only", Builds: true, ArtifactsOnly: true, Kernel: "none"},
}

// Mode is the preset called name.
func Mode(name string) (Features, error) {
	f, ok := modes[name]
	if !ok {
		var names []string
		for n := range modes {
			names = append(names, n)
		}
		sort.Strings(names)
		return Features{}, fmt.Errorf("mode %q: %s", name, strings.Join(names, " or "))
	}
	return f, nil
}

// Router is what routes are added to: a ServeMux, or one that answers them as off.
type Router interface {
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}

// off is a Router that keeps each route's pattern but answers it with a 404 saying the mode has
// it off: a client tells "not in this mode" from "no such thing" (Disabled).
type off struct {
	mux *http.ServeMux
	f   Features
}

func (o off) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	o.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		replyOff(w, o.f)
	})
}

// replyOff answers a request for what the daemon's mode has off.
func replyOff(w http.ResponseWriter, f Features) {
	msg := "the daemon runs in " + f.Mode + " mode"
	if f.Says != "" {
		msg += ": " + f.Says
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(404)
	json.NewEncoder(w).Encode(map[string]string{"error": msg, "mode": f.Mode})
}

// Version is what GET /v1/version answers: which snowglobe the daemon is, and what it does.
type Version struct {
	Version  string   `json:"version"`
	Mode     string   `json:"mode"`
	Features Features `json:"features"`
}
