#!/bin/sh
# Rust (wasm32-wasip1). Runs in the box: sources in /work/src, writes /work/out/module.wasm.
# Cargo.toml and Cargo.lock come from the language, never from the request.
set -eu
. /lang/env.sh
cd /work/src
cp /lang/template/Cargo.toml Cargo.toml
cp /toolchain/Cargo.lock Cargo.lock
[ -e src/secretary.rs ] || cp /lang/sdk/secretary.rs src/secretary.rs
cp -a /toolchain/prewarm/target /work/target
case "${OPTIMIZE:-size}" in speed) PROFILE=speed ;; *) PROFILE=release ;; esac
cargo build --profile "$PROFILE" --target wasm32-wasip1 --offline --locked --message-format=short --target-dir /work/target
cp "/work/target/wasm32-wasip1/$PROFILE/module.wasm" /work/out/module.wasm
