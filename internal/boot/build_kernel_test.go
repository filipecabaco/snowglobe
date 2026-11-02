package boot

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// kernelEnv is a fresh user cache, no SNOWGLOBE_BOOT, and a docker on the PATH running script
// (no docker at all when script is ""). The docker's log of calls is returned.
func kernelEnv(t *testing.T, script string) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SNOWGLOBE_BOOT", "")
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	log := filepath.Join(bin, "calls")
	if script != "" {
		body := "#!/bin/sh\necho \"$*\" >> '" + log + "'\n" + script + "\n"
		if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return log
}

func TestAReleasesKernelInTheCacheIsUsed(t *testing.T) {
	kernelEnv(t, "")
	cache, _ := os.UserCacheDir()
	cached := filepath.Join(cache, "snowglobe", "boot", "snowglobe-boot_1.2.3_arm64.tar.gz")
	os.MkdirAll(filepath.Dir(cached), 0o755)
	os.WriteFile(cached, []byte("kernel"), 0o644)
	if p, err := Kernel("v1.2.3"); err != nil || p != cached {
		t.Fatalf("got %q, %v", p, err)
	}
}

func TestNoKernelWithoutAReleaseOrDocker(t *testing.T) {
	kernelEnv(t, "")
	if _, err := Kernel("dev"); err == nil || !strings.Contains(err.Error(), "SNOWGLOBE_BOOT") {
		t.Fatalf("got %v", err)
	}
}

func TestAKernelIsBuiltWithDockerOnce(t *testing.T) {
	log := kernelEnv(t, `[ "$1" = run ] && printf 'archive'; exit 0`)
	p, err := Kernel("dev")
	if err != nil {
		t.Fatal(err)
	}
	// Named by its Dockerfile: a change to it builds another
	sum := sha256.Sum256(kernelDockerfile)
	if filepath.Base(p) != "built-"+hex.EncodeToString(sum[:8])+".tar.gz" {
		t.Errorf("named %s", p)
	}
	if got, _ := os.ReadFile(p); string(got) != "archive" {
		t.Errorf("got %q", got)
	}
	calls, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "build --platform linux/arm64 --tag snowglobe-kernel:build ") ||
		lines[1] != "run --rm --platform linux/arm64 snowglobe-kernel:build tar -czf - -C / boot/vmlinuz-virt boot/initramfs-virt lib/modules" {
		t.Errorf("docker calls: %q", lines)
	}
	// Built already: kept
	if again, err := Kernel("dev"); err != nil || again != p {
		t.Fatalf("again: %q, %v", again, err)
	}
	if calls, _ := os.ReadFile(log); strings.Count(string(calls), "\n") != 2 {
		t.Errorf("built twice: %s", calls)
	}
}

func TestAFailedKernelBuildLeavesNothing(t *testing.T) {
	for _, script := range []string{`exit 1`, `[ "$1" = run ] && { printf 'half'; exit 1; }; exit 0`} {
		kernelEnv(t, script)
		dest := filepath.Join(t.TempDir(), "boot", "kernel.tar.gz")
		if err := BuildKernel(dest); err == nil {
			t.Errorf("%s: no error", script)
		}
		if left, _ := os.ReadDir(filepath.Dir(dest)); len(left) != 0 {
			t.Errorf("%s: left %v", script, left)
		}
	}
}

// Two builds at once on a machine with no kernel yet both build it into the one cache path: each
// lands whole.
func TestKernelBuildsAtOnceEachLandWhole(t *testing.T) {
	kernelEnv(t, `[ "$1" = run ] && { i=0; while [ $i -lt 2048 ]; do printf '%0256d' 0; i=$((i+1)); done; }; exit 0`)
	dest := filepath.Join(t.TempDir(), "boot", "kernel.tar.gz")
	errs := make(chan error, 6)
	for range 6 {
		go func() { errs <- BuildKernel(dest) }()
	}
	for range 6 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if got, _ := os.ReadFile(dest); len(got) != 2048*256 || strings.Trim(string(got), "0") != "" {
		t.Fatalf("%d bytes, not the kernel", len(got))
	}
}
