#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds the
# standard library pieces (compiler_rt, libc for wasi) for both modes into a cache
# that every build starts from.
set -eu
mkdir -p /work/src /toolchain/prewarm/cache
cp /lang/tests/ok/main.zig /work/src/main.zig
for opt in size speed; do OPTIMIZE=$opt /bin/sh /lang/build.sh; done
cp -a /work/.zig-cache/. /toolchain/prewarm/cache/
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes, cache $(du -sh /toolchain/prewarm/cache | cut -f1)"
