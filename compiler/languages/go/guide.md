# Go でモジュールを書く

Go 1.25 の `GOOS=wasip1 GOARCH=wasm` です。モジュール名は `bot` で、`main.go`(package main)が入口です。サブパッケージは `bot/<dir>` で import できます。go.mod は書けず、使えるのは標準ライブラリと SDK(`bot/secretary`)だけです。cgo・go generate は動きません。

- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません。メモリは64MiBまで
- できるモジュールは2〜3MBと大きめです(上限8MB)

## SDK

```go
secretary.Input(v any) error                 // guild, actor, eventName, event, batch, params, state を v に
secretary.Call(request any, out any) error   // {"fn": ...} を送り value を out に
secretary.Get(route string, out any) error   // Discord REST の GET(作成者が読める範囲)
secretary.Output(result any) error           // 標準出力に { steps, state?, reply? }
```

## 例: コマンドに返事をする

```go
package main

import (
	"fmt"
	"os"

	"bot/secretary"
)

func main() {
	var in struct {
		Guild string `json:"guild"`
	}
	if err := secretary.Input(&in); err != nil {
		fmt.Fprintln(os.Stderr, "bad input:", err)
		os.Exit(1)
	}
	var guild struct {
		Name string `json:"name"`
	}
	if err := secretary.Get("/guilds/"+in.Guild, &guild); err != nil {
		fmt.Fprintln(os.Stderr, "get failed:", err)
		os.Exit(1)
	}
	secretary.Output(map[string]any{"reply": "ここは " + guild.Name + " です", "steps": []any{}})
}
```
