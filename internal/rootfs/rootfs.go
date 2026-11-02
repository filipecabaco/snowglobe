// Package rootfs converts a root filesystem tarball into v86's 9p filesystem format:
//
//	<out>/filesystem.json                      tree metadata (v86 fs2json format, version 3)
//	<out>/filesystem/<sha256[0:10]>.bin.zst   zstd-compressed file contents, deduplicated
//
// Files of ChunkThreshold bytes and more are stored in content-defined chunks: their target is a
// list of [blob, length] pairs instead of one blob name (armless 0.3.0 and later read it).
//
// It is equivalent to v86's tools/fs2json.py and tools/copy-to-sha256.py --zstd, in one pass
// over the tar stream, with contents hashed and compressed in parallel.
package rootfs

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/klauspost/compress/zstd"
)

const (
	formatVersion = 3
	// keep in sync with HASH_LENGTH in v86's fs2json.py
	hashLength = 10

	sIFREG = 0o100000
	sIFDIR = 0o040000
	sIFLNK = 0o120000
)

// File is a blob of a regular file in the converted filesystem: the whole file, or one of its
// chunks (a chunked file has one File per chunk, all with its path).
type File struct {
	Path string // absolute path inside the guest, e.g. "/usr/bin/env"
	Blob string // blob name under filesystem/, e.g. "0a1b2c3d4e.bin.zst"
	Size int64  // uncompressed size of the blob
}

// Options change how a filesystem is converted.
type Options struct {
	// NoChunks keeps every file in one blob, however large: the format armless 0.2.x reads
	NoChunks bool
}

// Result describes a converted filesystem.
type Result struct {
	Entries   int
	TotalSize int64
	Files     []File
	// Blob name -> path of the blob on disk
	Blobs map[string]string
}

// entry is one tar member in tar order; node is filled in once its contents are processed.
type entry struct {
	path     string
	typeflag byte
	mode     int64
	uid, gid int
	mtime    int64
	size     int64
	linkname string

	// The contents' blobs: one for a small file, its chunks for a large one
	blobs   []blob
	chunked bool
}

type blob struct {
	hash, name string
	size       int64
}

// Convert reads a tar stream and writes filesystem.json and filesystem/ under outDir.
func Convert(r io.Reader, outDir string, o Options) (*Result, error) {
	blobsDir := filepath.Join(outDir, "filesystem")
	if err := os.MkdirAll(blobsDir, 0o755); err != nil {
		return nil, err
	}

	entries, err := readAndStore(tar.NewReader(r), blobsDir, o)
	if err != nil {
		return nil, err
	}

	root, result, err := buildTree(entries, blobsDir)
	if err != nil {
		return nil, err
	}

	f, err := os.Create(filepath.Join(outDir, "filesystem.json"))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	doc := map[string]any{"fsroot": root, "version": formatVersion, "size": result.TotalSize}
	if err := json.NewEncoder(f).Encode(doc); err != nil {
		return nil, err
	}
	return result, f.Close()
}

type job struct {
	index int
	data  []byte
}

// readAndStore walks the tar sequentially and hands regular file contents to a worker pool that
// hashes, compresses and writes them.
func readAndStore(tr *tar.Reader, blobsDir string, o Options) ([]*entry, error) {
	var (
		entries []*entry
		mu      sync.Mutex
		wg      sync.WaitGroup
		errOnce sync.Once
		werr    error
	)

	workers := runtime.GOMAXPROCS(0)
	jobs := make(chan job, workers*2)

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			enc, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedBestCompression), zstd.WithEncoderConcurrency(1))
			if err != nil {
				errOnce.Do(func() { werr = err })
				for range jobs {
				}
				return
			}
			defer enc.Close()

			for j := range jobs {
				parts := [][]byte{j.data}
				chunked := !o.NoChunks && len(j.data) >= ChunkThreshold
				if chunked {
					parts = chunks(j.data)
				}
				blobs := make([]blob, len(parts))
				for i, part := range parts {
					sum := sha256.Sum256(part)
					hash := hex.EncodeToString(sum[:])
					blobs[i] = blob{hash, hash[:hashLength] + ".bin.zst", int64(len(part))}
					if err := writeBlob(filepath.Join(blobsDir, blobs[i].name), enc.EncodeAll(part, nil)); err != nil {
						errOnce.Do(func() { werr = err })
					}
				}

				mu.Lock()
				entries[j.index].blobs, entries[j.index].chunked = blobs, chunked
				mu.Unlock()
			}
		}()
	}

	readErr := func() error {
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("reading tar: %w", err)
			}

			p := normalize(h.Name)
			// /.dockerenv marks a container, which the guest is not: if a layer carries one, leave it out
			if p == "" || p == ".dockerenv" {
				continue
			}

			e := &entry{
				path:     p,
				typeflag: h.Typeflag,
				mode:     h.Mode,
				uid:      h.Uid,
				gid:      h.Gid,
				mtime:    h.ModTime.Unix(),
				size:     h.Size,
				linkname: h.Linkname,
			}
			if h.Typeflag == tar.TypeLink {
				e.linkname = normalize(h.Linkname)
			}
			// Nothing outside the root: refused, not folded into it over a file of the same name
			if escapes(p) || (h.Typeflag == tar.TypeLink && escapes(e.linkname)) {
				return fmt.Errorf("tar entry %s escapes the root", h.Name)
			}

			mu.Lock()
			entries = append(entries, e)
			index := len(entries) - 1
			mu.Unlock()

			if h.Typeflag == tar.TypeReg || h.Typeflag == tar.TypeRegA || h.Typeflag == tar.TypeCont {
				data, err := io.ReadAll(tr)
				if err != nil {
					return fmt.Errorf("reading %s: %w", p, err)
				}
				jobs <- job{index: index, data: data}
			}
		}
	}()

	close(jobs)
	wg.Wait()

	if readErr != nil {
		return nil, readErr
	}
	return entries, werr
}

