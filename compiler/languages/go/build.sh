#!/bin/sh
# Go with TinyGo (-target=wasip1). Runs in the box: sources in /work/src, writes /work/out/module.wasm.
set -eu
cd /work/src
cp /lang/template/go.mod go.mod
mkdir -p secretary
[ -e secretary/secretary.go ] || cp /lang/sdk/secretary.go secretary/secretary.go
. /lang/env.sh
mkdir -p "$XDG_CACHE_HOME"
cp -a /toolchain/prewarm/cache/. "$XDG_CACHE_HOME/"
case "${OPTIMIZE:-size}" in speed) OPT=2 ;; *) OPT=z ;; esac
tinygo build -target=wasip1 -opt=$OPT -no-debug -o /work/out/module.wasm .
