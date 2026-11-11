package rootfs

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// WarmSelection decides which files go in the warm pack, and in what order.
type WarmSelection struct {
	// Blob names to include, in the order the pack streams them: the order the guest first read
	// them (Reads.Pack)
	Order []string
	// Extra files to include by guest path, after Order's, in the filesystem's order
	Match *regexp.Regexp
}

// Reads is what the snapshot (snowglobe-vm snapshot) recorded: the blobs the guest read while
// booting, while it settled after the snapshot was saved (Restore), and while running each
// exercise command after that, each list in the order the guest first read its blobs. A run's
// --record-reads has its reads in Exercise["run"].
type Reads struct {
	Boot    []string `json:"boot"`
	Restore []string `json:"restore,omitempty"`
	// Exercises in the order they ran, a command typed twice twice
	Exercises []ExerciseReads `json:"exercises,omitempty"`
	// What each command read (a command typed twice: what either time read)
	Exercise map[string][]string `json:"exercise"`
}

// ExerciseReads is what one exercise command read.
type ExerciseReads struct {
	Command string   `json:"command"`
	Reads   []string `json:"reads"`
}

// ReadReads loads reads.json written by the snapshot, or by a run's --record-reads.
func ReadReads(file string) (*Reads, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var r Reads
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return &r, nil
}

// exercises are the exercise phases in the order they ran: Exercises, or for a reads.json
// without it (an older snapshot's, or a run's), Exercise by command name.
func (r *Reads) exercises() []ExerciseReads {
	if len(r.Exercises) > 0 {
		return r.Exercises
	}
	commands := make([]string, 0, len(r.Exercise))
	for c := range r.Exercise {
		commands = append(commands, c)
	}
	sort.Strings(commands)
	out := make([]ExerciseReads, 0, len(commands))
	for _, c := range commands {
		out = append(out, ExerciseReads{Command: c, Reads: r.Exercise[c]})
	}
	return out
}

// AfterRestore is every blob a restored machine read, each once, in the order first read: while
// it settled, then each exercise in turn.
func (r *Reads) AfterRestore() []string {
	lists := [][]string{r.Restore}
	for _, e := range r.exercises() {
		lists = append(lists, e.Reads)
	}
	return firstSeen(lists...)
}

// Pack is what the warm pack holds, in the order it streams it: what a restored machine read,
// in the order it first read it. The build drops the guest's page cache before the snapshot, so
// most of what booting read is never read again after a restore; boot's reads are added after
// the rest only when the restored machine wasn't exercised (withBoot: no exercise commands, or
// a --sandbox snapshot, exercised before it was saved), the best guess there is then.
func (r *Reads) Pack(withBoot bool) []string {
	if withBoot {
		return firstSeen(r.AfterRestore(), r.Boot)
	}
	return r.AfterRestore()
}

// All returns every blob read in any phase, each once, in the order first read (boot first).
func (r *Reads) All() []string {
	return firstSeen(r.Boot, r.AfterRestore())
}

// firstSeen joins lists, each name once, where it first appears.
func firstSeen(lists ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, name := range l {
			if !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}
	return out
}

// WriteWarmPack bundles the selected blobs into <outDir>/warm.pack so the page can fetch them in
// one request instead of one blocking round trip per file the first time the guest opens it. The
// pack holds them in sel.Order's order, then the pattern's: the page reads it as it arrives, so
// what the guest reads first comes first.
//
// Layout: <<index_size::32-little, index_json, blobs...>>, where the index is a JSON list of
// [blob_name, uncompressed_size, compressed_size] in blob order.
func WriteWarmPack(res *Result, sel WarmSelection, outDir string) (files int, bytes int64, err error) {
	type item struct {
		blob string
		size int64
	}
	var picked []item
	seen := map[string]bool{}
	// The kernel and initramfs are read by armless itself at boot, never again after a restore
	boot := map[string]bool{}
	sizes := map[string]int64{}
	for _, f := range res.Files {
		if strings.HasPrefix(f.Path, "/boot/") {
			boot[f.Blob] = true
		}
		if _, ok := sizes[f.Blob]; !ok {
			sizes[f.Blob] = f.Size
		}
	}

	// What was read, in the order it was first read; names the filesystem doesn't have dropped
	for _, name := range sel.Order {
		size, ok := sizes[name]
		if !ok || seen[name] || boot[name] {
			continue
		}
		seen[name] = true
		picked = append(picked, item{name, size})
	}
	// Then what the pattern adds
	if sel.Match != nil {
		for _, f := range res.Files {
			if seen[f.Blob] || boot[f.Blob] || !sel.Match.MatchString(f.Path) {
				continue
			}
			seen[f.Blob] = true
			picked = append(picked, item{f.Blob, f.Size})
		}
	}

	index := make([][]any, 0, len(picked))
	blobs := make([][]byte, 0, len(picked))
	for _, p := range picked {
		data, err := os.ReadFile(res.Blobs[p.blob])
		if err != nil {
			return 0, 0, err
		}
		index = append(index, []any{p.blob, p.size, len(data)})
		blobs = append(blobs, data)
		bytes += int64(len(data))
	}

	indexJSON, err := json.Marshal(index)
	if err != nil {
		return 0, 0, err
	}

	out, err := os.Create(filepath.Join(outDir, "warm.pack"))
	if err != nil {
		return 0, 0, err
	}
	defer out.Close()

	w := bufio.NewWriter(out)
	if err := binary.Write(w, binary.LittleEndian, uint32(len(indexJSON))); err != nil {
		return 0, 0, err
	}
	w.Write(indexJSON)
	for _, b := range blobs {
		w.Write(b)
	}
	if err := w.Flush(); err != nil {
		return 0, 0, err
	}
	return len(picked), bytes, out.Close()
}