// writeBlob writes a blob unless an identical one exists; write-then-rename so concurrent
// writers of the same content never interleave.
func writeBlob(target string, data []byte) error {
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".blob-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

// buildTree turns the flat entry list into v86's nested node arrays:
// [name, size, mtime, mode, uid, gid, filename | [[chunk, length]...] | symlink target | children]
func buildTree(entries []*entry, blobsDir string) ([]any, *Result, error) {
	result := &Result{Entries: len(entries), Blobs: map[string]string{}}
	nodes := make(map[string][]any, len(entries))
	children := map[string][]string{}
	files := map[string]*entry{}
	fullHash := map[string]string{}

	for _, e := range entries {
		node := []any{path.Base(e.path), e.size, e.mtime, e.mode, e.uid, e.gid}

		switch e.typeflag {
		case tar.TypeReg, tar.TypeRegA, tar.TypeCont:
			for _, b := range e.blobs {
				if prev, ok := fullHash[b.name]; ok && prev != b.hash {
					return nil, nil, fmt.Errorf("collision in short hash (%s and %s)", prev, b.hash)
				}
				fullHash[b.name] = b.hash
			}
			node[3] = e.mode | sIFREG
			node = append(node, e.target())
			files[e.path] = e

		case tar.TypeLink:
			// Hard links become independent files sharing the target's blob
			target, ok := files[e.linkname]
			if !ok {
				return nil, nil, fmt.Errorf("hard link %s points at unknown %s", e.path, e.linkname)
			}
			e.blobs, e.chunked, e.size = target.blobs, target.chunked, target.size
			node[1] = target.size
			node[3] = e.mode | sIFREG
			node = append(node, e.target())
			files[e.path] = e

		case tar.TypeDir:
			node[3] = e.mode | sIFDIR
			node = append(node, nil) // children, filled in below

		case tar.TypeSymlink:
			node[3] = e.mode | sIFLNK
			node = append(node, e.linkname)

		default:
			fmt.Fprintf(os.Stderr, "rootfs: unsupported tar entry type %q (%s)\n", e.typeflag, e.path)
		}

		result.TotalSize += e.size
		addNode(nodes, children, e.path, node, e.mtime)
	}

	for _, e := range entries {
		for _, b := range e.blobs {
			result.Files = append(result.Files, File{Path: "/" + e.path, Blob: b.name, Size: b.size})
			result.Blobs[b.name] = filepath.Join(blobsDir, b.name)
		}
	}

	var tree func(dir string) []any
	tree = func(dir string) []any {
		out := []any{}
		for _, p := range children[dir] {
			node := nodes[p]
			if len(node) == 7 && node[6] == nil {
				node[6] = tree(p)
			}
			out = append(out, node)
		}
		return out
	}
	return tree(""), result, nil
}

// target is a regular file's last node field: its blob, or its chunks as [blob, length] pairs.
func (e *entry) target() any {
	if !e.chunked {
		return e.blobs[0].name
	}
	pairs := make([][]any, len(e.blobs))
	for i, b := range e.blobs {
		pairs[i] = []any{b.name, b.size}
	}
	return pairs
}

// addNode records a node under its parent, creating parent directories the tar never listed
// (docker export lists them all, but other tar sources may not)
func addNode(nodes map[string][]any, children map[string][]string, p string, node []any, mtime int64) {
	if _, exists := nodes[p]; !exists {
		parent := path.Dir(p)
		if parent == "." {
			parent = ""
		}
		if parent != "" {
			if _, ok := nodes[parent]; !ok {
				addNode(nodes, children, parent, []any{path.Base(parent), 0, mtime, int64(sIFDIR | 0o755), 0, 0, nil}, mtime)
			}
		}
		children[parent] = append(children[parent], p)
	}
	nodes[p] = node
}

// normalize is a tar member's path relative to the root, cleaned: "" for the root itself, and
// starting with ".." for one that climbs out of it.
func normalize(name string) string {
	name = path.Clean(strings.TrimLeft(name, "/"))
	if name == "." {
		return ""
	}
	return name
}

// escapes says whether a normalized path climbs out of the root.
func escapes(p string) bool {
	return p == ".." || strings.HasPrefix(p, "../")
}
