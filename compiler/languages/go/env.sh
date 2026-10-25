# Shared by build.sh and prewarm.sh: TinyGo for wasip1, offline, nothing from the network or the environment.
export GOROOT=/toolchain/go GOPATH=/work/.gopath GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOTELEMETRY=off GOENV=off GOFLAGS=-mod=mod
export XDG_CACHE_HOME=/work/.cache GOCACHE=/work/.cache/go
