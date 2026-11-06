package fleet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/daemon"
)

func TestTheRegistryKeepsFleetsLikeComposeProjects(t *testing.T) {
	dir := t.TempDir()
	reg := NewRegistry(dir)
	api := newFake()

	// Written here: a new fleet's file goes in the daemon's directory
	e, err := reg.Write("web", "[templates.py]\nsite = \"/sites/py\"\n")
	if err != nil {
		t.Fatal(err)
	}
	if e.File != filepath.Join(dir, "fleets", "web", "snowglobe.toml") {
		t.Errorf("file: %s", e.File)
	}
	// A file that doesn't load is refused, and the old one stays
	if _, err := reg.Write("web", "[templates.py]\n"); err == nil || !strings.Contains(err.Error(), "one of site, build or snapshot") {
		t.Errorf("a bad file: %v", err)
	}
	if text, _ := readText(e.File); !strings.Contains(text, "/sites/py") {
		t.Errorf("the old file: %q", text)
	}
	if _, err := reg.Write("web", "name = \"other\"\n[templates.py]\nsite = \"/sites/py\"\n"); err == nil || !strings.Contains(err.Error(), "this fleet is web") {
		t.Errorf("a file naming another fleet: %v", err)
	}

	// Added from where it is
	elsewhere := filepath.Join(t.TempDir(), "todo")
	os.MkdirAll(elsewhere, 0o755)
	os.WriteFile(filepath.Join(elsewhere, "snowglobe.toml"), []byte("[templates.db]\nsite = \"/sites/db\"\n"), 0o644)
	if _, err := reg.Add(filepath.Join(elsewhere, "snowglobe.toml")); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Add("relative/snowglobe.toml"); err == nil {
		t.Error("a relative path was added")
	}
	// A fleet only labels name shows too
	api.templates["old"] = daemonTemplate("old", "legacy")
	fs, err := reg.Fleets(api)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range fs {
		names = append(names, f.Name)
		if f.Name == "web" && (f.Pending != 1 || !f.Owned) {
			t.Errorf("web: %+v", f)
		}
		if f.Name == "legacy" && (f.File != "" || f.Objects != 1) {
			t.Errorf("legacy: %+v", f)
		}
	}
	if strings.Join(names, ",") != "legacy,todo,web" {
		t.Errorf("fleets: %v", names)
	}
	// Forgetting a fleet the daemon wrote removes its file; an added one's stays
	if err := reg.Forget("web"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.File); !os.IsNotExist(err) {
		t.Errorf("web's file after forgetting it: %v", err)
	}
	reg.Forget("todo")
	if _, err := os.Stat(filepath.Join(elsewhere, "snowglobe.toml")); err != nil {
		t.Errorf("todo's own file: %v", err)
	}
}

func daemonTemplate(name, fleet string) daemon.Template {
	return daemon.Template{Name: name, Labels: map[string]string{FleetLabel: fleet}}
}
