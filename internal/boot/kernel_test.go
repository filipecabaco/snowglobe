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
		// Free page reporting: snapshots leave out the memory the guest freed
		"VIRTIO_BALLOON", "PAGE_REPORTING",
	} {
		if config["CONFIG_"+opt] != "y" {
			t.Errorf("CONFIG_%s is not built in", opt)
		}
	}
	if config["CONFIG_MODULES"] == "y" {
		t.Error("modules: nothing would load them")
	}
}

// A job's limits (--memory-limit, --cpus-limit, --pids-limit) are a cgroup v2 of its own in the
// guest: the kernel has the controllers they set, and init mounts the hierarchy
func TestTheKernelHasTheCgroupControllersAJobsLimitsUse(t *testing.T) {
	config := kernelConfig(t)
	for _, opt := range []string{"CGROUPS", "MEMCG", "CGROUP_PIDS", "CGROUP_SCHED", "FAIR_GROUP_SCHED", "CFS_BANDWIDTH"} {
		if config["CONFIG_"+opt] != "y" {
			t.Errorf("CONFIG_%s is not built in", opt)
		}
	}
	init := ""
	for _, f := range Files(Console{}, "none", nil) {
		if f.Name == "usr/local/sbin/snowglobe-init" {
			init = string(f.Data)
		}
	}
	if !strings.Contains(init, "mount -t cgroup2 cgroup2 /sys/fs/cgroup") {
		t.Errorf("init doesn't mount cgroup2:\n%s", init)
	}
	// The controllers handed down and the jobs' cgroup made at boot, not by each job
	for _, want := range []string{`for c in memory cpu pids; do echo "+$c" >/sys/fs/cgroup/cgroup.subtree_control`, "mkdir /sys/fs/cgroup/sgjob"} {
		if !strings.Contains(init, want) {
			t.Errorf("init doesn't %q:\n%s", want, init)
		}
	}
	// SCHED_MM_CID, which CGROUPS turns on and Kconfig can't turn off, is patched off (and checked)
	d := string(kernelDockerfile)
	if !strings.Contains(d, "s/def_bool y/def_bool n/") || !strings.Contains(d, "! grep -q '^CONFIG_SCHED_MM_CID=y' .config") {
		t.Error("the kernel build doesn't turn SCHED_MM_CID off")
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
