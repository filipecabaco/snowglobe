package bundle

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Releases is where snowglobe's releases are published.
const Releases = "https://github.com/filipecabaco/snowglobe/releases/download"

// DarwinRuntime returns snowglobe-vm for macOS on Apple silicon from this version's release,
// downloaded once into the user cache.
func DarwinRuntime(version string) (string, error) {
	if !strings.HasPrefix(version, "v") {
		return "", fmt.Errorf("this snowglobe (%s) isn't a release, so it has no macOS runtime to fetch: "+
			"build one (cargo build --release in internal/tools/runtime) and pass --runtime", version)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	name := "snowglobe-vm_" + strings.TrimPrefix(version, "v") + "_darwin_arm64"
	dest := filepath.Join(cache, "snowglobe", "runtime", name, "snowglobe-vm")
	if _, err := os.Stat(dest); err == nil {
		return dest, nil
	}
	url := Releases + "/" + version + "/" + name + ".tar.gz"
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", url, resp.Status)
	}
	return dest, extract(resp.Body, name+"/snowglobe-vm", dest)
}

// extract writes the tarball member `member` to dest (executable).
func extract(r io.Reader, member, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s not in the release's archive", member)
		}
		if err != nil {
			return err
		}
		if h.Name != member {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		tmp := dest + ".tmp"
		f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, tr); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return os.Rename(tmp, dest)
	}
}
