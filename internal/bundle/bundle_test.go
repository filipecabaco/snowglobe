package bundle

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteRead(t *testing.T) {
	dir := t.TempDir()
	site := filepath.Join(dir, "site")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(site, "system", "filesystem"), 0o755))
	write := func(p, s string) { must(os.WriteFile(filepath.Join(site, p), []byte(s), 0o644)) }
	write("run.json", `{"title":"t"}`)
	write("system/state.bin.zst", "STATE")
	write("system/filesystem.json", `{"fsroot":[["bin",1,2,["abc123"]]],"version":3}`)
	write("system/filesystem/abc123", "BLOB")
	write("system/filesystem/unused", "NOT NAMED") // a pooled neighbour's: left out
	runtime := filepath.Join(dir, "vm")
	must(os.WriteFile(runtime, []byte("#!runtime"), 0o755))

	out := filepath.Join(dir, "app")
	s, err := Write(site, runtime, out)
	must(err)
	if s.Blobs != 1 || s.Runtime != 9 {
		t.Fatalf("stats %+v", s)
	}
	data, err := os.ReadFile(out)
	must(err)
	files, err := Read(data)
	must(err)
	get := func(name string) string {
		f, ok := files[name]
		if !ok {
			t.Fatalf("%s missing from %v", name, files)
		}
		return string(data[f[0] : f[0]+f[1]])
	}
	if get("run.json") != `{"title":"t"}` || get("system/state.bin.zst") != "STATE" || get("blob/abc123") != "BLOB" {
		t.Fatal("contents differ")
	}
	if _, ok := files["blob/unused"]; ok {
		t.Fatal("a blob the filesystem doesn't name was bundled")
	}

	// A bundle as the runtime contributes only its executable
	out2 := filepath.Join(dir, "app2")
	s2, err := Write(site, out, out2)
	must(err)
	if s2.Runtime != 9 {
		t.Fatalf("runtime from a bundle: %d bytes", s2.Runtime)
	}
}
