#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): bundles the
# core library for the wasm target, lists its packages for build.sh, and builds a sample.
set -eu
. /lang/env.sh
moon -C /toolchain/lib/core bundle --target wasm --warn-list -a
# "alias path" for every core package; the shortest path wins an alias.
(cd /toolchain/lib/core && find . -name 'moon.pkg*' -not -path './_build/*' -not -path '*/internal/*' \
  | sed -e 's#^\./##' -e 's#/moon\.pkg.*$##' \
  | awk -F/ '{ print length($0), $NF, $0 }' | sort -n | awk '!seen[$2]++ { print $2, $3 }') > /toolchain/core-packages.txt
echo "prewarm: $(wc -l < /toolchain/core-packages.txt) core packages"
mkdir -p /work/src
cp /lang/tests/ok/main.mbt /work/src/main.mbt
/bin/sh /lang/build.sh
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes"
