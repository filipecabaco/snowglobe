// Package bundle writes a built site into a single executable: snowglobe-vm with the site
// appended, which runs the site when started. No Docker, no hypervisor and nothing extracted:
// the executable maps itself, restores the snapshot from memory and sandboxes itself (Landlock
// and seccomp on Linux, Seatbelt on macOS). snowglobe-vm's site.rs reads the format:
//
//	[snowglobe-vm][file]...[index JSON][runtime length][index offset][index length]"SGBUNDL1"
//
// with the three lengths as little-endian uint64s and the index a JSON object of
// name -> [offset, length]. Names are "run.json", "system/<file>" and "blob/<blob name>".
package bundle

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// Magic ends every bundle.
const Magic = "SGBUNDL1"

const trailer = 3*8 + len(Magic)

// systemFiles are what a run reads from the site's system directory, besides blobs.
var systemFiles = []string{"state.bin.zst", "filesystem.json", "console.bin", "jit-profile.bin", "tls.json"}

// Stats describe a bundle written.
type Stats struct {
	Runtime int64 // bytes of snowglobe-vm
	Site    int64 // bytes of the site's files
	Blobs   int   // guest files (or chunks) carried
}

// Write bundles the built site at site (a directory with run.json and system/) with the
// snowglobe-vm at runtime into out. A runtime that is itself a bundle gives only its executable.
func Write(site, runtime, out string) (Stats, error) {
	var s Stats
	exe, err := os.ReadFile(runtime)
	if err != nil {
		return s, err
	}
	if n, _, ok := index(exe); ok {
		exe = exe[:n]
	}
	if _, err := os.Stat(filepath.Join(site, "run.json")); err != nil {
		return s, fmt.Errorf("%s isn't a built snowglobe site (no run.json)", site)
	}
	// A pooled site keeps its blobs in the directory next to it
	blobs := filepath.Join(site, "system", "filesystem")
	if _, err := os.Stat(blobs); err != nil {
		blobs = filepath.Join(filepath.Dir(site), "blobs")
		if _, err := os.Stat(blobs); err != nil {
			return s, fmt.Errorf("%s has neither system/filesystem nor a pooled ../blobs", site)
		}
	}

	type file struct{ name, path string }
	files := []file{{"run.json", filepath.Join(site, "run.json")}}
	for _, f := range systemFiles {
		p := filepath.Join(site, "system", f)
		if _, err := os.Stat(p); err == nil {
			files = append(files, file{"system/" + f, p})
		}
	}
	// The blobs this site's filesystem names: every string in filesystem.json that is a file in
	// the blob directory (a pooled store holds its neighbours' blobs too)
	fsJSON, err := os.ReadFile(filepath.Join(site, "system", "filesystem.json"))
	if err != nil {
		return s, err
	}
	var tree any
	if err := json.Unmarshal(fsJSON, &tree); err != nil {
		return s, fmt.Errorf("filesystem.json: %w", err)
	}
	names := map[string]bool{}
	stringsIn(tree, names)
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		if n == "" || filepath.Base(n) != n {
			continue
		}
		p := filepath.Join(blobs, n)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			files = append(files, file{"blob/" + n, p})
			s.Blobs++
		}
	}

	tmp := out + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return s, err
	}
	defer os.Remove(tmp)
	w := bufio.NewWriterSize(f, 1<<20)
	if _, err := w.Write(exe); err != nil {
		f.Close()
		return s, err
	}
	at := int64(len(exe))
	idx := map[string][2]int64{}
	for _, fl := range files {
		in, err := os.Open(fl.path)
		if err != nil {
			f.Close()
			return s, err
		}
		n, err := io.Copy(w, in)
		in.Close()
		if err != nil {
			f.Close()
			return s, err
		}
		idx[fl.name] = [2]int64{at, n}
		at += n
	}
	js, err := json.Marshal(idx)
	if err != nil {
		f.Close()
		return s, err
	}
	w.Write(js)
	for _, n := range []int64{int64(len(exe)), at, int64(len(js))} {
		binary.Write(w, binary.LittleEndian, uint64(n))
	}
	w.WriteString(Magic)
	if err := w.Flush(); err != nil {
		f.Close()
		return s, err
	}
	if err := f.Close(); err != nil {
		return s, err
	}
	if err := os.Rename(tmp, out); err != nil {
		return s, err
	}
	s.Runtime = int64(len(exe))
	s.Site = at - s.Runtime
	return s, nil
}

// Read returns a bundle's files, by name, as offsets into it: what snowglobe-vm does at start.
func Read(data []byte) (map[string][2]int64, error) {
	_, files, ok := index(data)
	if !ok {
		return nil, errors.New("not a snowglobe bundle")
	}
	return files, nil
}

func index(data []byte) (int, map[string][2]int64, bool) {
	if len(data) < trailer || string(data[len(data)-len(Magic):]) != Magic {
		return 0, nil, false
	}
	t := data[len(data)-trailer:]
	exe := binary.LittleEndian.Uint64(t[0:])
	at := binary.LittleEndian.Uint64(t[8:])
	n := binary.LittleEndian.Uint64(t[16:])
	if at+n > uint64(len(data)-trailer) || exe > at {
		return 0, nil, false
	}
	var files map[string][2]int64
	if json.Unmarshal(data[at:at+n], &files) != nil {
		return 0, nil, false
	}
	return int(exe), files, true
}

func stringsIn(v any, out map[string]bool) {
	switch t := v.(type) {
	case string:
		out[t] = true
	case []any:
		for _, e := range t {
			stringsIn(e, out)
		}
	case map[string]any:
		for _, e := range t {
			stringsIn(e, out)
		}
	}
}
