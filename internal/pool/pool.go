// Package pool lets several snowglobe sites share one blob directory. Blobs are named by content
// hash, so sites built from related images (same kernel, same base distro) share many of them:
// pooling stores each once, and a visitor's second site reuses what their browser cached.
package pool

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"
)

const (
	// what snowglobe's page uses for its own blobs, and what it becomes once pooled
	ownBlobs = `baseurl: "system/filesystem/"`
	marker   = ".snowglobe"
)

// Stats summarises a pooling run.
type Stats struct {
	Sites, Files, Unique int
	Saved                int64
}

// Run pools every site directly under root (each <root>/<site>/ built by snowglobe) into
// <root>/blobs/ and points each site's page there.
func Run(root string) (Stats, error) {
	var stats Stats
	blobs := filepath.Join(root, "blobs")
	if err := os.MkdirAll(blobs, 0o755); err != nil {
		return stats, err
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return stats, err
	}
	for _, e := range entries {
		site := filepath.Join(root, e.Name())
		if !e.IsDir() || !exists(filepath.Join(site, marker)) {
			continue
		}
		files, err := filepath.Glob(filepath.Join(site, "system", "filesystem", "*"))
		if err != nil {
			return stats, err
		}
		if len(files) == 0 {
			continue // already pooled
		}
		// The page first: one that can't be pointed at the pool keeps its blobs
		index := filepath.Join(site, "index.html")
		page, err := repoint(index)
		if err != nil {
			return stats, err
		}

		// Then that no blob of the same name in the pool holds something else (names are short
		// hashes), before any blob moves
		for _, file := range files {
			target := filepath.Join(blobs, filepath.Base(file))
			if exists(target) {
				same, err := sameBlob(file, target)
				if err != nil {
					return stats, err
				}
				if !same {
					return stats, fmt.Errorf("%s and %s have one name but different contents: rebuild one of them", file, target)
				}
			}
		}

		for _, file := range files {
			target := filepath.Join(blobs, filepath.Base(file))
			if exists(target) {
				info, _ := os.Stat(file)
				stats.Saved += info.Size()
				if err := os.Remove(file); err != nil {
					return stats, err
				}
			} else {
				if err := os.Rename(file, target); err != nil {
					return stats, err
				}
				stats.Unique++
			}
			stats.Files++
		}
		if err := os.Remove(filepath.Join(site, "system", "filesystem")); err != nil {
			return stats, err
		}
		if err := os.WriteFile(index, page, 0o644); err != nil {
			return stats, err
		}
		stats.Sites++
	}
	if stats.Sites == 0 {
		return stats, fmt.Errorf("no unpooled snowglobe sites found under %s", root)
	}
	return stats, nil
}

// sameBlob says whether two blobs hold the same file: the same bytes, or the same once
// decompressed (another snowglobe may compress it differently).
func sameBlob(a, b string) (bool, error) {
	x, err := os.ReadFile(a)
	if err != nil {
		return false, err
	}
	y, err := os.ReadFile(b)
	if err != nil {
		return false, err
	}
	if bytes.Equal(x, y) {
		return true, nil
	}
	d, err := zstd.NewReader(nil)
	if err != nil {
		return false, err
	}
	defer d.Close()
	dx, errX := d.DecodeAll(x, nil)
	dy, errY := d.DecodeAll(y, nil)
	return errX == nil && errY == nil && bytes.Equal(dx, dy), nil
}

// repoint is the page in index with its blobs in the pool.
func repoint(index string) ([]byte, error) {
	html, err := os.ReadFile(index)
	if err != nil {
		return nil, err
	}
	pooled := bytes.Replace(html, []byte(ownBlobs), []byte(`baseurl: "../blobs/"`), 1)
	if bytes.Equal(pooled, html) {
		return nil, fmt.Errorf("%s: couldn't find the blob location to repoint", index)
	}
	return pooled, nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
