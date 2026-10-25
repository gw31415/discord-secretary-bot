#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds
# TinyGo's runtime, wasi-libc and the packages the SDK uses into a cache that
# every build starts from.
set -eu
mkdir -p /work/src
cp /lang/tests/ok/main.go /work/src/main.go
for opt in size speed; do OPTIMIZE=$opt /bin/sh /lang/build.sh; done
mkdir -p /toolchain/prewarm
cp -a /work/.cache /toolchain/prewarm/cache
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes, cache $(du -sh /toolchain/prewarm/cache | cut -f1)"
