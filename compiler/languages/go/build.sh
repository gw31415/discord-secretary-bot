#!/bin/sh
# Go (GOOS=wasip1). Runs in the box: sources in /work/src, writes /work/out/module.wasm.
set -eu
cd /work/src
cp /lang/template/go.mod go.mod
mkdir -p secretary
[ -e secretary/secretary.go ] || cp /lang/sdk/secretary.go secretary/secretary.go
cp -a /toolchain/prewarm/gocache /work/.gocache
export GOCACHE=/work/.gocache
. /lang/env.sh
go build -trimpath -buildvcs=false -ldflags="-s -w" -o /work/out/module.wasm .
