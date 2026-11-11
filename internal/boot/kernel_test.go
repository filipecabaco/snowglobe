package boot

import (
	"strings"
	"testing"
)

// kernelConfig is the configuration kernel.Dockerfile builds the kernel with.
func kernelConfig(t *testing.T) map[string]string {
	t.Helper()
	_, rest, ok := strings.Cut(string(kernelDockerfile), "COPY <<'CONFIG' /snowglobe.config\n")
	body, _, ok2 := strings.Cut(rest, "\nCONFIG\n")
	if !ok || !ok2 {
		t.Fatal("kernel.Dockerfile has no snowglobe.config heredoc")
	}
	config := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && strings.HasPrefix(k, "CONFIG_") {
			config[k] = v
		}
	}
	return config
}

// With no initramfs and no modules, the kernel must have built in everything that mounts the root
// over 9p, gives init a console, and drives armless's devices
func TestTheKernelHasArmlesssMachineBuiltIn(t *testing.T) {
	config := kernelConfig(t)
	for _, opt := range []string{
		"VIRTIO_PCI", "PCI_HOST_GENERIC", "NET_9P_VIRTIO", "9P_FS", "VIRTIO_CONSOLE", "VIRTIO_NET",
		"SERIAL_8250_CONSOLE", "ARM_GIC", "RTC_DRV_PL031", "VMGENID", "ARM_PSCI_FW", "HOTPLUG_CPU",
		"DEVTMPFS_MOUNT", "PROC_FS", "SYSFS", "TMPFS", "UNIX98_PTYS", "UNIX", "INET", "PACKET",
		"FUTEX", "EPOLL", "SYSVIPC", "IPV6",
	} {
		if config["CONFIG_"+opt] != "y" {
			t.Errorf("CONFIG_%s is not built in", opt)
		}
	}
	if config["CONFIG_MODULES"] == "y" {
		t.Error("modules: nothing would load them")
	}
}

// The kernel's source is the one release, checked
func TestTheKernelsSourceIsPinned(t *testing.T) {
	d := string(kernelDockerfile)
	if !strings.Contains(d, "ARG SHA256=") || !strings.Contains(d, "sha256sum -c") {
		t.Error("the kernel tarball is not checked against its sha256")
	}
}

func TestKernelIsSnowglobeBootWhenSet(t *testing.T) {
	t.Setenv("SNOWGLOBE_BOOT", "/somewhere/boot.tar.gz")
	if p, err := Kernel("v1.2.3"); err != nil || p != "/somewhere/boot.tar.gz" {
		t.Fatalf("got %q, %v", p, err)
	}
}
