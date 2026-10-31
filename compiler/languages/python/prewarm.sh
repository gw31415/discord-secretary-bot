#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds
# mpy-cross for the host and MicroPython for wasm32-wasip1 (sdk/port) into
# /toolchain/mp, then builds a sample.
set -eu
MP=/toolchain/micropython
# A string grows by what it needs plus 16 bytes, so building a long one piece
# by piece (json.dumps of a large value) copies it over and over. Grow by half
# again instead.
sed -i 's|size_t new_alloc = ROUND_ALLOC((vstr->len + size) + 16);|size_t new_alloc = ROUND_ALLOC((vstr->len + size) + 16 + vstr->len / 2);|' "$MP/py/vstr.c"
grep -q 'vstr->len / 2' "$MP/py/vstr.c"
make -j2 -C "$MP/mpy-cross" BUILD=/toolchain/mp/mpy-cross > /work/mpy-cross.log 2>&1 || { tail -30 /work/mpy-cross.log; exit 1; }
mkdir -p /toolchain/bin
cp /toolchain/mp/mpy-cross/mpy-cross /toolchain/bin/mpy-cross
make -j2 -C /lang/sdk/port TOP="$MP" BUILD=/toolchain/mp/build WASI_SDK=/toolchain/wasi-sdk > /work/port.log 2>&1 || { tail -30 /work/port.log; exit 1; }
cp /toolchain/mp/build/libmicropython.a /toolchain/mp/libmicropython.a
rm -rf /toolchain/mp/build /toolchain/mp/mpy-cross
echo "prewarm: libmicropython.a $(wc -c < /toolchain/mp/libmicropython.a) bytes"
mkdir -p /work/src
cp /lang/tests/ok/*.py /work/src/
/bin/sh /lang/build.sh
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes"
