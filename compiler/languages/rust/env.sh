# Shared by build.sh and prewarm.sh: cargo offline, with the vendored libraries only.
export CARGO_HOME=/work/.cargo RUSTC=/toolchain/bin/rustc CARGO_INCREMENTAL=0
mkdir -p "$CARGO_HOME"
cp /toolchain/cargo-config.toml "$CARGO_HOME/config.toml"
