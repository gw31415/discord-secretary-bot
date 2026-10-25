# Shared by build.sh and prewarm.sh: Go for wasip1, offline, nothing from the network or the environment.
export GOROOT=/toolchain/go GOPATH=/work/.gopath GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOTELEMETRY=off GOENV=off GOFLAGS=-mod=mod
export GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0
