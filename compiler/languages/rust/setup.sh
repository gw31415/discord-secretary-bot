#!/bin/sh
# Installs Rust with the wasm32-wasip1 target into $DEST (mounted at /toolchain in
# the box) and vendors the libraries the template allows. Runs on the host, with network.
set -eu
: "${DEST:?}" "${ARCH:?}" "${LANG_DIR:?}"
RUST=1.90.0
TRIPLE="$ARCH-unknown-linux-gnu"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/rustup-init" "https://static.rust-lang.org/rustup/dist/$TRIPLE/rustup-init"
SUM=$(curl -fsSL "https://static.rust-lang.org/rustup/dist/$TRIPLE/rustup-init.sha256" | cut -d' ' -f1)
echo "$SUM  $TMP/rustup-init" | sha256sum -c -
chmod +x "$TMP/rustup-init"
export RUSTUP_HOME="$DEST/rustup" CARGO_HOME="$TMP/cargo"
"$TMP/rustup-init" -y --no-modify-path --profile minimal --default-toolchain "$RUST" --target wasm32-wasip1
mkdir -p "$DEST/bin"
for t in cargo rustc; do ln -s "../rustup/toolchains/$RUST-$TRIPLE/bin/$t" "$DEST/bin/$t"; done
mkdir -p "$TMP/project/src"
cp "$LANG_DIR/template/Cargo.toml" "$TMP/project/Cargo.toml"
echo 'fn main() {}' > "$TMP/project/src/main.rs"
(cd "$TMP/project" && "$DEST/bin/cargo" generate-lockfile && "$DEST/bin/cargo" vendor --locked "$DEST/vendor" >/dev/null)
cp "$TMP/project/Cargo.lock" "$DEST/Cargo.lock"
cat > "$DEST/cargo-config.toml" <<'TOML'
[source.crates-io]
replace-with = "vendored"

[source.vendored]
directory = "/toolchain/vendor"

[net]
offline = true

[term]
color = "never"
TOML
