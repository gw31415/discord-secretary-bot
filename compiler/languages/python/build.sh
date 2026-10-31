#!/bin/sh
# MicroPython: each .py is compiled to bytecode (.mpy) by mpy-cross, and the
# .mpy files are linked into the MicroPython runtime that prewarm.sh built
# (/toolchain/mp/libmicropython.a, see sdk/port). The linked module goes
# through binaryen's --spill-pointers so the GC can see every live object
# (sdk/port/main.c). Runs in the box: sources in /work/src, writes
# /work/out/module.wasm. Every file is compiled even after one fails, so all
# the errors come back at once.
set -eu
cd /work/src
case "${OPTIMIZE:-size}" in speed) OPT=-O2 ;; *) OPT=-Oz ;; esac
SDK=/toolchain/wasi-sdk
mkdir -p /work/mpy /work/out
failed=0
set --
for f in $(find . -type f -name '*.py' | sed 's|^\./||' | sort); do
  m=/work/mpy/${f%.py}.mpy
  mkdir -p "$(dirname "$m")"
  # "  File "main.py", line 3" + "SyntaxError: invalid syntax" -> "main.py:3:1: error: SyntaxError: invalid syntax"
  if ! /toolchain/bin/mpy-cross -s "$f" -o "$m" "$f" 2> /work/mpy-cross.log; then
    failed=1
    awk '/^  File "/ { split($0, a, "\""); file = a[2]; line = $NF; next }
         file != "" && !/^ / { print file ":" line ":1: error: " $0; file = "" }' /work/mpy-cross.log
  fi
  set -- "$@" "${f%.py}.mpy=$m"
done
[ "$failed" = 0 ] || exit 1
if [ ! -f secretary.py ]; then
  /toolchain/bin/mpy-cross -s secretary.py -o /work/mpy/secretary.mpy /lang/sdk/secretary.py
  set -- "$@" "secretary.mpy=/work/mpy/secretary.mpy"
fi
python3 /lang/sdk/files.py /work/files.c /work/src /toolchain/stdlib "$@"
$SDK/bin/clang --target=wasm32-wasip1 -Oz -c /work/files.c -o /work/files.o
$SDK/bin/clang --target=wasm32-wasip1 /work/files.o /toolchain/mp/libmicropython.a -lsetjmp \
  -Wl,-z,stack-size=1048576 -Wl,--gc-sections -o /work/linked.wasm
/toolchain/binaryen/bin/wasm-opt /work/linked.wasm --spill-pointers $OPT \
  --strip-debug --strip-target-features -o /work/out/module.wasm
