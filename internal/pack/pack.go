// Package pack writes a built site as one self-contained tarball, the unit `snowglobe run`
// downloads from a CDN. A pooled site gets its blobs back, so the archive stands on its own and
// can also be unpacked and served as a site.
package pack

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"

	"github.com/filipecabaco/snowglobe/internal/remote"
)

// Run packs site into out (.tar.gz, .tgz, .tar.zst or .tar) and returns the archive's size.
func Run(site, out string) (int64, error) {
	if _, err := os.Stat(filepath.Join(site, "run.json")); err != nil {
		return 0, fmt.Errorf("%s isn't a built snowglobe site (no run.json)", site)
	}
	// Not into the site: the walk would read the archive as it is written
	if absSite, err := filepath.Abs(site); err == nil {
		if absOut, err := filepath.Abs(out); err == nil && strings.HasPrefix(absOut, absSite+string(filepath.Separator)) {
			return 0, fmt.Errorf("%s is inside the site %s: write the archive somewhere else", out, site)
		}
	}
	// The name first: a file that isn't to be an archive is left alone
	if !strings.HasSuffix(out, ".tar.gz") && !strings.HasSuffix(out, ".tgz") && !strings.HasSuffix(out, ".tar.zst") &&
		!strings.HasSuffix(out, ".tar") {
		return 0, fmt.Errorf("%s: name it .tar.gz, .tar.zst or .tar", out)
	}
	f, err := os.Create(out)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	ok := false
	defer func() {
		if !ok {
			os.Remove(out) // half an archive is none
		}
	}()

	var w io.WriteCloser = nopCloser{f}
	switch {
	case strings.HasSuffix(out, ".tar.gz") || strings.HasSuffix(out, ".tgz"):
		w = gzip.NewWriter(f)
	case strings.HasSuffix(out, ".tar.zst"):
		if w, err = zstd.NewWriter(f); err != nil {
			return 0, err
		}
	}
	tw := tar.NewWriter(w)

	pooled := false
	if _, err := os.Stat(filepath.Join(site, "system", "filesystem")); err != nil {
		pooled = true
	}

	err = filepath.WalkDir(site, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(site, p)
		if rel == "." || d.IsDir() {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		// A pooled page reads blobs from ../blobs; in the archive they're back in the site
		if pooled && rel == "index.html" {
			data = []byte(strings.ReplaceAll(string(data), `"../blobs/"`, `"system/filesystem/"`))
		}
		return add(tw, filepath.ToSlash(rel), data)
	})
	if err == nil && pooled {
		err = addPooledBlobs(tw, site)
	}
	if err == nil {
		err = tw.Close()
	}
	if err == nil {
		err = w.Close()
	}
	if err != nil {
		return 0, err
	}
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	ok = true
	return info.Size(), nil
}

func addPooledBlobs(tw *tar.Writer, site string) error {
	names, err := remote.BlobNames(filepath.Join(site, "system", "filesystem.json"))
	if err != nil {
		return err
	}
	store := filepath.Join(filepath.Dir(site), "blobs")
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(store, name))
		if err != nil {
			return fmt.Errorf("pooled blob %s: %w", name, err)
		}
		if err := add(tw, "system/filesystem/"+name, data); err != nil {
			return err
		}
	}
	return nil
}

func add(tw *tar.Writer, name string, data []byte) error {
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }
