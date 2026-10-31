#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds
# mpy-cross for the host, MicroPython for wasm32-wasip1 (sdk/port) into
# /toolchain/mp and micropython-lib's modules into /toolchain/stdlib, then
# builds a sample.
set -eu
MP=/toolchain/micropython
python3 /lang/sdk/port/patches.py "$MP"
make -j2 -C "$MP/mpy-cross" BUILD=/toolchain/mp/mpy-cross > /work/mpy-cross.log 2>&1 || { tail -30 /work/mpy-cross.log; exit 1; }
mkdir -p /toolchain/bin
cp /toolchain/mp/mpy-cross/mpy-cross /toolchain/bin/mpy-cross
python3 /lang/sdk/stdlib.py /toolchain/micropython-lib /toolchain/bin/mpy-cross /toolchain/stdlib
make -j2 -C /lang/sdk/port TOP="$MP" BUILD=/toolchain/mp/build WASI_SDK=/toolchain/wasi-sdk > /work/port.log 2>&1 || { tail -30 /work/port.log; exit 1; }
cp /toolchain/mp/build/libmicropython.a /toolchain/mp/libmicropython.a
rm -rf /toolchain/mp/build /toolchain/mp/mpy-cross
echo "prewarm: libmicropython.a $(wc -c < /toolchain/mp/libmicropython.a) bytes"
mkdir -p /work/src
cp /lang/tests/ok/*.py /work/src/
/bin/sh /lang/build.sh
echo "prewarm: $(wc -c < /work/out/module.wasm) bytes"
