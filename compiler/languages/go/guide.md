# Go でモジュールを書く

TinyGo 0.43(Go 1.25)の `-target=wasip1` です。モジュール名は `bot` で、`main.go`(package main)が入口です。サブパッケージは `bot/<dir>` で import できます。go.mod は書けず、使えるのは標準ライブラリと SDK(`bot/secretary`)だけです。cgo・go generate は動きません。標準ライブラリは TinyGo が対応している範囲で使えます(`reflect` の一部、`encoding/json` は動きます。goroutine は動きますが並列にはなりません)。

- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません。メモリは64MiBまで
- できるモジュールは数百KBです

## SDK

```go
secretary.Input(v any) error                 // guild, actor, eventName, event, batch, params, state を v に
secretary.Call(request any, out any) error   // {"fn": ...} を送り value を out に
secretary.Get(route string, out any) error   // Discord REST の GET(作成者が読める範囲)
secretary.GetQuery(route string, query map[string]any, out any) error  // クエリつきの GET
secretary.Output(result any) error           // 標準出力に { steps, state?, reply? }
```

`limit` などのクエリは `secretary.GetQuery("/channels/"+id+"/messages", map[string]any{"limit": 1}, &msgs)` のように渡します(route に `?limit=1` と書いても同じに扱います)。読めるルートと使えるクエリは docs の「読めるルート」を見てください。

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
