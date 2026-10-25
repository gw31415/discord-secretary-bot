#!/bin/sh
# Runs once in the box after setup (no network): checks that a build works. Nim
# keeps nothing between builds, so there is nothing to cache.
set -eu
mkdir -p /work/src
cp /lang/tests/ok/main.nim /work/src/main.nim
/bin/sh /lang/build.sh
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes"
