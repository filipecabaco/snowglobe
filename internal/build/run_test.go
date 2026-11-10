package build

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/filipecabaco/snowglobe/internal/oci"
	"github.com/filipecabaco/snowglobe/internal/tools"
)

// tarBytes is a tar holding files, in order.
func tarBytes(t *testing.T, files ...oci.File) []byte {
	t.Helper()
	r, err := oci.FilesLayer(files)()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// savedImage is `docker save` of an image for arch, with a shell and these labels: its file.
func savedImage(t *testing.T, arch string, labels map[string]string) string {
	t.Helper()
	cfg, _ := json.Marshal(map[string]any{"architecture": arch, "config": map[string]any{
		"Env": []string{"PATH=/bin"}, "WorkingDir": "/root", "Cmd": []string{"/bin/sh"}, "Labels": labels}})
	archive := tarBytes(t,
		oci.File{Name: "manifest.json", Mode: 0o644, Data: []byte(`[{"Config": "cfg.json", "Layers": ["l/layer.tar"]}]`)},
		oci.File{Name: "cfg.json", Mode: 0o644, Data: cfg},
		oci.File{Name: "l/layer.tar", Mode: 0o644, Data: tarBytes(t,
			oci.File{Name: "bin/sh", Mode: 0o755, Data: []byte("#!busybox")},
			oci.File{Name: "etc/motd", Mode: 0o644, Data: []byte("welcome")})},
	)
	file := filepath.Join(t.TempDir(), "saved.tar")
	if err := os.WriteFile(file, archive, 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// fakeKernel points SNOWGLOBE_BOOT at a kernel archive that is only its file names.
func fakeKernel(t *testing.T) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write(tarBytes(t, oci.File{Name: "boot/vmlinuz-virt", Mode: 0o644, Data: []byte("kernel")}))
	gz.Close()
	file := filepath.Join(t.TempDir(), "boot.tar.gz")
	os.WriteFile(file, buf.Bytes(), 0o644)
	t.Setenv("SNOWGLOBE_BOOT", file)
}

// The snapshot's output, written into $sys (the site's system directory) by a fake snowglobe-vm.
const snapshotOutput = `echo state > "$sys/state.bin.zst"
echo '{"boot":[],"exercise":{}}' > "$sys/reads.json"
echo '{"bootSeconds":1.5,"stateBytes":6,"snapshotBytes":9}' > "$sys/run-meta.json"
echo '[]' > "$sys/transcript.json"`

// fakeBuildDocker puts a docker on the PATH that has the tools image, pulls, tags and builds
// anything, saves the image in saved, copies a runtime out of the tools image and snapshots as
// snowglobe-vm would. Its log of calls is returned.
func fakeBuildDocker(t *testing.T, saved string) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := `#!/bin/sh
echo "$*" >> '` + log + `'
case "$1" in
save) cat '` + saved + `' ;;
run)
  out=; prev=; for a; do [ "$prev" = -v ] && case "$a" in *:/out) out=${a%:/out} ;; esac; prev=$a; done
  case "$*" in
  *"cp -R /tools/site/."*)
    mkdir -p "$out/armless" "$out/xterm"
    echo 'pages = Math.ceil((o.memory_mb + 1024) * 16);' > "$out/armless/armless.js"
    echo wasm > "$out/armless/armless.wasm"; echo smp > "$out/armless/armless-smp.wasm" ;;
  *" snapshot /out/system"*)
    sys="$out/system"
` + snapshotOutput + ` ;;
  esac ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

// buildEnv keeps a build away from this machine's cache, Docker, proxies and runtime.
func buildEnv(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SNOWGLOBE_TOOLS_BUILD", "")
	t.Setenv("SNOWGLOBE_VM", "")
	t.Setenv("SNOWGLOBE_BOOT_STALL_SECS", "")
	t.Setenv("ARMLESS_JIT", "")
	for _, v := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
		"NO_PROXY", "no_proxy", "SSL_CERT_FILE"} {
		t.Setenv(v, "")
	}
	fakeKernel(t)
}

func TestRunBuildsASiteWithDocker(t *testing.T) {
	buildEnv(t)
	log := fakeBuildDocker(t, savedImage(t, "arm64", map[string]string{"snowglobe.title": "Shell", "snowglobe.ready": "$ "}))
	out := filepath.Join(t.TempDir(), "dist")
	if err := Run(Options{Source: "alpine", Out: out, Memory: 128, Exercise: []string{"ls"}}, "dev"); err != nil {
		t.Fatal(err)
	}

	calls, _ := os.ReadFile(log)
	for _, want := range []string{
		"pull --platform linux/arm64 alpine", "tag alpine " + sourceTag, "save " + sourceTag,
		"cp -R /tools/site/. /out/",
		tools.VM + " snapshot /out/system --memory 128 --network none --cpus 1 --build-cpus 4",
		"--ready $  --exercise ls",
	} {
		if !strings.Contains(string(calls), want) {
			t.Errorf("%q isn't in the docker calls:\n%s", want, calls)
		}
	}

	var info RunInfo
	data, err := os.ReadFile(filepath.Join(out, "run.json"))
	if err != nil || json.Unmarshal(data, &info) != nil {
		t.Fatalf("run.json: %s %v", data, err)
	}
	if info.Title != "Shell" || info.Source != "alpine" || info.Command != "'/bin/sh'" || info.Ready != "$ " ||
		info.MemoryMB != 128 || info.Network != "none" || info.Arch != "arm64" || info.CPUs != 1 || info.BuildCPUs != 4 ||
		info.BootSeconds != 1.5 || info.StateBytes != 6 || info.SnapshotBytes != 9 || !info.HasTranscript ||
		info.Files == 0 || info.Snowglobe != "dev" {
		t.Errorf("run.json: %+v", info)
	}
	for _, f := range []string{"index.html", "warm-report.json", "transcript.json", "system/filesystem.json", "system/warm.pack", marker} {
		if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(f))); err != nil {
			t.Errorf("no %s", f)
		}
	}
	// Spent on the way: the snapshot's own reads and metadata; the machine build it doesn't load
	for _, f := range []string{"system/reads.json", "system/run-meta.json", "system/transcript.json", "armless/armless-smp.wasm", "system/tls.json"} {
		if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(f))); err == nil {
			t.Errorf("%s was kept", f)
		}
	}
	if js, _ := os.ReadFile(filepath.Join(out, "armless", "armless.js")); !strings.Contains(string(js), "o.memory_mb + 1024") {
		t.Errorf("armless.js changed on the way: %s", js)
	}
}

func TestRunBuildsADockerfileWithANetwork(t *testing.T) {
	buildEnv(t)
	log := fakeBuildDocker(t, savedImage(t, "arm64", nil))
	src := t.TempDir()
	os.WriteFile(filepath.Join(src, "Dockerfile"), []byte("FROM alpine\n"), 0o644)
	out := filepath.Join(t.TempDir(), "dist")
	o := Options{Source: src, Out: out, Network: "fetch", CPUs: 2, Tunnels: []string{"db:5432=wss://gw/db"}}
	if err := Run(o, "dev"); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	if !strings.Contains(string(calls), "build --platform linux/arm64 --tag "+sourceTag+" "+src) ||
		!strings.Contains(string(calls), "--network fetch --cpus 2 --build-cpus 4") || !strings.Contains(string(calls), "--tunnel db:5432=wss://gw/db") {
		t.Errorf("docker calls:\n%s", calls)
	}
	// The page's CA, the multi-CPU machine and the worker that isolates the page
	for _, f := range []string{"system/tls.json", "armless/armless-smp.wasm", "sw.js"} {
		if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(f))); err != nil {
			t.Errorf("no %s", f)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "armless", "armless.wasm")); err == nil {
		t.Error("the one-CPU machine was kept")
	}
}

func TestRunRefuses(t *testing.T) {
	buildEnv(t)
	amd64 := savedImage(t, "amd64", nil)
	dockerfile := t.TempDir()
	os.WriteFile(filepath.Join(dockerfile, "Dockerfile"), []byte("FROM alpine\n"), 0o644)
	theirs := t.TempDir()
	os.WriteFile(filepath.Join(theirs, "notes.txt"), nil, 0o644)
	arm64 := savedImage(t, "arm64", nil)
	for _, tc := range []struct {
		name  string
		saved string
		o     Options
		want  string
	}{
		{"an --out it didn't make", arm64, Options{Source: "alpine", Out: theirs}, "wasn't created by snowglobe"},
		{"an unknown builder", arm64, Options{Source: "alpine", Builder: "podman"}, "--builder podman"},
		{"a Dockerfile, natively", arm64, Options{Source: dockerfile, Builder: "native"}, "is a Dockerfile"},
		{"an image for another machine", amd64, Options{Source: "alpine"}, "is amd64, not arm64"},
		{"settings that don't resolve", arm64, Options{Source: "alpine", Network: "carrier-pigeon"}, "network"},
	} {
		fakeBuildDocker(t, tc.saved)
		if tc.o.Out == "" {
			tc.o.Out = filepath.Join(t.TempDir(), "dist")
		}
		if err := Run(tc.o, "dev"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
}

// Natively: the image from an archive and snowglobe-vm here, as far as fetching the page's
// runtime (which needs the network: here its cached copy has been tampered with, and is refused).
func TestRunNativelyFromAnArchive(t *testing.T) {
	buildEnv(t)
	t.Setenv("PATH", t.TempDir()) // no Docker
	vm := filepath.Join(t.TempDir(), "snowglobe-vm")
	os.WriteFile(vm, []byte("#!/bin/sh\nexit 0\n"), 0o755)
	t.Setenv("SNOWGLOBE_VM", vm)

	// The first file FetchSite would download, already in the cache, but not what was pinned
	df, err := os.ReadFile(filepath.Join("..", "tools", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`ADD --checksum=sha256:([0-9a-f]+)\s*\\?\s*(\S+)`).FindStringSubmatch(string(df))
	cache, _ := os.UserCacheDir()
	local := filepath.Join(cache, "snowglobe", "site", m[1][:16]+"-"+m[2][strings.LastIndex(m[2], "/")+1:])
	os.MkdirAll(filepath.Dir(local), 0o755)
	os.WriteFile(local, []byte("tampered"), 0o644)

	out := filepath.Join(t.TempDir(), "dist")
	err = Run(Options{Source: savedImage(t, "arm64", nil), Out: out}, "dev")
	if err == nil || !strings.Contains(err.Error(), "Assemble page") || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("got %v", err)
	}
	// It got that far: the filesystem is converted
	if _, err := os.Stat(filepath.Join(out, "system", "filesystem.json")); err != nil {
		t.Error("no filesystem")
	}
}

func TestTruncateNeverCutsACharacter(t *testing.T) {
	for _, tc := range []struct {
		s    string
		n    int
		want string
	}{
		{"ls", 18, "ls"},
		{"exactly-eighteen!!", 18, "exactly-eighteen!!"},
		{"Enum.map(1..10, fn x -> x end)", 18, "Enum.map(1..10, f…"},
		{"échoéchoéchoéchoécho", 18, "échoéchoéchoéchoé…"},
		{"日本語のコマンドを入力してください", 5, "日本語の…"},
	} {
		got := truncate(tc.s, tc.n)
		if got != tc.want || !utf8.ValidString(got) {
			t.Errorf("truncate(%q, %d) = %q, want %q", tc.s, tc.n, got, tc.want)
		}
	}
}
