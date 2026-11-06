package fleet

import (
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

const todo = `name = "todo"
[templates.db]
site = "/sites/db"
expose = [5432]
[templates.app]
site = "/sites/app"
egress = "internet"
[services.db]
template = "db"
ports = ["15432:5432"]
[services.app]
template = "app"
ports = ["8080:4000"]
[links.app-db]
from = "app"
to = "db"
port = 5432
as = "db.internal"
`

func applyAll(t *testing.T, f *File, api *fake, inst string) {
	t.Helper()
	p, err := f.PlanInstance(api, inst)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(api, nil, quiet); err != nil {
		t.Fatal(err)
	}
}

func TestInstancesShareTemplatesAndKeepToThemselves(t *testing.T) {
	f := load(t, todo)
	api := newFake()
	applyAll(t, f, api, Main)
	// Egress: none unless the file says
	if api.templates["db"].Labels == nil {
		t.Fatal("no db template")
	}
	calls := strings.Join(api.calls, "\n")
	if !strings.Contains(calls, "add link app-db template:app service:db") {
		t.Errorf("main's link: %s", calls)
	}
	if l := api.links["app-db"]; l.Instance != Main {
		t.Errorf("main's link isn't kept to main: %+v", l)
	}

	// A second instance: its own services and link, the same templates, ports the system picks
	api.calls = nil
	p, err := f.PlanInstance(api, "2")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range p.Steps {
		if !s.PerInstance {
			t.Errorf("instance 2 would make a shared %s %s", s.Kind, s.Name)
		}
	}
	applyAll(t, f, api, "2")
	calls = strings.Join(api.calls, "\n")
	for _, want := range []string{"add service db-2", "add service app-2", "add link app-db-2 template:app service:db-2"} {
		if !strings.Contains(calls, want) {
			t.Errorf("no %q in:\n%s", want, calls)
		}
	}
	if strings.Contains(calls, "add template") {
		t.Errorf("instance 2 made templates:\n%s", calls)
	}
	if ports := api.services["db-2"].Ports; len(ports) != 1 || ports[0].Host != 0 || ports[0].Guest != 5432 {
		t.Errorf("db-2's ports: %+v", ports)
	}
	if l := api.links["app-db-2"]; l.Instance != "2" || l.As != "db.internal" {
		t.Errorf("instance 2's link: %+v", l)
	}
	if inst, _ := Instances(api, "todo"); strings.Join(inst, ",") != "main,2" {
		t.Errorf("instances: %v", inst)
	}
	// Each instance's plan is done; main's doesn't see 2's things as extra
	for _, i := range []string{Main, "2"} {
		if p, _ := f.PlanInstance(api, i); !p.Empty() {
			t.Errorf("instance %s after applying: %v", i, steps(p))
		}
	}
	// Taking instance 2 down leaves main and the templates
	if _, err := DownInstance(api, "todo", "2", quiet); err != nil {
		t.Fatal(err)
	}
	if _, ok := api.services["db-2"]; ok {
		t.Error("db-2 is still there")
	}
	if _, ok := api.services["db"]; !ok || len(api.templates) != 2 {
		t.Errorf("main or the templates went: %v %v", api.services, api.templates)
	}
	if _, err := f.PlanInstance(api, "no spaces"); err == nil {
		t.Error("a bad instance name was planned")
	}
}

func TestNetworkModesResolveLinks(t *testing.T) {
	for mode, want := range map[string][]string{
		// Across instances: template to the target's template
		"inclusive": {"add link app-db template:app template:db"},
		// And every template to every other's exposed ports
		"all": {"add link app-db template:app template:db", "add link all-app-db-5432 template:app template:db"},
	} {
		f := load(t, strings.Replace(todo, `name = "todo"`, `name = "todo"`+"\n[network]\nmode = \""+mode+"\"", 1))
		api := newFake()
		applyAll(t, f, api, Main)
		calls := strings.Join(api.calls, "\n")
		for _, w := range want {
			if !strings.Contains(calls, w) {
				t.Errorf("%s: no %q in:\n%s", mode, w, calls)
			}
		}
		for _, l := range api.links {
			if l.Instance != "" {
				t.Errorf("%s: link %s is kept to instance %s", mode, l.Name, l.Instance)
			}
		}
		// A second instance shares them
		api.calls = nil
		applyAll(t, f, api, "2")
		if strings.Contains(strings.Join(api.calls, "\n"), "add link") {
			t.Errorf("%s: instance 2 made links of its own: %v", mode, api.calls)
		}
	}
	if _, err := Load(write(t, "[network]\nmode = \"open\"\n")); err == nil || !strings.Contains(err.Error(), "exclusive, inclusive or all") {
		t.Errorf("a bad mode: %v", err)
	}
}

func TestEgressIsNoneUnlessTheFileSays(t *testing.T) {
	f := load(t, todo)
	api := newFake()
	var got []daemon.AddTemplate
	api.onAddTemplate = func(r daemon.AddTemplate) { got = append(got, r) }
	applyAll(t, f, api, Main)
	egress := map[string]string{}
	for _, r := range got {
		egress[r.Name] = r.Egress
	}
	if egress["db"] != "none" || egress["app"] != "internet" {
		t.Errorf("egress: %v", egress)
	}
	if _, err := Load(write(t, "[templates.a]\nsite = \"x\"\negress = \"lan\"\n")); err == nil {
		t.Error("egress lan was taken")
	}
}
