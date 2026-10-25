#!/bin/sh
# Runs once in the box after setup (no network, /toolchain writable): builds the
# standard library for wasip1 into a cache that every build starts from.
set -eu
mkdir -p /work/src/secretary
cd /work/src
cp /lang/template/go.mod go.mod
cp /lang/sdk/secretary.go secretary/secretary.go
cat > main.go <<'GO'
package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"bot/secretary"
)

func main() {
	var in map[string]any
	_ = secretary.Input(&in)
	keys := []string{}
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	b, _ := json.Marshal(keys)
	secretary.Output(map[string]any{"reply": fmt.Sprint(strings.ToUpper(string(b)))})
}
GO
export GOCACHE=/toolchain/prewarm/gocache
. /lang/env.sh
go build -trimpath -buildvcs=false -ldflags="-s -w" -o /work/prewarm.wasm .
echo "prewarm: $(wc -c < /work/prewarm.wasm) bytes"
