package rootfs

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// PackEntry is one blob in a warm pack's index.
type PackEntry struct {
	Blob       string
	Size       int64 // uncompressed
	Compressed int64
}

// ReadWarmPack loads a warm pack: its index and each blob's (compressed) bytes, in pack order.
func ReadWarmPack(file string) ([]PackEntry, [][]byte, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, nil, err
	}
	return ParseWarmPack(data)
}

// ParseWarmPack reads a warm pack's bytes: <<index_size::32-little, index_json, blobs...>>. It may
// come from a remote site, so a malformed one is an error, never a panic.
func ParseWarmPack(data []byte) ([]PackEntry, [][]byte, error) {
	if len(data) < 4 {
		return nil, nil, errors.New("short warm pack")
	}
	n := int(binary.LittleEndian.Uint32(data))
	if 4+n > len(data) {
		return nil, nil, errors.New("bad warm pack index")
	}
	var index [][]any
	if err := json.Unmarshal(data[4:4+n], &index); err != nil {
		return nil, nil, err
	}
	entries := make([]PackEntry, 0, len(index))
	blobs := make([][]byte, 0, len(index))
	offset := 4 + n
	for _, e := range index {
		if len(e) < 3 {
			return nil, nil, errors.New("bad warm pack entry")
		}
		name, _ := e[0].(string)
		size, _ := e[1].(float64)
		length, _ := e[2].(float64)
		if name == "" || length < 0 || length > float64(len(data)-offset) {
			return nil, nil, errors.New("bad warm pack entry")
		}
		end := offset + int(length)
		entries = append(entries, PackEntry{Blob: name, Size: int64(size), Compressed: int64(length)})
		blobs = append(blobs, data[offset:end])
		offset = end
	}
	return entries, blobs, nil
}

// BlobSizes maps each blob in a filesystem.json to its uncompressed size (a file's, or a
// chunk's).
func BlobSizes(file string) (map[string]int64, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	refs, err := ListBlobs(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	sizes := make(map[string]int64, len(refs))
	for _, r := range refs {
		sizes[r.Name] = r.Size
	}
	return sizes, nil
}

// ExtendWarmPack adds blobs to <system>/warm.pack, after the ones it has: what a run recorded
// with `snowglobe-vm run --record-reads`, say. Blobs come from blobDir; names the site's
// filesystem doesn't have are ignored. The pack is rewritten whole, then moved into place.
func ExtendWarmPack(system, blobDir string, names []string) (added, files int, bytes int64, err error) {
	sizes, err := BlobSizes(filepath.Join(system, "filesystem.json"))
	if err != nil {
		return 0, 0, 0, err
	}
	packFile := filepath.Join(system, "warm.pack")
	entries, blobs, err := ReadWarmPack(packFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, 0, 0, err
	}
	have := map[string]bool{}
	for _, e := range entries {
		have[e.Blob] = true
	}
	for _, name := range names {
		size, ok := sizes[name]
		if !ok || have[name] {
			continue
		}
		data, err := os.ReadFile(filepath.Join(blobDir, name))
		if err != nil {
			return 0, 0, 0, err
		}
		have[name] = true
		entries = append(entries, PackEntry{Blob: name, Size: size, Compressed: int64(len(data))})
		blobs = append(blobs, data)
		added++
	}
	if added == 0 {
		for _, e := range entries {
			bytes += e.Compressed
		}
		return 0, len(entries), bytes, nil
	}

	index := make([][]any, len(entries))
	for i, e := range entries {
		index[i] = []any{e.Blob, e.Size, e.Compressed}
		bytes += e.Compressed
	}
	indexJSON, err := json.Marshal(index)
	if err != nil {
		return 0, 0, 0, err
	}
	// A temporary file of its own: another warm of this site may be writing at the same time
	out, err := os.CreateTemp(system, "warm.pack.tmp-*")
	if err != nil {
		return 0, 0, 0, err
	}
	tmp := out.Name()
	if err := out.Chmod(0o644); err != nil {
		out.Close()
		os.Remove(tmp)
		return 0, 0, 0, err
	}
	w := bufio.NewWriter(out)
	binary.Write(w, binary.LittleEndian, uint32(len(indexJSON)))
	w.Write(indexJSON)
	for _, b := range blobs {
		w.Write(b)
	}
	if err := w.Flush(); err != nil {
		out.Close()
		os.Remove(tmp)
		return 0, 0, 0, err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return 0, 0, 0, err
	}
	if err := os.Rename(tmp, packFile); err != nil {
		os.Remove(tmp)
		return 0, 0, 0, err
	}
	return added, len(entries), bytes, nil
}
