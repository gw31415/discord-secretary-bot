#!/bin/sh
# Fetches the Go toolchain into $DEST (mounted at /toolchain in the box). Runs on the host, with network.
set -eu
: "${DEST:?}" "${ARCH:?}"
GO=1.25.3
case "$ARCH" in
  aarch64) A=arm64; SUM=1d42ebc84999b5e2069f5e31b67d6fc5d67308adad3e178d5a2ee2c9ff2001f5 ;;
  x86_64) A=amd64; SUM=0335f314b6e7bfe08c3d0cfaa7c19db961b7b99fb20be62b0a826c992ad14e0f ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/go.tar.gz" "https://go.dev/dl/go$GO.linux-$A.tar.gz"
echo "$SUM  $TMP/go.tar.gz" | sha256sum -c -
tar xzf "$TMP/go.tar.gz" -C "$DEST"
mkdir -p "$DEST/bin"
ln -s ../go/bin/go "$DEST/bin/go"
