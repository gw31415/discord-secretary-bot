#!/bin/sh
# Fetches TinyGo and the Go toolchain it compiles the standard library from into
# $DEST (mounted at /toolchain in the box). Runs on the host, with network.
set -eu
: "${DEST:?}" "${ARCH:?}"
TINYGO=0.43.0
GO=1.25.3
case "$ARCH" in
  aarch64) A=arm64; TSUM=a2165b9f46aff9a895a0abed54aedffab1e93317a387c6c2e9dd839425527cbd; GSUM=1d42ebc84999b5e2069f5e31b67d6fc5d67308adad3e178d5a2ee2c9ff2001f5 ;;
  x86_64) A=amd64; TSUM=ca9fc6d055e3889462dea4450a2e42a92242d88b5c362a7ec39bdb563413d78a; GSUM=0335f314b6e7bfe08c3d0cfaa7c19db961b7b99fb20be62b0a826c992ad14e0f ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/tinygo.tar.gz" "https://github.com/tinygo-org/tinygo/releases/download/v$TINYGO/tinygo$TINYGO.linux-$A.tar.gz"
curl -fsSL -o "$TMP/go.tar.gz" "https://go.dev/dl/go$GO.linux-$A.tar.gz"
echo "$TSUM  $TMP/tinygo.tar.gz" | sha256sum -c -
echo "$GSUM  $TMP/go.tar.gz" | sha256sum -c -
tar --no-same-owner -xzf "$TMP/tinygo.tar.gz" -C "$DEST"
tar --no-same-owner -xzf "$TMP/go.tar.gz" -C "$DEST"
mkdir -p "$DEST/bin"
ln -s ../tinygo/bin/tinygo "$DEST/bin/tinygo"
ln -s ../go/bin/go "$DEST/bin/go"
