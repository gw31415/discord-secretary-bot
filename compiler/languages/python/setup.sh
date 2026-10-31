#!/bin/sh
# Fetches the MicroPython source, wasi-sdk (the clang that builds it for
# wasm32-wasip1) and binaryen (wasm-opt, for --spill-pointers) into $DEST
# (mounted at /toolchain in the box). Runs on the host, with network.
# prewarm.sh builds MicroPython in the box.
set -eu
: "${DEST:?}" "${ARCH:?}"
MP=1.29.0
MPSUM=d925a7c664e79a2bdf3dfcb285ba5e2237041cc35a0bd4ee573b6c5711efeca0
SDK=25
BINARYEN=133
case "$ARCH" in
  aarch64) S=arm64; SSUM=47fccad8b2498f2239e05e1115c3ffc652bf37e7de2f88fb64b2d663c976ce2d; BSUM=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8 ;;
  x86_64) S=x86_64; SSUM=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c; BSUM=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/mp.tar.xz" "https://micropython.org/resources/source/micropython-$MP.tar.xz"
curl -fsSL -o "$TMP/sdk.tar.gz" "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$SDK/wasi-sdk-$SDK.0-$S-linux.tar.gz"
curl -fsSL -o "$TMP/binaryen.tar.gz" "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN/binaryen-version_$BINARYEN-$ARCH-linux.tar.gz"
echo "$MPSUM  $TMP/mp.tar.xz" | sha256sum -c -
echo "$SSUM  $TMP/sdk.tar.gz" | sha256sum -c -
echo "$BSUM  $TMP/binaryen.tar.gz" | sha256sum -c -
mkdir -p "$DEST/micropython" "$DEST/wasi-sdk" "$DEST/binaryen"
tar --no-same-owner -xJf "$TMP/mp.tar.xz" -C "$DEST/micropython" --strip-components=1
tar --no-same-owner -xzf "$TMP/sdk.tar.gz" -C "$DEST/wasi-sdk" --strip-components=1
tar --no-same-owner -xzf "$TMP/binaryen.tar.gz" -C "$DEST/binaryen" --strip-components=1
