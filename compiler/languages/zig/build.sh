#!/bin/sh
# Zig (wasm32-wasi, the default backend). Runs in the box: sources in /work/src, writes /work/out/module.wasm.
# main.zig is the root; the SDK is the module "secretary".
set -eu
cd /work/src
mkdir -p /work/out
. /lang/env.sh
mkdir -p "$ZIG_GLOBAL_CACHE_DIR"
cp -a /toolchain/prewarm/cache/. "$ZIG_GLOBAL_CACHE_DIR/"
case "${OPTIMIZE:-size}" in speed) OPT=ReleaseFast ;; *) OPT=ReleaseSmall ;; esac
status=0
zig build-exe -target wasm32-wasi -O "$OPT" -fstrip --stack 1048576 \
  --dep secretary -Mroot=main.zig -Msecretary=/lang/sdk/secretary.zig \
  -femit-bin=/work/out/module.wasm > /work/zig.log 2>&1 || status=$?
sed -e 's#^/work/src/##' -e 's#^/lang/sdk/#secretary/#' /work/zig.log
exit "$status"
