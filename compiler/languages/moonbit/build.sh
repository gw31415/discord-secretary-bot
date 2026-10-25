#!/bin/sh
# MoonBit (--target wasm, a WASI command). Runs in the box: sources in /work/src,
# writes /work/out/module.wasm. moon.mod and moon.pkg come from the language,
# never from the request; the root package imports the SDK and every core
# package the sources name as @alias.
set -eu
. /lang/env.sh
cd /work/src
cp /lang/template/moon.mod moon.mod
mkdir -p secretary /work/out
cp /lang/sdk/secretary.mbt /lang/sdk/moon.pkg secretary/
{
  echo 'import {'
  echo '  "bot/main/secretary",'
  grep -ohE '@[a-z_][a-z0-9_]*' ./*.mbt | sort -u | cut -c2- | while read -r alias; do
    awk -v a="$alias" '$1 == a { print "  \"moonbitlang/core/" $2 "\"," }' /toolchain/core-packages.txt
  done
  echo '}'
  echo
  echo 'pkgtype(kind: "executable")'
} > moon.pkg
status=0
moon build --target wasm --release --no-render --target-dir /work/_build > /work/moon.log 2>&1 || status=$?
# "/work/src/main.mbt:2:17-2:20 [E4014] msg" -> "main.mbt:2:17: error: [E4014] msg"
sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' \
  -e 's#^ *\(/work/src/\)\{0,1\}\([A-Za-z0-9_/]*\.mbt\):\([0-9]*\):\([0-9]*\)-[0-9:]* \[\(E[0-9]*\)\] Warning \(.*\)$#\2:\3:\4: warning: [\5] \6#' \
  -e 's#^ *\(/work/src/\)\{0,1\}\([A-Za-z0-9_/]*\.mbt\):\([0-9]*\):\([0-9]*\)-[0-9:]* \[\(E[0-9]*\)\] \(Error: \)\{0,1\}\(.*\)$#\2:\3:\4: error: [\5] \7#' \
  /work/moon.log | grep -v '^\[[-= ]*\] [0-9]' || true
[ "$status" -eq 0 ] || exit "$status"
cp /work/_build/wasm/release/build/main.wasm /work/out/module.wasm
