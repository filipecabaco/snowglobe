// Package native finds snowglobe-vm for running sites on this machine, with no container around
// it: the process sandboxes itself (Landlock and seccomp on Linux, Seatbelt on macOS).
//
// In order: $SNOWGLOBE_VM; this release's snowglobe-vm for the system (a release asset, fetched
// once into the user cache); on Linux, the tools image's (the same static binary, copied out of
// the image once, which needs Docker). Without any, runs fall back to a container.
package native

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Releases is where snowglobe's releases are published.
const Releases = "https://github.com/filipecabaco/snowglobe/releases/download"

// ErrNone means no snowglobe-vm could be found for this system.
var ErrNone = errors.New("no snowglobe-vm for this system")

// Image is the tools image to copy snowglobe-vm out of, as a last resort on Linux: Key names its
// contents (tools.Version), Extract copies the binary to a path (building or pulling the image
// first, which needs Docker).
type Image struct {
	Key     string
	Extract func(dest string) error
}

// VM returns snowglobe-vm for this machine.
func VM(version string, image *Image) (string, error) {
	return For(version, runtime.GOOS, runtime.GOARCH, image)
}

// For returns snowglobe-vm for goos/goarch: $SNOWGLOBE_VM (for this machine only), the release's,
// or, for Linux on this machine's architecture, the tools image's.
func For(version, goos, goarch string, image *Image) (string, error) {
	if p := os.Getenv("SNOWGLOBE_VM"); p != "" && goos == runtime.GOOS && goarch == runtime.GOARCH {
		return p, nil
	}
	if strings.HasPrefix(version, "v") {
		if p, err := Release(version, goos, goarch); err == nil {
			return p, nil
		}
	}
	if goos == "linux" && goarch == runtime.GOARCH && image != nil {
		cache, err := os.UserCacheDir()
		if err != nil {
			return "", err
		}
		dest := filepath.Join(cache, "snowglobe", "runtime", "tools-"+image.Key, "snowglobe-vm")
		if _, err := os.Stat(dest); err == nil {
			return dest, nil
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return "", err
		}
		if err := image.Extract(dest + ".tmp"); err != nil {
			return "", err
		}
		return dest, os.Rename(dest+".tmp", dest)
	}
	return "", fmt.Errorf("%w (%s/%s): set SNOWGLOBE_VM, or use a release of snowglobe", ErrNone, goos, goarch)
}

// Release returns this version's released snowglobe-vm for goos/goarch, downloaded once into the
// user cache.
func Release(version, goos, goarch string) (string, error) {
	if !strings.HasPrefix(version, "v") {
		return "", fmt.Errorf("this snowglobe (%s) isn't a release, so it has no released snowglobe-vm: "+
			"build one (cargo build --release in internal/tools/runtime) and set SNOWGLOBE_VM or pass --runtime", version)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	name := "snowglobe-vm_" + strings.TrimPrefix(version, "v") + "_" + goos + "_" + goarch
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
	return dest, Extract(resp.Body, name+"/snowglobe-vm", dest)
}

// Extract writes the tarball member `member` to dest (executable).
func Extract(r io.Reader, member, dest string) error {
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

// DockerAvailable says whether there is a Docker to fall back to.
func DockerAvailable() bool {
	_, err := exec.LookPath("docker")
	return err == nil
}
