#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds the
# sample in both modes so Zig's wasm32-wasi libc and compiler_rt (about 17
# seconds of work) are in a cache that every build starts from.
set -eu
. /lang/env.sh
mkdir -p /work/src /toolchain/prewarm/zig
cp /lang/tests/ok/*.ts /work/src/
for opt in size speed; do OPTIMIZE=$opt /bin/sh /lang/build.sh; done
cp -a "$ZIG_GLOBAL_CACHE_DIR/." /toolchain/prewarm/zig/
chmod -R a+rX /toolchain/prewarm
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes, cache $(du -sh /toolchain/prewarm/zig | cut -f1)"
