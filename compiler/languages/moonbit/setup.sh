#!/bin/sh
# Fetches the MoonBit toolchain and its core library into $DEST (mounted at
# /toolchain in the box, laid out as MOON_HOME). Runs on the host, with network.
# MoonBit only publishes "latest", so the sums pin the build this module was made
# with; when upstream moves on, setup fails here until the sums (and the
# toolchain name in language.json) are updated.
set -eu
: "${DEST:?}" "${ARCH:?}"
BASE=https://cli.moonbitlang.com
CORE_SUM=2d837ecbef5933c09726d63682a7695123d622e6aee13525fbc98c4b49433714
case "$ARCH" in
  aarch64) SUM=05511279ffe36f223b69b734ad7322bf4fb0d7363e4b974159fb1087797f905a ;;
  x86_64) SUM=d0a96eaf91c77cfcdd7b7df75390c5a1a95d0b8a328b1a5ed6fee050cfbf8d50 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/moonbit.tar.gz" "$BASE/binaries/latest/moonbit-linux-$ARCH.tar.gz"
curl -fsSL -o "$TMP/core.tar.gz" "$BASE/cores/core-latest.tar.gz"
echo "$SUM  $TMP/moonbit.tar.gz" | sha256sum -c -
echo "$CORE_SUM  $TMP/core.tar.gz" | sha256sum -c -
tar xzf "$TMP/moonbit.tar.gz" -C "$DEST"
tar xzf "$TMP/core.tar.gz" -C "$DEST/lib"
# The archive's files come without the execute bit (the upstream installer adds it).
chmod -R a+rX "$DEST"
chmod a+x "$DEST"/bin/* "$DEST"/bin/internal/*
