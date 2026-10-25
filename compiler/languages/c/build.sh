#!/bin/sh
# C/C++ with wasi-sdk. Runs in the box: sources in /work/src, writes /work/out/module.wasm.
# Every file is compiled even after one fails, so all the errors come back at once.
set -eu
cd /work/src
case "${OPTIMIZE:-size}" in speed) OPT=-O2 ;; *) OPT=-Oz ;; esac
FLAGS="--target=wasm32-wasip1 $OPT -fno-exceptions -fdiagnostics-color=never -Wall -I/lang/sdk -I/toolchain/cjson"
mkdir -p /work/obj
link=clang
failed=0
n=0
for f in $(find . -type f \( -name '*.c' -o -name '*.cc' -o -name '*.cpp' \) | sed 's|^\./||' | sort); do
  n=$((n + 1))
  case "$f" in
    *.c) clang $FLAGS -std=c17 -c "$f" -o "/work/obj/$n.o" || failed=1 ;;
    *) clang++ $FLAGS -std=c++20 -c "$f" -o "/work/obj/$n.o" || failed=1; link=clang++ ;;
  esac
done
[ "$failed" = 0 ] || exit 1
clang $FLAGS -std=c17 -c /lang/sdk/secretary.c -o /work/obj/secretary.o
clang $FLAGS -std=c17 -w -c /toolchain/cjson/cJSON.c -o /work/obj/cjson.o
$link --target=wasm32-wasip1 $OPT /work/obj/*.o -Wl,-z,stack-size=1048576 -Wl,--strip-all -o /work/out/module.wasm
