#!/bin/sh
# Fetches scriptc (Vercel Labs' TypeScript-to-native compiler: its native CLI,
# its LLVM code generator and the wasm32-wasi runtime pack, straight from the
# npm registry), Zig 0.16 (scriptc links with `zig cc`) and binaryen (wasm-merge,
# wasm-metadce, wasm-opt; see build.sh) into $DEST (mounted at /toolchain in the
# box). Runs on the host, with network. No npm and no install scripts: the
# tarballs are checked and unpacked, and the CLI's toolchain manifest is
# written here.
set -eu
: "${DEST:?}" "${ARCH:?}"
SC=0.4.7
ZIG=0.16.0
BINARYEN=133
RSUM=c049643da0af1eb2c87ed5145eef06dca82b5fc2c96e4bc85a92341be0fa6031
case "$ARCH" in
  aarch64) P=linux-arm64-gnu; CSUM=f9c610fc941439990b33aadf7ec16a0deec640985af9b2e8ce24bda8a4fc2e24; LSUM=270729ab5ae344bcc9d7799c858430a1cb51e6610a01ec82dd0cadfd4097f754
    ZSUM=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17; BSUM=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8 ;;
  x86_64) P=linux-x64-gnu; CSUM=af14df287fc453e18d46f19beaa209f6e14a30cc1f8b38ded9ee3ec593c53339; LSUM=5f685532ea6ac7d863a2af24780ad9863f6c308f176b462d84863d1dfb3c8746
    ZSUM=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00; BSUM=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch() { # name url sum
  curl -fsSL -o "$TMP/$1" "$2"
  echo "$3  $TMP/$1" | sha256sum -c -
}
fetch cli.tgz "https://registry.npmjs.org/@scriptc/cli-$P/-/cli-$P-$SC.tgz" "$CSUM"
fetch llvm.tgz "https://registry.npmjs.org/@scriptc/llvm-$P/-/llvm-$P-$SC.tgz" "$LSUM"
fetch runtime.tgz "https://registry.npmjs.org/@scriptc/runtime-wasm32-wasi/-/runtime-wasm32-wasi-$SC.tgz" "$RSUM"
fetch zig.tar.xz "https://ziglang.org/download/$ZIG/zig-$ARCH-linux-$ZIG.tar.xz" "$ZSUM"
fetch binaryen.tar.gz "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN/binaryen-version_$BINARYEN-$ARCH-linux.tar.gz" "$BSUM"
mkdir -p "$DEST/scriptc/cli" "$DEST/scriptc/llvm" "$DEST/scriptc/runtime" "$DEST/zig" "$DEST/binaryen/bin" "$DEST/bin" "$TMP/binaryen"
tar --no-same-owner -xzf "$TMP/cli.tgz" -C "$DEST/scriptc/cli" --strip-components=1
tar --no-same-owner -xzf "$TMP/llvm.tgz" -C "$DEST/scriptc/llvm" --strip-components=1
tar --no-same-owner -xzf "$TMP/runtime.tgz" -C "$DEST/scriptc/runtime" --strip-components=1
tar --no-same-owner -xJf "$TMP/zig.tar.xz" -C "$DEST/zig" --strip-components=1
tar --no-same-owner -xzf "$TMP/binaryen.tar.gz" -C "$TMP/binaryen" --strip-components=1
# The release binaries are static; only these three are used.
cp "$TMP/binaryen/bin/wasm-merge" "$TMP/binaryen/bin/wasm-metadce" "$TMP/binaryen/bin/wasm-opt" "$DEST/binaryen/bin/"
# What scriptc's npm postinstall would do: point the CLI at its LLVM helper and
# runtime pack, and make the tools it launches executable.
BIN="$DEST/scriptc/cli/dist/bin"
cat > "$BIN/scriptc.json" <<JSON
{
  "schema": "scriptc.native-toolchain.v1",
  "compiler_version": "$SC",
  "target": "$P",
  "ts7": "../lib/typescript/lib/tsc",
  "tsc_ts": "../lib/tsc-ts/lib/tsc-ts",
  "runtime_sources": "../lib/runtime-sources",
  "declarations": "../lib/declarations",
  "wasi_node_runner": "../lib/wasi/cli/wasi-runner.js",
  "linker": "clang",
  "linker_args": [],
  "dsymutil": "dsymutil",
  "comptime": "../lib/scriptc-comptime",
  "lib_diagnostics": "../lib/declarations/lib-diagnostics.json",
  "llvm_package": "../../../llvm",
  "runtime_pack": "../../../runtime",
  "runtime_packs": [{ "target": "wasm32-wasi", "path": "../../../runtime" }]
}
JSON
chmod 755 "$BIN/scriptc" "$DEST/scriptc/cli/dist/lib/typescript/lib/tsc" "$DEST/scriptc/cli/dist/lib/tsc-ts/lib/tsc-ts" \
  "$DEST/scriptc/cli/dist/lib/scriptc-comptime" "$DEST/scriptc/llvm/bin/scriptc-llvm-codegen"
ln -s ../scriptc/cli/dist/bin/scriptc "$DEST/bin/scriptc"
ln -s ../zig/zig "$DEST/bin/zig"
