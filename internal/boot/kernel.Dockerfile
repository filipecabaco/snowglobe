# The kernel archive every build adds as a layer: linux-virt's kernel, an initramfs that mounts the
# root filesystem over 9p, and the kernel's modules. Nothing in it depends on the app image, so it
# is built once (a release asset) and added as a layer.
FROM alpine:3.24.2

# Alpine's init runs nlplug-findfs for any root=: it plugs in every device through mdev and waits
# for a block device named after the root. A 9p root is none, so that was most of the boot (13 s
# of 45 in CI) for nothing; the only module it loaded that the guest needs is the 9p transport.
# With rootfstype=9p the init loads that, waits for the share to show up, and mounts it.
COPY <<'EOF' /tmp/findfs.sh
snowglobe_findfs() {
	if [ "$KOPT_rootfstype" != 9p ]; then nlplug-findfs "$@"; return; fi
	modprobe 9pnet_virtio
	for _ in $(seq 100); do
		grep -qsx "$KOPT_root" /sys/bus/virtio/drivers/9pnet_virtio/*/mount_tag && return
		sleep 0.05
	done
	echo "snowglobe: no 9p share $KOPT_root after 5 s"
}
EOF

RUN apk add --no-cache linux-virt linux-firmware-none mkinitfs && \
    init=/usr/share/mkinitfs/initramfs-init && \
    grep -q '\$MOCK nlplug-findfs ' "$init" && \
    sed -i -e 's/\$MOCK nlplug-findfs /$MOCK snowglobe_findfs /' -e '1r /tmp/findfs.sh' "$init" && \
    grep -q '\$MOCK snowglobe_findfs ' "$init" && rm /tmp/findfs.sh && \
    mkinitfs -F "base virtio 9p" "$(cat /usr/share/kernel/virt/kernel.release)"
