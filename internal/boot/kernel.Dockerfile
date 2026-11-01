# The kernel archive for builds without Docker (snowglobe build --builder native): linux-virt's
# kernel, an initramfs that mounts the root filesystem over 9p, and the kernel's modules. Nothing
# in it depends on the app image, so it is built once (a release asset) and added as a layer.
FROM alpine:3.24.2
RUN apk add --no-cache linux-virt linux-firmware-none mkinitfs && \
    mkinitfs -F "base virtio 9p" "$(cat /usr/share/kernel/virt/kernel.release)"
