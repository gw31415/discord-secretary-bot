# Shared by build.sh and prewarm.sh: Zig's caches live in the job, and it draws no progress bars.
export ZIG_GLOBAL_CACHE_DIR=/work/.zig-cache ZIG_LOCAL_CACHE_DIR=/work/.zig-cache-local NO_COLOR=1 ZIG_PROGRESS=
