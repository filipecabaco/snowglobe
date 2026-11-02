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
		// A temporary name of its own: another run may be copying it out at the same time
		tmp, err := os.MkdirTemp(filepath.Dir(dest), ".extract-")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(tmp)
		if err := image.Extract(filepath.Join(tmp, "snowglobe-vm")); err != nil {
			return "", err
		}
		return dest, os.Rename(filepath.Join(tmp, "snowglobe-vm"), dest)
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

// Download fetches url to dest (atomically).
func Download(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	return writeAtomically(dest, 0o644, resp.Body)
}

// writeAtomically writes r to dest through a temporary file of its own, so another process
// writing dest at the same time (two runs on a fresh machine) never leaves a mix of both, and a
// failed write leaves nothing.
func writeAtomically(dest string, mode os.FileMode, r io.Reader) error {
	f, err := os.CreateTemp(filepath.Dir(dest), filepath.Base(dest)+".tmp-*")
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(f.Name(), mode)
	}
	if err == nil {
		err = os.Rename(f.Name(), dest)
	}
	if err != nil {
		os.Remove(f.Name())
	}
	return err
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
		return writeAtomically(dest, 0o755, tr)
	}
}

// DockerAvailable says whether there is a Docker to fall back to.
func DockerAvailable() bool {
	_, err := exec.LookPath("docker")
	return err == nil
}
