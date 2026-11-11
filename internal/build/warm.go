package build

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/filipecabaco/snowglobe/internal/rootfs"
)

// WarmStats is what Warm added.
type WarmStats struct {
	Recorded, Added, Files int
	Bytes                  int64
}

// Warm adds the files runs recorded (`snowglobe run --record-reads`) to a built site's warm
// pack, so traffic from outside the guest (an API's test suite through a forwarded port, say)
// warms it the way --exercise commands do at build time.
func Warm(site string, readsFiles []string) (WarmStats, error) {
	system := filepath.Join(site, "system")
	// A pooled site keeps its blobs in the directory next to it
	blobs := filepath.Join(system, "filesystem")
	if _, err := os.Stat(blobs); err != nil {
		blobs = filepath.Join(filepath.Dir(site), "blobs")
	}

	// Each file once, in the order the runs first read it: the pack streams them so
	recorded := map[string]bool{}
	var names []string
	for _, f := range readsFiles {
		r, err := rootfs.ReadReads(f)
		if err != nil {
			return WarmStats{}, err
		}
		for _, name := range r.All() {
			if !recorded[name] {
				recorded[name] = true
				names = append(names, name)
			}
		}
	}

	added, files, bytes, err := rootfs.ExtendWarmPack(system, blobs, names)
	if err != nil {
		return WarmStats{}, err
	}
	stats := WarmStats{Recorded: len(names), Added: added, Files: files, Bytes: bytes}
	if added == 0 {
		return stats, nil
	}

	// run.json counts the warm pack
	runFile := filepath.Join(site, "run.json")
	data, err := os.ReadFile(runFile)
	if err != nil {
		return stats, fmt.Errorf("%s isn't a built snowglobe site (no run.json)", site)
	}
	var info RunInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return stats, fmt.Errorf("run.json: %w", err)
	}
	info.WarmPackFiles, info.WarmPackBytes = files, bytes
	if data, err = json.MarshalIndent(info, "", "  "); err != nil {
		return stats, err
	}
	return stats, os.WriteFile(runFile, data, 0o644)
}
