package daemon

import (
	"os/exec"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// start runs a process group of its own that ignores SIGTERM, so that only a SIGKILL ends it.
func stubborn(t *testing.T) (*exec.Cmd, chan struct{}) {
	t.Helper()
	cmd := exec.Command("sh", "-c", "trap '' TERM; while :; do sleep 1; done")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan struct{})
	go func() { cmd.Wait(); close(reaped) }()
	t.Cleanup(func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); <-reaped })
	// Its trap is set once it has a child
	time.Sleep(200 * time.Millisecond)
	return cmd, reaped
}

func withGrace(t *testing.T, d time.Duration) {
	old := stopGrace
	stopGrace = d
	t.Cleanup(func() { stopGrace = old })
}

// A group is SIGKILLed after the grace while it is ours; one that isn't (already reaped, its id
// perhaps another process's now) and a pid that is gone are never signalled.
func TestStopGroupsKillsOnlyWhatIsStillOurs(t *testing.T) {
	withGrace(t, 300*time.Millisecond)
	mine, mineReaped := stubborn(t)
	notMine, notMineReaped := stubborn(t)

	var signalled atomic.Int32
	ours := func(pid int) bool {
		ok := pid == mine.Process.Pid
		if ok {
			signalled.Add(1)
		}
		return ok
	}
	stopGroups([]int{mine.Process.Pid, notMine.Process.Pid}, []int{0, 1 << 22}, ours)

	select {
	case <-mineReaped:
	case <-time.After(3 * time.Second):
		t.Fatal("a group that is ours survived the SIGKILL")
	}
	select {
	case <-notMineReaped:
		t.Fatal("a group that wasn't ours was signalled")
	case <-time.After(300 * time.Millisecond):
	}
	if syscall.Kill(notMine.Process.Pid, 0) != nil {
		t.Fatal("the process that wasn't ours is gone")
	}
	if signalled.Load() == 0 {
		t.Fatal("ours was never asked")
	}
}

// Once a group's leader has been waited for it is not ours any more: it is not signalled again
func TestStopGroupsSkipsWhatWasReapedDuringTheGrace(t *testing.T) {
	withGrace(t, 2*time.Second)
	victim, reaped := stubborn(t)
	pid := victim.Process.Pid
	var gone atomic.Bool
	go func() {
		// The group goes (its leader reaped) while the grace runs
		time.Sleep(100 * time.Millisecond)
		syscall.Kill(-pid, syscall.SIGKILL)
		<-reaped
		gone.Store(true)
	}()
	start := time.Now()
	stopGroups([]int{pid}, nil, func(int) bool {
		if gone.Load() {
			return false
		}
		return true
	})
	if time.Since(start) > time.Second {
		t.Fatal("it waited out the grace for a group that was gone")
	}
}

// The real predicate: a server in s.groups is ours; one that is not listed is not
func TestUnreaped(t *testing.T) {
	s := &Server{groups: map[int]bool{4242: true}, builds: newBuilds(t.TempDir())}
	if !s.unreaped(4242) {
		t.Fatal("a listed group is not ours")
	}
	if s.unreaped(4243) {
		t.Fatal("an unlisted pid is ours")
	}
}
