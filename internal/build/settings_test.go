package build

import (
	"slices"
	"strings"
	"testing"
)

func TestResolveJIT(t *testing.T) {
	for name, c := range map[string]struct {
		flag  string
		label string
		want  bool
	}{
		"the default":       {want: true},
		"the label":         {label: "off", want: false},
		"the flag":          {flag: "off", want: false},
		"the flag wins":     {flag: "on", label: "off", want: true},
		"the label says on": {label: "on", want: true},
	} {
		labels := map[string]string{}
		if c.label != "" {
			labels["snowglobe.jit"] = c.label
		}
		s, err := Resolve(Options{JIT: c.flag}, image(labels, "sh"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if s.JIT != c.want {
			t.Errorf("%s: jit %v, want %v", name, s.JIT, c.want)
		}
		if p := Page(s, "test"); p.JIT != c.want {
			t.Errorf("%s: the page's jit %v, want %v", name, p.JIT, c.want)
		}
	}
	if _, err := Resolve(Options{JIT: "fast"}, image(nil, "sh")); err == nil {
		t.Error("jit takes on or off")
	}
	if _, err := Resolve(Options{}, image(map[string]string{"snowglobe.jit": "yes"}, "sh")); err == nil {
		t.Error("the label takes on or off")
	}
}

func TestResolveKernel(t *testing.T) {
	s, err := Resolve(Options{}, image(nil, "sh"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Kernel != "linux" || userProgram(s) != nil || Page(s, "test").User {
		t.Errorf("a site has a kernel unless asked otherwise: %+v", s)
	}

	// The image's own command, word for word, is the program; one CPU in the page, several to build on
	img := image(map[string]string{"snowglobe.kernel": "none"}, "hold", "a b")
	img.Config.Entrypoint = []string{"/probe"}
	s, err = Resolve(Options{}, img)
	if err != nil {
		t.Fatal(err)
	}
	if s.Kernel != "none" || !slices.Equal(userProgram(s).Argv, []string{"/probe", "hold", "a b"}) || s.CPUs != 1 || s.BuildCPUs != DefaultBuildCPUs {
		t.Errorf("the label: %+v", s)
	}
	if !Page(s, "test").User {
		t.Error("a page with no kernel restores its program's process (user mode)")
	}
	s, err = Resolve(Options{Kernel: "none", Cmd: "/app serve --port 1"}, image(nil, "sh"))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(userProgram(s).Argv, []string{"/app", "serve", "--port", "1"}) {
		t.Errorf("--cmd is split into words: %q", userProgram(s).Argv)
	}

	// A network is the machine's, as with a kernel (user mode has sockets)
	s, err = Resolve(Options{Kernel: "none", Network: "fetch"}, image(nil, "sh"))
	if err != nil || s.Network != "fetch" {
		t.Errorf("a network with no kernel: %v %+v", err, s)
	}
	// An image that asks for CPUs (its label, for a kernel) has one in the page, and says so; it
	// builds on as many as a kernel's would
	s, err = Resolve(Options{}, image(map[string]string{"snowglobe.kernel": "none", "snowglobe.cpus": "2"}, "sh"))
	if err != nil || s.CPUs != 1 || s.BuildCPUs != DefaultBuildCPUs || s.SkippedCPUs != 2 {
		t.Errorf("an image's CPUs with no kernel: %v %+v", err, s)
	}

	// An image's memory with no kernel (its label nokernel-memory), unless --memory says
	withMem := map[string]string{"snowglobe.memory": "448", "snowglobe.nokernel-memory": "640"}
	if s, err = Resolve(Options{Kernel: "none"}, image(withMem, "sh")); err != nil || s.Memory != 640 {
		t.Errorf("nokernel-memory: %v %+v", err, s)
	}
	if s, err = Resolve(Options{}, image(withMem, "sh")); err != nil || s.Memory != 448 {
		t.Errorf("nokernel-memory is for no kernel only: %v %+v", err, s)
	}
	if s, err = Resolve(Options{Kernel: "none", Memory: 512}, image(withMem, "sh")); err != nil || s.Memory != 512 {
		t.Errorf("--memory wins over nokernel-memory: %v %+v", err, s)
	}

	// What a machine with no kernel can't do yet
	for name, o := range map[string]Options{
		"several CPUs":   {Kernel: "none", CPUs: 2},
		"exercises":      {Kernel: "none", Exercise: []string{"ls"}},
		"the agent page": {Kernel: "none", Agent: true},
		"another kernel": {Kernel: "bsd"},
	} {
		if _, err := Resolve(o, image(nil, "sh")); err == nil || !strings.Contains(err.Error(), "kernel") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestAProgramWithNoKernelHasTheImagesEnvironmentAndExercisesLeftOut(t *testing.T) {
	img := image(map[string]string{"snowglobe.kernel": "none", "snowglobe.exercise": `["print(1)", "2 + 2"]`}, "python3")
	img.Config.Env = []string{"PATH=/opt/venv/bin:/usr/bin", "LANG=C.UTF-8"}
	img.Config.WorkingDir = "/root"
	s, err := Resolve(Options{}, img)
	if err != nil {
		t.Fatal(err)
	}
	u := userProgram(s)
	if !slices.Equal(u.Env, img.Config.Env) || u.Cwd != "/root" || !slices.Equal(u.Argv, []string{"python3"}) {
		t.Errorf("the image's program, environment and working directory: %+v", u)
	}
	if len(s.Exercise) != 0 || s.SkippedExercises != 2 {
		t.Errorf("the image's exercises are left out, and counted: %v %d", s.Exercise, s.SkippedExercises)
	}
	if _, err := Resolve(Options{Exercise: []string{"x"}}, img); err == nil {
		t.Error("an exercise asked for with --exercise is refused")
	}
}

func TestAnImagesAgentLabelIsLeftOutWithNoKernel(t *testing.T) {
	labels := map[string]string{"snowglobe.kernel": "none", "snowglobe.agent": "true", "snowglobe.agent-exposed-to": `["https://agent.example"]`}
	s, err := Resolve(Options{}, image(labels, "duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Agent || s.AgentExposedTo != nil || !s.SkippedAgent {
		t.Errorf("the label is left out, and said so: %+v", s)
	}
	if _, err := Resolve(Options{Agent: true}, image(labels, "duckdb")); err == nil {
		t.Error("--agent is refused")
	}
}
