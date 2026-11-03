package daemon

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// processMemory is what a process costs the host: its proportional set size (its own pages, and
// its share of those it shares, as forks share their template's), from /proc. 0 if it is gone.
func processMemory(pid int) int64 {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/smaps_rollup", pid))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "Pss:" {
			kb, _ := strconv.ParseInt(f[1], 10, 64)
			return kb << 10
		}
	}
	return 0
}
