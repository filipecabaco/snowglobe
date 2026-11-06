package build

import (
	"testing"

	"github.com/filipecabaco/snowglobe/internal/docker"
)

func image(labels map[string]string, cmd ...string) *docker.Image {
	img := &docker.Image{Architecture: "386"}
	img.Config.Cmd = cmd
	img.Config.Labels = labels
	return img
}

func TestResolveDefaults(t *testing.T) {
	s, err := Resolve(Options{Source: "alpine"}, image(nil, "/bin/sh"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Command != "'/bin/sh'" || s.Ready != "" || s.Memory != 512 || s.Title != "alpine" || s.Warm != nil {
		t.Errorf("%+v", s)
	}
}

func TestResolveLabelsThenFlags(t *testing.T) {
	labels := map[string]string{
		"snowglobe.title": "From label", "snowglobe.ready": "iex(1)> ", "snowglobe.memory": "256",
	}

	s, _ := Resolve(Options{}, image(labels, "iex"))
	if s.Title != "From label" || s.Ready != "iex(1)> " || s.Memory != 256 {
		t.Errorf("labels not applied: %+v", s)
	}

	s, _ = Resolve(Options{Title: "From flag", Memory: 128}, image(labels, "iex"))
	if s.Title != "From flag" || s.Memory != 128 {
		t.Errorf("flags should win: %+v", s)
	}
}

func TestResolveCmdDropsImageReady(t *testing.T) {
	labels := map[string]string{"snowglobe.ready": "iex(1)> "}

	s, _ := Resolve(Options{Cmd: "erl"}, image(labels, "iex"))
	if s.Command != "erl" || s.Ready != "" {
		t.Errorf("the image's ready marker belongs to its own command: %+v", s)
	}

	s, _ = Resolve(Options{Cmd: "erl", Ready: "1> "}, image(labels, "iex"))
	if s.Ready != "1> " {
		t.Errorf("an explicit --ready still applies: %+v", s)
	}
}

func TestResolveErrors(t *testing.T) {
	if _, err := Resolve(Options{}, image(nil)); err == nil {
		t.Error("an image with no command should need --cmd")
	}
	if _, err := Resolve(Options{}, image(map[string]string{"snowglobe.memory": "lots"}, "sh")); err == nil {
		t.Error("a non-numeric memory label should fail")
	}
	if _, err := Resolve(Options{Warm: "("}, image(nil, "sh")); err == nil {
		t.Error("a bad warm pattern should fail")
	}
}

func TestResolveExercise(t *testing.T) {
	labels := map[string]string{"snowglobe.exercise": `["h Enum.map", "1 + 1"]`}

	s, _ := Resolve(Options{}, image(labels, "iex"))
	if len(s.Exercise) != 2 || s.Exercise[0] != "h Enum.map" {
		t.Errorf("label exercises: %+v", s.Exercise)
	}

	s, _ = Resolve(Options{Cmd: "erl"}, image(labels, "iex"))
	if len(s.Exercise) != 0 {
		t.Errorf("exercises belong to the image's own command: %+v", s.Exercise)
	}

	if _, err := Resolve(Options{}, image(map[string]string{"snowglobe.exercise": "h Enum"}, "iex")); err == nil {
		t.Error("a non-JSON exercise label should fail")
	}
}

func TestResolveNetwork(t *testing.T) {
	s, _ := Resolve(Options{}, image(nil, "sh"))
	if s.Network != "none" {
		t.Errorf("networking should be off by default: %q", s.Network)
	}
	s, _ = Resolve(Options{}, image(map[string]string{"snowglobe.network": "fetch"}, "sh"))
	if s.Network != "fetch" {
		t.Errorf("label: %q", s.Network)
	}
	if _, err := Resolve(Options{Network: "carrier-pigeon"}, image(nil, "sh")); err == nil {
		t.Error("an unknown backend should fail")
	}
}

func TestResolveTunnels(t *testing.T) {
	labels := map[string]string{"snowglobe.network": "fetch", "snowglobe.tunnels": `["db:5432=wss://proxy/db"]`}
	s, err := Resolve(Options{}, image(labels, "sh"))
	if err != nil || len(s.Tunnels) != 1 || s.Tunnels[0].Host != "db" || s.Tunnels[0].URL != "wss://proxy/db" {
		t.Fatalf("from the label: %+v, %v", s, err)
	}
	s, _ = Resolve(Options{Tunnels: []string{"5432=ws://127.0.0.1:6543", "6379=ws://127.0.0.1:6544"}}, image(labels, "sh"))
	if len(s.Tunnels) != 2 || s.Tunnels[0].Host != "" {
		t.Errorf("flags replace the label: %+v", s.Tunnels)
	}
	if _, err := Resolve(Options{Tunnels: []string{"5432=ws://x"}}, image(nil, "sh")); err == nil {
		t.Error("tunnels without a network are an error")
	}
	if _, err := Resolve(Options{Network: "fetch", Tunnels: []string{"5432=tcp://x"}}, image(nil, "sh")); err == nil {
		t.Error("a tunnel to something other than ws:// or wss:// is an error")
	}
	if _, err := Resolve(Options{}, image(map[string]string{"snowglobe.network": "fetch", "snowglobe.tunnels": "db:5432"}, "sh")); err == nil {
		t.Error("the label must be a JSON array")
	}
	if _, err := Resolve(Options{Network: "fetch", Tunnels: []string{"5432=wss://gw/db?token={token}"}}, image(nil, "sh")); err == nil {
		t.Error("a {token} tunnel without a token endpoint is an error")
	}
	s, err = Resolve(Options{Network: "fetch", Tunnels: []string{"5432=wss://gw/db?token={token}"}},
		image(map[string]string{"snowglobe.tunnel-token": "https://gw/token"}, "sh"))
	if err != nil || s.TunnelToken != "https://gw/token" {
		t.Errorf("token endpoint from the label: %q, %v", s.TunnelToken, err)
	}
}

func TestResolveAgentIsOptIn(t *testing.T) {
	s, _ := Resolve(Options{}, image(nil, "sh"))
	if s.Agent || Page(s, "v1").Agent {
		t.Errorf("agent jobs are off unless asked for: %+v", s)
	}
	s, _ = Resolve(Options{}, image(map[string]string{"snowglobe.agent": "true", "snowglobe.agent-exposed-to": `["https://agent.example"]`}, "sh"))
	if !s.Agent || len(s.AgentExposedTo) != 1 || s.AgentExposedTo[0] != "https://agent.example" {
		t.Errorf("labels: %+v", s)
	}
	p := Page(s, "v1.2.3")
	if !p.Agent || p.Version != "v1.2.3" || len(p.AgentExposedTo) != 1 {
		t.Errorf("page: %+v", p)
	}
	s, _ = Resolve(Options{Agent: true, AgentExposedTo: []string{"https://a.example:8443"}}, image(map[string]string{"snowglobe.agent": "false"}, "sh"))
	if !s.Agent || s.AgentExposedTo[0] != "https://a.example:8443" {
		t.Errorf("the flag wins: %+v", s)
	}
	for _, bad := range []Options{
		{AgentExposedTo: []string{"https://a.example"}},                   // without --agent
		{Agent: true, AgentExposedTo: []string{"http://a.example"}},       // not https
		{Agent: true, AgentExposedTo: []string{"https://a.example/path"}}, // not an origin
		{Agent: true, AgentExposedTo: []string{"a.example"}},              // no scheme
	} {
		if _, err := Resolve(bad, image(nil, "sh")); err == nil {
			t.Errorf("%+v should fail", bad)
		}
	}
	if _, err := Resolve(Options{}, image(map[string]string{"snowglobe.agent": "yes please"}, "sh")); err == nil {
		t.Error("a label that isn't a boolean should fail")
	}
}
