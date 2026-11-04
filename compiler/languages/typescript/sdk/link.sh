#!/bin/sh
# scriptc's linker (SCRIPTC_LINKER). scriptc 0.4.7 leaves the runtime object
# that defines scr_dyn_adopt_shared out of library links, so a cast from
# unknown to an object type fails to link; add it back. wasm-ld drops it again
# when nothing uses it.
exec zig cc "$@" /toolchain/scriptc/runtime/artifacts/release/runtime/default/scr_decl_adopt.o
