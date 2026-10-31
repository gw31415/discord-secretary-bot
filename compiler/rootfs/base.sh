#!/bin/sh
# The root filesystem every build box starts from: a minimal Ubuntu with a C
# toolchain for the host (Rust's build scripts and proc macros link with cc;
# MicroPython's prewarm builds with make and python3).
# Nothing of the host is copied in. Needs root, network and mmdebstrap.
# Usage (through main.ts): DEST=<dir> sh rootfs/base.sh
set -eu
: "${DEST:?}"
case "$(uname -m)" in
  aarch64) MIRROR=http://ports.ubuntu.com/ubuntu-ports ;;
  x86_64) MIRROR=http://archive.ubuntu.com/ubuntu ;;
  *) echo "unsupported: $(uname -m)" >&2; exit 1 ;;
esac
command -v mmdebstrap >/dev/null || { echo "mmdebstrap がありません(sudo apt-get install mmdebstrap)" >&2; exit 1; }
mmdebstrap --variant=minbase --components=main,universe \
  --include=gcc,libc6-dev,make,python3,ca-certificates,xz-utils \
  --dpkgopt='path-exclude=/usr/share/man/*' --dpkgopt='path-exclude=/usr/share/doc/*' --dpkgopt='path-exclude=/usr/share/locale/*' \
  noble "$DEST" "$MIRROR"
# Nothing in the box needs these, and an empty /etc/apt keeps it from looking like a place to install.
rm -rf "$DEST/var/cache/apt" "$DEST/var/lib/apt/lists"
echo "wasm-compiler" > "$DEST/etc/hostname"
