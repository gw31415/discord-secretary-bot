#!/bin/sh
# Fetches wasi-sdk and cJSON into $DEST (mounted at /toolchain in the box). Runs on the host, with network.
set -eu
: "${DEST:?}" "${ARCH:?}"
SDK=25
case "$ARCH" in
  aarch64) A=arm64; SUM=47fccad8b2498f2239e05e1115c3ffc652bf37e7de2f88fb64b2d663c976ce2d ;;
  x86_64) A=x86_64; SUM=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/sdk.tar.gz" "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$SDK/wasi-sdk-$SDK.0-$A-linux.tar.gz"
echo "$SUM  $TMP/sdk.tar.gz" | sha256sum -c -
tar xzf "$TMP/sdk.tar.gz" -C "$DEST" --strip-components=1
CJSON=v1.7.18
mkdir -p "$DEST/cjson"
for f in cJSON.c cJSON.h LICENSE; do curl -fsSL -o "$DEST/cjson/$f" "https://raw.githubusercontent.com/DaveGamble/cJSON/$CJSON/$f"; done
(cd "$DEST/cjson" && sha256sum -c - <<SUMS)
75c51de8fa40ac9d7a99319c6330719bd692eb81c0a869265f3d4c682533f9b9  cJSON.c
0578cc29132912edbc88f83207a8fc76e5db3db0605497e909a9384ef3cc474b  cJSON.h
a36dda207c36db5818729c54e7ad4e8b0c6fba847491ba64f372c1a2037b6d5c  LICENSE
SUMS
