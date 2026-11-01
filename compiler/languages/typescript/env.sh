# Shared by build.sh and prewarm.sh: scriptc and Zig keep their caches in the job.
export SCRIPTC_TARGET=wasm32-wasi SCRIPTC_LINKER=/lang/sdk/link.sh SCRIPTC_CACHE_DIR=/work/.scriptc-cache \
  ZIG_GLOBAL_CACHE_DIR=/work/.zig-cache ZIG_LOCAL_CACHE_DIR=/work/.zig-cache-local NO_COLOR=1 ZIG_PROGRESS=
