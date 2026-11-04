package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Instances of one site share its snapshot's RAM: the first makes the image in the cache
// (read-only, in a directory only this user reaches), the next maps the same one. What a machine
// writes to RAM is its own, and each gets randomness of its own (the kernel reseeds on a restore),
// though they start from the same memory.
func (e *e2e) sharedRAM(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("SNOWGLOBE_CACHE", cache)
	names := []string{fmt.Sprintf("ram-a-%d", os.Getpid()), fmt.Sprintf("ram-b-%d", os.Getpid())}
	for _, n := range names {
		e.must(t, 0, "run", e.site, "--runtime", "native", "--name", n, "--detach")
		defer e.run(t, nil, "stop", n)
	}

	dir := filepath.Join(cache, "ram")
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("no image was made: %v", err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Errorf("%s: %v", dir, info.Mode())
	}
	files, _ := os.ReadDir(dir)
	var kinds []string
	for _, f := range files {
		fi, _ := f.Info()
		kinds = append(kinds, filepath.Ext(f.Name()))
		if fi.Mode().Perm() != 0o444 {
			t.Errorf("%s: %v", f.Name(), fi.Mode())
		}
	}
	if strings.Join(kinds, " ") != ".ram .state" {
		t.Errorf("one image and its state: %v", kinds)
	}

	// RAM written in one (a tmpfs file) is not in the other
	e.must(t, 0, "sh", names[0], "echo mine > /dev/shm/a")
	if out := e.must(t, 0, "sh", names[1], "cat /dev/shm/a 2>&1 || echo absent"); !strings.Contains(out, "absent") {
		t.Errorf("b sees a's memory: %q", out)
	}
	if out := e.must(t, 0, "sh", names[0], "cat /dev/shm/a"); out != "mine\n" {
		t.Errorf("a's own: %q", out)
	}

	// Their own randomness, and the guest saw the restore as a fork
	read := "head -c 16 /dev/urandom | od -An -tx1"
	a, b := e.must(t, 0, "sh", names[0], read), e.must(t, 0, "sh", names[1], read)
	if a == b {
		t.Errorf("the same random bytes in both: %q", a)
	}
	for _, n := range names {
		if out := e.must(t, 0, "sh", n, "dmesg | grep -c 'reseeded due to virtual machine fork' || true"); strings.TrimSpace(out) == "0" {
			t.Errorf("%s: the kernel didn't reseed", n)
		}
	}
}
