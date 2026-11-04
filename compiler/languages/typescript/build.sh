#!/bin/sh
# TypeScript with scriptc (wasm32-wasi). Runs in the box: sources in /work/src,
# writes /work/out/module.wasm.
# scriptc's WASI executables cannot import host functions, so the program is
# built as a library (a WASI reactor) whose entry imports main.ts: its
# top-level code runs when the module initializes. The reactor imports
# scriptc.secretaryCall, scriptc.secretaryOutput and scriptc.panic, and its
# fd_write is renamed to scriptc.fd_write; sdk/adapter.wat supplies them and
# _start, wasm-merge joins the two, and wasm-metadce keeps only _start and
# memory as exports.
set -eu
. /lang/env.sh
mkdir -p /work/app /work/out "$ZIG_GLOBAL_CACHE_DIR" "$SCRIPTC_CACHE_DIR"
[ ! -d /toolchain/prewarm/zig ] || cp -a /toolchain/prewarm/zig/. "$ZIG_GLOBAL_CACHE_DIR/"
[ -f /work/src/secretary.ts ] || cp /lang/sdk/secretary.ts /work/src/secretary.ts
cp /lang/sdk/entry.ts /lang/sdk/profile.json /work/app/
case "${OPTIMIZE:-size}" in speed) OPT=-O3 ;; *) OPT=-Oz ;; esac
status=0
scriptc build --lib --profile /work/app/profile.json -o /work/app.wasm > /work/scriptc.log 2>&1 || status=$?
# "/work/src/main.ts:9:7 - error SC0001: Type ..." -> "main.ts:9:7: error: SC0001: Type ..."
sed -E -e 's#^/work/src/([^ :]+):([0-9]+):([0-9]+) - (error|warning) (SC[0-9]+): #\1:\2:\3: \4: \5: #' -e 's#/work/src/##g' -e '\#^/work/app.wasm$#d' /work/scriptc.log
[ "$status" = 0 ] || exit "$status"
F="--enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-multivalue"
B=/toolchain/binaryen/bin
python3 /lang/sdk/rename_import.py /work/app.wasm /work/renamed.wasm wasi_snapshot_preview1 fd_write scriptc fd_write
$B/wasm-merge /work/renamed.wasm app /lang/sdk/adapter.wat scriptc $F -o /work/merged.wasm
$B/wasm-metadce /work/merged.wasm --graph-file /lang/sdk/keep.json $F -o /work/kept.wasm > /dev/null
$B/wasm-opt /work/kept.wasm $OPT $F --strip-debug --strip-producers -o /work/out/module.wasm
