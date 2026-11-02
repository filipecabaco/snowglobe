package instance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// An instance's directory is <cache>/snowglobe/instances/<name>, removed when it stops: a name
// that is a path step would make that the cache itself (..) or every instance's (.).
func TestAnInstanceNameIsNeverAPathStep(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SNOWGLOBE_FAKE_VM", "fail")
	cache, _ := os.UserCacheDir()
	keep := filepath.Join(cache, "snowglobe", "sites", "a-cached-site", "run.json")
	os.MkdirAll(filepath.Dir(keep), 0o755)
	os.WriteFile(keep, []byte("{}"), 0o644)
	other := filepath.Join(cache, "snowglobe", "instances", "other", "state.json")
	os.MkdirAll(filepath.Dir(other), 0o755)
	os.WriteFile(other, []byte("{}"), 0o644)

	for _, name := range []string{"..", "."} {
		for _, detach := range []bool{false, true} {
			err := runNative(Options{Name: name, Detach: detach, LogDir: t.TempDir()}, fakeSite(t), self, "none", nil)
			if err == nil || !strings.Contains(err.Error(), "--name") {
				t.Errorf("%q (detached %v): got %v", name, detach, err)
			}
		}
	}
	for _, f := range []string{keep, other} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s was removed", f)
		}
	}
}

// A time limit below zero is refused before the job starts: the wait for its answer would end at
// once and leave the job running in the guest with no one to read what it did.
func TestAJobsTimeLimitIsntNegative(t *testing.T) {
	fakeJobInstance(t, "web", func(jobRequest) any {
		time.Sleep(50 * time.Millisecond)
		return JobResult{Status: status(0)}
	})
	if _, err := Job("web", JobRequest{Cmd: "sleep 1", Timeout: -60}); err == nil || !strings.Contains(err.Error(), "0 or more seconds") {
		t.Fatalf("got %v", err)
	}
}
