#!/bin/sh
# Builds js-runner.wasm: QuickJS-ng and runner.c for WASI preview 1.
# Needs curl, unzip and network access; the result is committed, so the bot
# itself never builds it. Usage: ./build.sh  (writes ../../src/wasm/js-runner.wasm)
set -eu
cd "$(dirname "$0")"
QJS=v0.10.1
QJS_SHA=$(cat quickjs-amalgam.sha256)
SDK=25
WORK=${WORK:-.build}
mkdir -p "$WORK"
if [ ! -d "$WORK/wasi-sdk" ]; then
  curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$SDK/wasi-sdk-$SDK.0-x86_64-linux.tar.gz" | tar xz -C "$WORK"
  mv "$WORK/wasi-sdk-$SDK.0-x86_64-linux" "$WORK/wasi-sdk"
fi
if [ ! -f "$WORK/quickjs/quickjs-amalgam.c" ]; then
  curl -fsSL -o "$WORK/quickjs-amalgam.zip" "https://github.com/quickjs-ng/quickjs/releases/download/$QJS/quickjs-amalgam.zip"
  echo "$QJS_SHA  $WORK/quickjs-amalgam.zip" | sha256sum -c -
  mkdir -p "$WORK/quickjs" && unzip -o -q "$WORK/quickjs-amalgam.zip" -d "$WORK/quickjs"
fi
"$WORK/wasi-sdk/bin/clang" --target=wasm32-wasip1 -O2 -flto \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -I "$WORK/quickjs" runner.c "$WORK/quickjs/quickjs-amalgam.c" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -Wl,-z,stack-size=1048576 -Wl,--max-memory=67108864 -Wl,--strip-all \
  -o ../../src/wasm/js-runner.wasm
echo "built $(wc -c < ../../src/wasm/js-runner.wasm) bytes"
