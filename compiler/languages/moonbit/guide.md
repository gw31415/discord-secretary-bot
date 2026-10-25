# MoonBit でモジュールを書く

MoonBit(`--target wasm`)です。`main.mbt` の `fn main` が入口で、同じパッケージに `.mbt` ファイルを足せます(サブパッケージ・moon.mod・moon.pkg は書けません)。使えるのは core(`moonbitlang/core`)と SDK(`@secretary`)だけで、core のパッケージは `@json`・`@strconv` のように名前を書けば自動で import されます。

- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません。メモリは64MiBまで
- できるモジュールは100KB前後と小さめです

## SDK

```moonbit
@secretary.input() -> Json                       // guild, actor, eventName, event, batch, params, state
@secretary.call(request : Json) -> Json raise    // {"fn": ...} を送り value を返す
@secretary.get(route : String) -> Json raise     // Discord REST の GET(作成者が読める範囲)
@secretary.output(result : Json) -> Unit         // 標準出力に { steps, state?, reply? }
```

Json は `{ "k": Json(v) }` のリテラルで作り、`match` で取り出します。`call`・`get` は失敗すると `Failure` を投げるので、`try ... catch { e => ... }` で受けてください(`fn main` は失敗を投げられません)。

## 例: コマンドに返事をする

```moonbit
///|
fn main {
  let input = @secretary.input()
  let guild_id = match input {
    { "guild": String(g), .. } => g
    _ => ""
  }
  let guild = try @secretary.get("/guilds/\{guild_id}") catch {
    _ => Json::null()
  }
  let name = match guild {
    { "name": String(n), .. } => n
    _ => "このサーバー"
  }
  @secretary.output({ "reply": Json("ここは \{name} です"), "steps": [] })
}
```

## 例: メッセージを投稿する

```moonbit
///|
fn main {
  let channel = match @secretary.input() {
    { "event": { "channel_id": String(c), .. }, .. } => c
    _ => return
  }
  @secretary.output({
    "steps": [
      {
        "op": "POST /channels/{channel}/messages",
        "path": { "channel": Json(channel) },
        "body": { "content": "こんにちは" },
      },
    ],
  })
}
```
