# Nim でモジュールを書く

Nim 2.2 のコードを C にして、wasi-sdk 25 の clang(LLVM)で wasm32-wasip1 のコマンドにします。`main.nim` が入口で、ほかの `.nim` は `import util` で読めます。SDK は `import secretary`(`std/json` も一緒に使えます)。nim.cfg・config.nims は書けず、ビルドの設定は固定です(`--mm:orc`、スレッドなし)。

- 使えるのは標準ライブラリのうち、ファイル・ネットワーク・プロセス・スレッドを使わないもの(strutils・sequtils・tables・json・times など)
- 実行時は標準入出力・時計・乱数だけ。メモリは64MiBまで、スタックは1MiB
- 捕まえなかった例外はエラーとして記録され、実行は失敗します

## SDK

```nim
proc input*(): JsonNode                    # 標準入力の JSON(guild, actor, eventName, event, batch, params, state)
proc call*(request: JsonNode): JsonNode    # %*{"fn": ...} を送り value を返す。失敗は HostError
proc get*(route: string): JsonNode         # Discord REST の GET(作成者が読める範囲)
proc output*(result: JsonNode)             # 標準出力に { steps, state?, reply? }
```

## 例: コマンドに返事をする

```nim
import secretary

let input = secretary.input()
var name = "このサーバー"
try:
  name = secretary.get("/guilds/" & input{"guild"}.getStr){"name"}.getStr(name)
except HostError as e:
  stderr.writeLine("get failed: ", e.msg)
output(%*{"reply": "ここは " & name & " です", "steps": []})
```

## 例: メッセージを投稿する

```nim
import secretary

let channel = secretary.input(){"event", "channel_id"}.getStr
output(%*{"steps": [{
  "op": "POST /channels/{channel}/messages",
  "path": {"channel": channel},
  "body": {"content": "こんにちは"},
}]})
```
