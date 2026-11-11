# The kernel archive every build adds as a layer: a Linux kernel for exactly armless's machine,
# everything built in. No initramfs and no modules: the guest mounts its root over 9p straight from
# the command line (root=host9p rootfstype=9p rootflags=trans=virtio,...). Nothing in it depends on
# the app image, so it is built once (a release asset) and added as a layer.
#
# Against Alpine's generic linux-virt with its initramfs and 883 modules, it is a 5 MB kernel in a
# 2 MB archive (from 41 MB), boots in a sixth of the time, and halves a site's snapshot and its
# machines' memory. It is the kernel linux-virt is (6.18.60), configured below on allnoconfig.
#
# Compiled on the build host (a cross-compiler where that is not arm64: the release runs here on
# x86-64, where an arm64 compile under QEMU would take hours); only the image the archive is read
# from is arm64.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS build
ARG VERSION=6.18.60
ARG SHA256=3c2f44ef6acc021a7ad444d9a2e6ec1ef488ff09368793d0004a6080f69d621e
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential bc flex bison libssl-dev libelf-dev curl ca-certificates xz-utils && \
    if [ "$(uname -m)" != aarch64 ]; then apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu binutils-aarch64-linux-gnu; fi && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o /linux.tar.xz "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${VERSION}.tar.xz" && \
    echo "${SHA256}  /linux.tar.xz" | sha256sum -c - && \
    tar -xJf /linux.tar.xz --strip-components=1 && rm /linux.tar.xz

# Merged onto allnoconfig. With EXPERT on, KCONFIG_ALLCONFIG fixes these first, so allnoconfig also
# turns off what only EXPERT shows (the block layer, kallsyms, ...), not just what's always visible
COPY <<'CONFIG' /snowglobe.config
CONFIG_LOCALVERSION="-snowglobe"
CONFIG_EXPERT=y
CONFIG_MULTIUSER=y
CONFIG_PRINTK=y
CONFIG_BUG=y
CONFIG_FUTEX=y
CONFIG_EPOLL=y
CONFIG_SIGNALFD=y
CONFIG_TIMERFD=y
CONFIG_EVENTFD=y
CONFIG_SHMEM=y
CONFIG_AIO=y
CONFIG_ADVISE_SYSCALLS=y
CONFIG_MEMBARRIER=y
CONFIG_RSEQ=y
CONFIG_FHANDLE=y
CONFIG_POSIX_TIMERS=y
CONFIG_SYSVIPC=y
CONFIG_POSIX_MQUEUE=y
CONFIG_FILE_LOCKING=y
CONFIG_INOTIFY_USER=y
CONFIG_NO_HZ_IDLE=y
CONFIG_HIGH_RES_TIMERS=y
CONFIG_BINFMT_ELF=y
CONFIG_BINFMT_SCRIPT=y

# CPUs: up to 8, and hotplug (the snapshot takes the build's extra CPUs offline)
CONFIG_SMP=y
CONFIG_NR_CPUS=8
CONFIG_HOTPLUG_CPU=y
CONFIG_ARM64_4K_PAGES=y
CONFIG_ARM64_VA_BITS_48=y
CONFIG_ARM_PSCI_FW=y

# The board: GICv2 (and v3), generic timer, PL031 RTC, 16550 UART, vmgenid
CONFIG_ARM_GIC=y
CONFIG_ARM_GIC_V3=y
CONFIG_ARM_AMBA=y
CONFIG_RTC_CLASS=y
CONFIG_RTC_HCTOSYS=y
CONFIG_RTC_DRV_PL031=y
CONFIG_TTY=y
CONFIG_UNIX98_PTYS=y
CONFIG_SERIAL_8250=y
CONFIG_SERIAL_8250_CONSOLE=y
CONFIG_SERIAL_OF_PLATFORM=y
CONFIG_SERIAL_8250_NR_UARTS=1
CONFIG_SERIAL_8250_RUNTIME_UARTS=1
CONFIG_VIRT_DRIVERS=y
CONFIG_VMGENID=y

# virtio-pci (modern) on a generic ECAM host: console, 9p, net
CONFIG_PCI=y
CONFIG_PCI_HOST_GENERIC=y
CONFIG_VIRTIO_MENU=y
CONFIG_VIRTIO_PCI=y
CONFIG_VIRTIO_CONSOLE=y
CONFIG_NET=y
CONFIG_UNIX=y
CONFIG_INET=y
CONFIG_PACKET=y
CONFIG_NETDEVICES=y
CONFIG_NET_CORE=y
CONFIG_VIRTIO_NET=y
CONFIG_NET_9P=y
CONFIG_NET_9P_VIRTIO=y
CONFIG_NETWORK_FILESYSTEMS=y
CONFIG_9P_FS=y

# Filesystems the guest's init mounts; devtmpfs mounted by the kernel, as there is no initramfs
# to give init a /dev/console
CONFIG_PROC_FS=y
CONFIG_PROC_SYSCTL=y
CONFIG_SYSFS=y
CONFIG_DEVTMPFS=y
CONFIG_DEVTMPFS_MOUNT=y
CONFIG_TMPFS=y

# What apps commonly expect beyond that: IPv6 (Node and Postgres listen on ::1 too), io_uring
# (probed by some runtimes, which fall back without it), /proc/<pid>/smaps (the JVM reads it)
CONFIG_IPV6=y
CONFIG_IO_URING=y
CONFIG_PROC_PAGE_MONITOR=y
CONFIG
RUN cross=; [ "$(uname -m)" = aarch64 ] || cross=aarch64-linux-gnu-; \
    KCONFIG_ALLCONFIG=/snowglobe.config make ARCH=arm64 CROSS_COMPILE=$cross allnoconfig && \
    for opt in $(grep -o '^CONFIG_[A-Z0-9_]*=y' /snowglobe.config); do \
      grep -qx "$opt" .config || { echo "not in the kernel's config: $opt"; exit 1; }; done && \
    make ARCH=arm64 CROSS_COMPILE=$cross -j"$(nproc)" Image

# The image the archive is read from (BuildKernel: a tar of boot/vmlinuz-virt)
FROM alpine:3.24.2
COPY --from=build /src/arch/arm64/boot/Image /boot/vmlinuz-virt
