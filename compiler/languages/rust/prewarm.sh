#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds the
# vendored libraries for both profiles, so a build compiles only the person's crate.
set -eu
. /lang/env.sh
mkdir -p /work/src/src
cd /work/src
cp /lang/template/Cargo.toml Cargo.toml
cp /toolchain/Cargo.lock Cargo.lock
cp /lang/sdk/secretary.rs src/secretary.rs
cat > src/main.rs <<'RS'
mod secretary;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Out {
    reply: String,
}

fn main() {
    let input = secretary::input();
    secretary::output(serde_json::to_value(Out { reply: input["guild"].to_string() }).unwrap());
}
RS
for profile in release speed; do
  cargo build --profile "$profile" --target wasm32-wasip1 --offline --locked --target-dir /work/target
done
mkdir -p /toolchain/prewarm
cp -a /work/target /toolchain/prewarm/target
echo "prewarm: $(du -sh /toolchain/prewarm/target | cut -f1)"
