#!/bin/sh
# Nim, compiled to C and then by wasi-sdk's clang (LLVM) to wasm32-wasip1. Runs in
# the box: sources in /work/src, writes /work/out/module.wasm. The flags are fixed;
# only .nim files come from the request, so no nim.cfg or config.nims can change them.
set -eu
cd /work/src
case "${OPTIMIZE:-size}" in speed) OPT=speed ;; *) OPT=size ;; esac
CC=/toolchain/wasi-sdk/bin/clang
status=0
nim c --hints:off --colors:off --skipUserCfg --skipParentCfg --skipProjCfg \
  --os:linux --cpu:wasm32 --cc:clang --clang.exe:$CC --clang.linkerexe:$CC \
  --passC:--target=wasm32-wasip1 --passL:--target=wasm32-wasip1 \
  --passC:-D_WASI_EMULATED_SIGNAL --passL:-lwasi-emulated-signal --passC:-I/lang/sdk \
  --passL:-Wl,-z,stack-size=1048576 --passL:-Wl,--strip-all \
  -d:release --opt:$OPT --mm:orc --threads:off --exceptions:goto -d:noSignalHandler -d:useMalloc --noMain \
  --path:/lang/sdk --nimcache:/work/.nimcache -o:/work/out/module.wasm main.nim > /work/nim.log 2>&1 || status=$?
# "/work/src/main.nim(3, 15) Error: msg" -> "main.nim:3:15: error: msg"
sed -e 's#^/work/src/##' -e 's#^/lang/sdk/#secretary/#' \
  -e 's#^\([A-Za-z0-9_/.-]*\.nim\)(\([0-9]*\), \([0-9]*\)) Error: #\1:\2:\3: error: #' \
  -e 's#^\([A-Za-z0-9_/.-]*\.nim\)(\([0-9]*\), \([0-9]*\)) Warning: #\1:\2:\3: warning: #' /work/nim.log
exit "$status"
