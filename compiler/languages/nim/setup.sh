#!/bin/sh
# Fetches Nim and wasi-sdk (the clang that compiles Nim's C to wasm32-wasip1)
# into $DEST (mounted at /toolchain in the box). Runs on the host, with network.
set -eu
: "${DEST:?}" "${ARCH:?}"
NIM=2.2.12
SDK=25
case "$ARCH" in
  aarch64) N=linux_arm64; NSUM=3dc04191af72a8310cf1c8ffb6f772cc3716fc5f264bc7c453ab4aecb4085221; S=arm64; SSUM=47fccad8b2498f2239e05e1115c3ffc652bf37e7de2f88fb64b2d663c976ce2d ;;
  x86_64) N=linux_x64; NSUM=7df1611449a6842af69322aa2c1206942982650a5f6bc0d37bc8ec109932f638; S=x86_64; SSUM=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/nim.tar.xz" "https://nim-lang.org/download/nim-$NIM-$N.tar.xz"
curl -fsSL -o "$TMP/sdk.tar.gz" "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$SDK/wasi-sdk-$SDK.0-$S-linux.tar.gz"
echo "$NSUM  $TMP/nim.tar.xz" | sha256sum -c -
echo "$SSUM  $TMP/sdk.tar.gz" | sha256sum -c -
mkdir -p "$DEST/nim" "$DEST/wasi-sdk" "$DEST/bin"
tar --no-same-owner -xJf "$TMP/nim.tar.xz" -C "$DEST/nim" --strip-components=1
tar --no-same-owner -xzf "$TMP/sdk.tar.gz" -C "$DEST/wasi-sdk" --strip-components=1
ln -s ../nim/bin/nim "$DEST/bin/nim"
