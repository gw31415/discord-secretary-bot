# Wasmモジュール

ルール(イベント・時刻・ギルドコマンド)のコードは、JavaScript の代わりに自分でビルドした Wasm モジュールにできます。JavaScript も内部では同じ扱いで、QuickJS を WASI 向けにビルドした `src/wasm/js-runner.wasm` に、ルールのコード(のバイトコード)を標準入力の先頭で渡して動かします。入出力(下の ABI)も同じです。どちらも同じサンドボックスで動き、出力は Plan として同じ関門(スキーマ検証 → 権限評価 → 実行器)を通るので、モジュールが何をしてもルールの allow と作成者の権限を超えられません。

## 使い方

1. WASI preview 1 のコマンド(`_start` を持つ普通のプログラム)としてビルドする
2. Botにメンションして `.wasm` を添付し、何に使いたいかを相談する。Botが登録して(名前は既定でファイル名)、ルールやコマンドにする案を出す。`/settings` の「Wasm」から登録だけしておくこともでき、一覧・名前の変更・削除もそこでする
3. 会話で「greeter を /hello コマンドにして」のように頼むと、ルールとして確認画面が出る

登録せずに一度だけ動かすこともできます。`.wasm` を添付して「これを動かして」と頼むと、Botが `run_wasm` で頼んだ人の読み取り範囲だけで1回実行し、標準出力・ログ・画像を見せます。標準入力はルールと同じJSON(`event` には Botが渡す値が入り、ほかは null)か、Botが渡す文字列そのものです。出力の `steps` は実行されず、Botが変更案として確認ダイアログに出し、本人が承認したときだけ実行されます。

ルールは登録したビルド(sha256)に固定されます。同じ名前で新しいビルドを上げても、差し替えを頼んで承認するまで古いビルドのまま動きます。同じサーバーの人が上げたモジュールも sha256(12文字以上)で指定すれば使えます。そのときも実行はルールの作成者の権限です。

## ABI

**入力**: 標準入力に JSON が1つ。

```json
{ "guild": "…", "actor": { "kind": "user", "userId": "…" }, "eventName": "COMMAND",
  "event": { … }, "batch": [ … ], "params": { … }, "state": null }
```

**出力**: 標準出力に JSON が1つ。何もしないときは空か `{}`。

```json
{ "steps": [ { "op": "POST /channels/{channel}/messages", "path": { "channel": "…" }, "body": { "content": "…" } } ],
  "state": { … }, "reply": "コマンドへの返事" }
```

- `steps` は JS の `call(op, { id, path, body })` と同じ形です。`$ref` で前のステップの結果を参照できます。
- `state` を書くと次の実行の入力に入ります(実行が通ったときだけ保存)。
- `reply` はコマンドのときだけ使えます(コマンドの返事になります)。
- 標準エラー出力は実行履歴のログになります。終了コードが 0 以外なら失敗です。

**ホスト関数**: import `secretary.call(req_ptr, req_len, resp_ptr, resp_cap) -> i32` だけです。要求も応答も JSON で、応答は `{ "value": … }` か `{ "error": "…" }` です。応答がバッファに入りきらないときは必要な長さを負数で返すので、同じ要求で取り直します(二重には実行されません)。

| fn | 引数 | 返り値 |
|---|---|---|
| `get` | `route`, `query?` | Discord REST の GET の結果(作成者が読める範囲だけ) |
| `judge` | `state`, `questions` | 作成者の判定モデルの答え(JS の `judge` と同じ) |
| `rank` | `items`, `instructions`, `levels?` | `[{ item, score }]` を高い順に |
| `renderMath` | `tex`, `options?`, `name?` | 画像ID(`img1` など) |
| `convertImage` | `source`, `options?`, `name?` | 画像ID |
| `image` | `data`(PNG・JPEG・GIF・WebP の Base64), `name?` | 画像ID |

画像IDは投稿の `body.files` に入れるか、コマンドでは返事に添付されます。

WASI は標準入出力・引数・時計・乱数・終了だけが動き、ファイルやソケットはすべて「ない」と答えます。

## 制限

| 項目 | 上限 |
|---|---|
| 大きさ | 1個 8MB、一人20個・合計50MB |
| メモリ | 64MiB(登録時にメモリの最大値を書き換えて強制) |
| 実行時間 | 1回30秒(順番待ちを含む)。超えるとスレッドごと止める |
| 同時実行 | Bot全体で4つまで。ほかは順番を待つ |
| `get` | 1回の実行で200回 |
| 画像 | 1回の実行で4枚 |
| 出力 | 標準出力 4MB、ログ 100行 |

import は `wasi_snapshot_preview1` の関数と `secretary.call` だけ、共有メモリ・memory64・コンポーネントは使えません。

## 例

- [examples/wasm/go](../examples/wasm/go): `GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .`
- [examples/wasm/rust](../examples/wasm/rust): `cargo build --release --target wasm32-wasip1`

## JS エンジンのビルド

`wasm/js-runner/build.sh` が wasi-sdk と QuickJS-ng を取ってきて `src/wasm/js-runner.wasm` を作ります。結果はリポジトリに入れてあるので、Bot の起動や配布にビルドは要りません。ルールのコードは初回(または起動時)に QuickJS のバイトコードへコンパイルして DB に保存し、以後はそれを読み込んで動かします。
