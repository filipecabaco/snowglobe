package rootfs

import (
	"path"
	"regexp"
	"sort"
	"strings"
)

// Report explains a warm pack: which files each phase read, grouped by directory, so the warm
// cache of each runtime can be understood and tuned. The pack holds what a restored machine read
// (Restore, then Exercise in Order), in the order it was first read, then Pattern; Boot is what
// only booting read, in the pack only when BootInPack.
type Report struct {
	// Read by the restored machine on its own, before any command: first in the pack
	Restore Phase `json:"restore"`
	// First read by each exercise command, after the snapshot
	Exercise map[string]Phase `json:"exercise"`
	// Exercise commands in the order they ran
	Order []string `json:"order"`
	// Read while booting and never after the restore
	Boot Phase `json:"boot"`
	// Whether Boot's files are in the pack (no exercises, or a --sandbox snapshot): left out,
	// they are fetched on demand if a visitor's machine ever reads them
	BootInPack bool `json:"boot_in_pack"`
	// Files only the --warm pattern added (nobody read them during the build)
	Pattern Phase `json:"pattern"`
	// Files never read and not in the pack: fetched on demand if a visitor ever needs them
	Cold Phase `json:"cold"`
}

// Phase totals one phase's files, in compressed (download) bytes.
type Phase struct {
	Files  int     `json:"files"`
	Bytes  int64   `json:"bytes"`
	Groups []Group `json:"groups"`
}

// Group is one directory's share of a phase.
type Group struct {
	Dir   string `json:"dir"`
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
}

// BuildReport attributes every unique file to the first phase that read it: what the restored
// machine read settling, then each exercise command in order, then booting, then the pattern,
// else cold. Kernel and initramfs (/boot) are left out: armless reads them itself at boot and
// never again after a restore. bootInPack: whether the pack holds boot's reads (Reads.Pack).
func BuildReport(res *Result, reads *Reads, order []string, match *regexp.Regexp, bootInPack bool, blobSize func(string) int64) Report {
	byBlob := map[string]File{}
	for _, f := range res.Files {
		if _, seen := byBlob[f.Blob]; !seen && !strings.HasPrefix(f.Path, "/boot/") {
			byBlob[f.Blob] = f
		}
	}

	claimed := map[string]bool{}
	phase := func(names []string, keep func(File) bool) Phase {
		groups := map[string]*Group{}
		var p Phase
		for _, name := range names {
			f, ok := byBlob[name]
			if !ok || claimed[name] || (keep != nil && !keep(f)) {
				continue
			}
			claimed[name] = true
			size := blobSize(name)
			p.Files++
			p.Bytes += size
			dir := path.Dir(f.Path)
			if groups[dir] == nil {
				groups[dir] = &Group{Dir: dir}
			}
			groups[dir].Files++
			groups[dir].Bytes += size
		}
		for _, g := range groups {
			p.Groups = append(p.Groups, *g)
		}
		sort.Slice(p.Groups, func(i, j int) bool { return p.Groups[i].Bytes > p.Groups[j].Bytes })
		return p
	}

	all := make([]string, 0, len(byBlob))
	for name := range byBlob {
		all = append(all, name)
	}
	sort.Strings(all)

	r := Report{Exercise: map[string]Phase{}, Order: order, BootInPack: bootInPack}
	r.Restore = phase(reads.Restore, nil)
	for _, e := range reads.exercises() {
		r.Exercise[e.Command] = merge(r.Exercise[e.Command], phase(e.Reads, nil))
	}
	// Commands that ran but read nothing new are listed with nothing
	for _, command := range order {
		if _, ok := r.Exercise[command]; !ok {
			r.Exercise[command] = Phase{}
		}
	}
	r.Boot = phase(reads.Boot, nil)
	if match != nil {
		r.Pattern = phase(all, func(f File) bool { return match.MatchString(f.Path) })
	}
	r.Cold = phase(all, nil)
	return r
}

// merge adds b to a (a command typed twice: both times count as its).
func merge(a, b Phase) Phase {
	if a.Files == 0 {
		return b
	}
	groups := map[string]*Group{}
	var dirs []string
	for _, g := range append(append([]Group{}, a.Groups...), b.Groups...) {
		if groups[g.Dir] == nil {
			groups[g.Dir] = &Group{Dir: g.Dir}
			dirs = append(dirs, g.Dir)
		}
		groups[g.Dir].Files += g.Files
		groups[g.Dir].Bytes += g.Bytes
	}
	out := Phase{Files: a.Files + b.Files, Bytes: a.Bytes + b.Bytes}
	for _, d := range dirs {
		out.Groups = append(out.Groups, *groups[d])
	}
	sort.Slice(out.Groups, func(i, j int) bool { return out.Groups[i].Bytes > out.Groups[j].Bytes })
	return out
}
