package boot

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// findfs is the shell function kernel.Dockerfile adds to Alpine's initramfs init.
func findfs(t *testing.T) string {
	t.Helper()
	_, rest, ok := strings.Cut(string(kernelDockerfile), "COPY <<'EOF' /tmp/findfs.sh\n")
	body, _, ok2 := strings.Cut(rest, "\nEOF\n")
	if !ok || !ok2 {
		t.Fatal("kernel.Dockerfile has no findfs.sh heredoc")
	}
	return body
}

// The init calls `$MOCK snowglobe_findfs ...` where it called nlplug-findfs: run the function with
// the commands it calls faked, each recording its arguments
func TestFindfsMountsA9pRootWithoutNlplugFindfs(t *testing.T) {
	for _, c := range []struct {
		name, rootfstype string
		shareUp          bool
		want             string // the calls made, and what it printed
	}{
		{"another root: nlplug-findfs as before", "ext4", false, "nlplug-findfs -p /sbin/mdev /dev/vda\n"},
		{"9p: its transport, then the share", "9p", true, "modprobe 9pnet_virtio\ngrep -qsx host9p\n"},
		{"9p, no share: says so (the mount then fails)", "9p", false, "modprobe 9pnet_virtio\nno 9p share host9p after 5 s\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			bin := t.TempDir()
			calls := filepath.Join(bin, "calls")
			fake := func(name, body string) {
				script := "#!/bin/sh\n" + body + "\n"
				if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			record := `echo "$(basename "$0") $*" >> ` + calls
			fake("nlplug-findfs", record)
			fake("modprobe", record)
			fake("sleep", "")
			grep := `echo "grep $1 $2" >> ` + calls + `; exit 1`
			if c.shareUp {
				grep = `echo "grep $1 $2" >> ` + calls + `; exit 0`
			}
			fake("grep", grep)
			root := "host9p"
			if c.rootfstype != "9p" {
				root = "/dev/vda"
			}
			cmd := exec.Command("sh", "-c", findfs(t)+"\nsnowglobe_findfs -p /sbin/mdev \"$KOPT_root\"")
			cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin", "KOPT_rootfstype=" + c.rootfstype, "KOPT_root=" + root}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			recorded, _ := os.ReadFile(calls)
			got := string(recorded) + strings.TrimPrefix(string(out), "snowglobe: ")
			if !c.shareUp && c.rootfstype == "9p" {
				// Every check of the share is a call: keep the first, then what it said
				lines := strings.Split(got, "\n")
				got = lines[0] + "\n" + lines[len(lines)-2] + "\n"
			}
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestKernelIsSnowglobeBootWhenSet(t *testing.T) {
	t.Setenv("SNOWGLOBE_BOOT", "/somewhere/boot.tar.gz")
	if p, err := Kernel("v1.2.3"); err != nil || p != "/somewhere/boot.tar.gz" {
		t.Fatalf("got %q, %v", p, err)
	}
}
