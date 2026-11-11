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
	if s.Kernel != "linux" || userArgv(s) != nil || Page(s, "test").NativeOnly {
		t.Errorf("a site has a kernel unless asked otherwise: %+v", s)
	}

	// The image's own command, word for word, is the program; one CPU to build and run on
	img := image(map[string]string{"snowglobe.kernel": "none"}, "hold", "a b")
	img.Config.Entrypoint = []string{"/probe"}
	s, err = Resolve(Options{}, img)
	if err != nil {
		t.Fatal(err)
	}
	if s.Kernel != "none" || !slices.Equal(userArgv(s), []string{"/probe", "hold", "a b"}) || s.BuildCPUs != 1 {
		t.Errorf("the label: %+v", s)
	}
	if !Page(s, "test").NativeOnly {
		t.Error("a page with no kernel says it runs natively")
	}
	s, err = Resolve(Options{Kernel: "none", Cmd: "/app serve --port 1"}, image(nil, "sh"))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(userArgv(s), []string{"/app", "serve", "--port", "1"}) {
		t.Errorf("--cmd is split into words: %q", userArgv(s))
	}

	// What a machine with no kernel can't do yet
	for name, o := range map[string]Options{
		"a network":      {Kernel: "none", Network: "fetch"},
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
