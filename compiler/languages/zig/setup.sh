#!/bin/sh
# Fetches Zig into $DEST (mounted at /toolchain in the box). Runs on the host, with network.
set -eu
: "${DEST:?}" "${ARCH:?}"
ZIG=0.17.0
case "$ARCH" in
  aarch64) SUM=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8 ;;
  x86_64) SUM=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/zig.tar.xz" "https://ziglang.org/download/$ZIG/zig-$ARCH-linux-$ZIG.tar.xz"
echo "$SUM  $TMP/zig.tar.xz" | sha256sum -c -
mkdir -p "$DEST/zig" "$DEST/bin"
tar --no-same-owner -xJf "$TMP/zig.tar.xz" -C "$DEST/zig" --strip-components=1
ln -s ../zig/zig "$DEST/bin/zig"
