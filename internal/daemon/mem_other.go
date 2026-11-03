//go:build !linux

package daemon

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// processMemory is what a process costs the host, as far as can be told without cgo: its resident
// set size. That counts in full the pages forks share with their template, so a budget is reached
// sooner than on Linux (which measures each fork's share). 0 if it is gone.
func processMemory(pid int) int64 {
	out, err := exec.Command("ps", "-o", "rss=", "-p", fmt.Sprint(pid)).Output()
	if err != nil {
		return 0
	}
	kb, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	return kb << 10
}
