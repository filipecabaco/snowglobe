package boot

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/filipecabaco/snowglobe/internal/docker"
	"github.com/filipecabaco/snowglobe/internal/native"
	"github.com/filipecabaco/snowglobe/internal/oci"
)

// The boot layer, for every build: nothing runs at build time (Docker, when there is one, only
// builds the Dockerfile).
//
// The kernel, everything built in (it mounts the root filesystem over 9p itself, with no initramfs
// and no modules), comes prebuilt as an archive (Kernel); everything else is files snowglobe writes (Files). The guest
// starts with BusyBox's init, getty and udhcpc, which every Alpine image has: an inittab, and a
// script doing what a service manager's boot services would (mounts, hostname, loopback, the
// network and its CA when the site has one), in a fraction of OpenRC's time.

//go:embed kernel.Dockerfile
var kernelDockerfile []byte

// Files is the boot layer's files, for an image whose app runs as console describes.
// EnvFiles is what a site with no kernel has of the boot layer: the image's environment in
// /etc/snowglobe/env, which a job sources (a job runs beside the program, in a shell of its own).
func EnvFiles(console Console) []oci.File {
	return []oci.File{
		{Name: "etc/snowglobe", Dir: true, Mode: 0o755},
		{Name: "etc/snowglobe/env", Mode: 0o644, Data: []byte(Env(console))},
	}
}

func Files(console Console, network string, caPEM []byte) []oci.File {
	init := `#!/bin/sh
# What a service manager's boot services would do, with BusyBox alone
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null
mkdir -p /dev/pts /dev/shm /run
mount -t devpts -o gid=5,mode=620 devpts /dev/pts
mount -t tmpfs -o mode=1777 shm /dev/shm
mount -t tmpfs -o mode=755 run /run
hostname -F /etc/hostname
ip link set lo up
`
	files := []oci.File{
		{Name: "dev", Dir: true, Mode: 0o755},
		{Name: "dev/pts", Dir: true, Mode: 0o755},
		{Name: "dev/shm", Dir: true, Mode: 0o1777},
		{Name: "etc/hostname", Data: []byte("snowglobe\n"), Mode: 0o644},
		{Name: "etc/resolv.conf", Data: nil, Mode: 0o644},
		// hvc0 (virtio console) is what the browser shows: it runs the app. ttyS0 (serial) gets a
		// root shell that the snapshot uses for housekeeping
		{Name: "etc/inittab", Mode: 0o644, Data: []byte(`::sysinit:/usr/local/sbin/snowglobe-init
ttyS0::respawn:/sbin/getty -n -i -l /bin/sh -L 115200 ttyS0 vt100
hvc0::respawn:/sbin/getty -n -i -l /usr/local/bin/snowglobe-login -L 115200 hvc0 xterm-256color
::shutdown:/bin/umount -a -r
`)},
		{Name: "usr/local/bin/snowglobe-login", Mode: 0o755, Data: []byte(`#!/bin/sh
# As a login would: a login shell's environment, then the app
export HOME=/root USER=root LOGNAME=root SHELL=/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /root 2>/dev/null
[ -f /etc/profile ] && . /etc/profile
exec /usr/local/bin/snowglobe-console
`)},
		{Name: "usr/local/bin/snowglobe-console", Mode: 0o755, Data: []byte(Script(console))},
		{Name: "etc/snowglobe", Dir: true, Mode: 0o755},
		{Name: "etc/snowglobe/env", Mode: 0o644, Data: []byte(Env(console))},
	}
	if network != "none" {
		// DHCP on the virtio NIC, which armless answers; HTTPS is terminated by armless's web relay
		// with certificates from a CA made for this build: trusted in the system bundle and by the
		// runtimes that keep their own (Node, Python's requests, Java)
		init += `modprobe virtio_net 2>/dev/null
ip link set eth0 up
udhcpc -i eth0 -q -t 10 -s /usr/share/udhcpc/default.script >/dev/null 2>&1
if [ ! -e /etc/ssl/certs/.snowglobe-sandbox ]; then
  mkdir -p /etc/ssl/certs
  cat /usr/local/share/ca-certificates/snowglobe-sandbox.crt >> /etc/ssl/certs/ca-certificates.crt
  touch /etc/ssl/certs/.snowglobe-sandbox
  command -v keytool >/dev/null && keytool -importcert -noprompt -cacerts -storepass changeit \
    -alias snowglobe-sandbox -file /usr/local/share/ca-certificates/snowglobe-sandbox.crt >/dev/null 2>&1
fi
`
		files = append(files,
			oci.File{Name: "usr/local/share/ca-certificates/snowglobe-sandbox.crt", Mode: 0o644, Data: caPEM},
			oci.File{Name: "etc/profile.d/snowglobe-ca.sh", Mode: 0o644, Data: []byte(
				"export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\n" +
					"export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt\n" +
					"export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/snowglobe-sandbox.crt\n")})
	}
	files = append(files, oci.File{Name: "usr/local/sbin/snowglobe-init", Mode: 0o755, Data: []byte(init)})
	return files
}

// Kernel is the archive of the kernel (boot/vmlinuz-virt, all built in: no initramfs, no modules),
// as a layer: $SNOWGLOBE_BOOT, else this release's, else
// built once with Docker and kept in the user cache.
func Kernel(version string) (string, error) {
	if p := os.Getenv("SNOWGLOBE_BOOT"); p != "" {
		return p, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(version, "v") {
		name := "snowglobe-boot_" + strings.TrimPrefix(version, "v") + "_arm64.tar.gz"
		dest := filepath.Join(cache, "snowglobe", "boot", name)
		if _, err := os.Stat(dest); err == nil {
			return dest, nil
		}
		if err := native.Download(native.Releases+"/"+version+"/"+name, dest); err == nil {
			return dest, nil
		}
	}
	if !native.DockerAvailable() {
		return "", fmt.Errorf("no kernel for builds without Docker: use a release of snowglobe, or set SNOWGLOBE_BOOT to a snowglobe-boot archive")
	}
	sum := sha256.Sum256(kernelDockerfile)
	dest := filepath.Join(cache, "snowglobe", "boot", "built-"+hex.EncodeToString(sum[:8])+".tar.gz")
	if _, err := os.Stat(dest); err == nil {
		return dest, nil
	}
	return dest, BuildKernel(dest)
}

// BuildKernel builds the kernel archive with Docker (for a release, or a build that has no release
// to fetch one from).
func BuildKernel(dest string) error {
	dir, err := os.MkdirTemp("", "snowglobe-kernel-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), kernelDockerfile, 0o644); err != nil {
		return err
	}
	const tag = "snowglobe-kernel:build"
	if err := docker.Run("build", "--platform", "linux/arm64", "--tag", tag, dir); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	// A temporary file of its own: another build may be making the same kernel at the same time
	f, err := os.CreateTemp(filepath.Dir(dest), filepath.Base(dest)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	err = docker.Stream(func(r io.Reader) error { _, err := io.Copy(f, r); return err },
		"run", "--rm", "--platform", "linux/arm64", tag,
		"tar", "-czf", "-", "-C", "/", "boot/vmlinuz-virt")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, 0o644)
	}
	if err == nil {
		err = os.Rename(tmp, dest)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}
