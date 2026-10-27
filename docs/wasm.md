# Wasm モジュール

ルール(イベント・時刻・ギルドコマンド)のコードは、JavaScript の代わりに Wasm モジュールにできます。自分でビルドしたものを上げるか、ソースを渡してBotにコンパイルさせます([言語と SDK](languages.md))。

JavaScript も内部では同じ扱いです。WASI 向けにビルドした QuickJS(`src/wasm/js-runner.wasm`)に、ルールのコード(のバイトコード)を標準入力の先頭で渡して動かします。どちらも同じサンドボックスで動き、出力は Plan として同じ関門(スキーマ検証、権限評価、実行器)を通ります。モジュールが何をしても、ルールの allow と作成者(コマンドでは実行した人)の権限を超えられません。

## 登録と管理

1. WASI preview 1 のコマンド(`_start` を持つふつうのプログラム)としてビルドします。
2. Botにメンションして `.wasm` を添付し、何に使いたいかを相談します。Botが登録して(名前は既定でファイル名)、ルールやコマンドの案を出します。
3. 会話で「greeter を /hello コマンドにして」のように頼むと、ルールとして確認ダイアログが出ます。

登録しただけでは何も動きません。登録できるのは、本人が添付した `.wasm` だけです。

`/settings` の「Wasm」では次のことができます。登録だけをする(モーダルで `.wasm` を選ぶ)、一覧を見る、名前を変える、削除する、Botがコンパイルしたもののソースを見る。モジュールを開くと、それを使っているルールも出ます。

- 名前は文字・数字・`-`・`_`・`.` の40文字までです。
- 同じ名前で登録すると新しいビルドになります。ルールは登録したビルド(sha256)に固定されるので、差し替えを頼んで承認するまで古いビルドのまま動きます。どのルールも使っていない古いビルドは、新しいビルドを登録したときに消えます。
- ルールが使っているモジュールは消せません。先にルールを消すか、別のモジュールに差し替えます。
- 同じサーバーの人が上げたモジュールも、sha256(12文字以上)で指定すれば使えます。そのときも実行はルールの作成者(コマンドでは実行した人)の権限です。

## 一度だけ動かす(run_wasm)

登録せずに一度だけ動かすこともできます。`.wasm` を添付して「これを動かして」と頼むと、Botが `run_wasm` で1回実行し、標準出力・ログ・画像を見せます。

- 動かせるのは、メッセージに添付された `.wasm`(だれの添付でもよい)、登録済みのモジュール(自分のは名前、同じサーバーの人のは sha256)、`compile_wasm` で作ったばかりのモジュールです。
- 読み取りは頼んだ人の会話と同じ範囲(チャンネルを見られる全員が読めるもの)です。
- 標準入力はルールと同じ形の JSON(`event` にBotが渡す値が入り、`eventName`・`batch`・`params`・`state` は `null`)か、Botが渡す文字列そのものです。
- 出力の `steps` は実行しません。Botが変更案として確認ダイアログに出し、本人が承認したときだけ実行します。

ルールやコードの中から動かすときは `runWasm` を使います([JavaScript の API](js-api.md#wasm-を動かすrunwasm))。

## ABI

ABI の名前は `secretary/1` です。

### モジュールの形

- コアの Wasm モジュール(バージョン1)で、`_start` 関数と `memory` を export します。コンポーネントは使えません。
- import できるのは `wasi_snapshot_preview1` の関数と `secretary.call` だけです。
- メモリは1つだけです。共有メモリ(スレッド)と memory64 は使えません。
- メモリの最大値は登録のときに64MiB(1024ページ)に書き換えます。初期サイズが64MiB を超えるものは登録できません。ほかのバイトはそのまま残します。
- 1個8MB までです。

### 入力

標準入力に JSON が1つ来ます。

```json
{ "guild": "…", "actor": { "kind": "user", "userId": "…", "via": "rule" },
  "eventName": "COMMAND", "event": { … }, "batch": [ … ], "params": { … }, "state": null }
```

| 項目 | 中身 |
|---|---|
| `guild` | サーバーID |
| `actor` | だれの権限で動くか(ルールでは作成者、コマンドでは実行した人) |
| `eventName` | どのきっかけで動いたか([きっかけの一覧](rules.md#きっかけの一覧)) |
| `event` | 発火したイベント。まとめて動いたときは最後のもの |
| `batch` | この回のイベント `[{ eventName, event }]`、古い順 |
| `params` | ルールの `params` |
| `state` | 前回保存した値。最初は `null` |

### 出力

標準出力に JSON を1つ書きます。何もしないときは、空・`{}`・`null` のどれかです。

```json
{ "steps": [ { "op": "POST /channels/{channel}/messages", "path": { "channel": "…" }, "body": { "content": "…" } } ],
  "state": { … }, "reply": "コマンドへの返事", "response": { "type": 9, "data": { … } },
  "later": [ { "seconds": 600, "data": { … } } ] }
```

| 項目 | 中身 |
|---|---|
| `steps` | 変更のステップ。各要素は `{ id?, op, path?, query?, body? }` で、JavaScript の `call()` と同じ形。`$ref` で前のステップの結果を指せる |
| `state` | 次の実行の `state`。書くと、実行が通ったときだけ保存する。書かなければ変わらない |
| `reply` | コマンドの返事。`COMMAND` のルールでだけ使える(ほかで書くと失敗) |
| `later` | あとで動かす予約。各要素は `{ seconds, data }` で、JavaScript の `later()` と同じ([あとで動かす](rules.md#あとで動かすlater))。上限を超えると失敗 |
| `response` | 押した人への応答。JavaScript の `respond()` と同じ `{ type, data }`。`INTERACTION_CREATE` と `COMMAND` のルールでだけ使える(ほかで書くと失敗) |

- 標準エラー出力は実行履歴のログになります(100行・1行2000文字まで)。
- 終了コードが0以外なら失敗です。標準エラー出力の最後の行を失敗の理由として記録します。
- 標準出力が JSON でないとき、オブジェクトでないときも失敗です。

### secretary.call

```c
// import "secretary" "call"
int32_t call(const uint8_t *req_ptr, uint32_t req_len, uint8_t *resp_ptr, uint32_t resp_cap);
```

要求も応答も UTF-8 の JSON です。要求は `{ "fn": "名前", ...引数 }`、応答は `{ "value": … }` か `{ "error": "…" }` です。

- 戻り値が0以上なら、応答の長さです。応答は `resp_ptr` に入っています。
- 戻り値が負なら、バッファが足りません。`-戻り値` が要る長さです。同じ要求をもっと大きいバッファで送り直してください。送り直しても二重には実行せず、前の答えを返します。
- 呼び出しは答えが来るまで止まります(同期)。待つ時間も実行時間に入ります。

```text
n = call(req, len, buf, cap)
if n < 0 { buf = 新しいバッファ(-n); n = call(req, len, buf, -n) }
JSON として buf[0:n] を読み、error があれば失敗として扱う
```

### ホスト関数

| `fn` | 引数 | 返り値 |
|---|---|---|
| `get` | `route`, `query?` | Discord REST の GET の結果。読める範囲だけ([読めるルート](js-api.md#読めるルート))。1回の実行で200回まで |
| `judge` | `state`, `questions` | 判定モデルの答え(JavaScript の [`judge`](js-api.md#判定judge-と-rank) と同じ) |
| `rank` | `items`, `instructions`, `levels?` | `[{ item, score }]` を高い順に |
| `renderMath` | `tex`, `options?`, `name?` | 画像ID(`img1` など) |
| `convertImage` | `source`, `options?`, `name?` | 画像ID |
| `image` | `data`(PNG・JPEG・GIF・WebP の Base64), `name?` | 画像ID。Botが描き直してから使う |
| `runWasm` | `module`, `input?`, `stdin?` | `{ exitCode, stdout, logs }`。登録済みのモジュールを1回動かす(JavaScript の [`runWasm`](js-api.md#wasm-を動かすrunwasm) と同じ)。動かしたモジュールからは呼べない |

例: `{"fn":"get","route":"/guilds/123/roles"}`、`{"fn":"get","route":"/channels/456/messages","query":{"limit":20}}`。

`judge` と `rank` は合わせて10回、画像を作る関数は合わせて4枚までです。オプションは [JavaScript の API](js-api.md#画像) と同じです。画像IDは投稿の `body.files` に入れるか、コマンドでは返事に付きます。

### WASI の動き

| 関数 | 動き |
|---|---|
| `fd_read` | fd 0(標準入力)だけ |
| `fd_write` | fd 1(標準出力)と 2(標準エラー出力)だけ |
| `args_get` | 引数は `module` の1つ |
| `environ_get` | 環境変数はない |
| `clock_time_get` | 0 は今の時刻、ほかは単調な時計 |
| `random_get` | 暗号用の乱数 |
| `proc_exit` | 終了コードで終わる |
| `fd_prestat_get` | 開いているディレクトリはない |

ファイル・ソケット・そのほかの関数は「ない」と答えます(`EBADF` か `ENOSYS`)。

## 制限

| 項目 | 上限 |
|---|---|
| 大きさ | 1個8MB、一人20個・合計50MB |
| メモリ | 64MiB(登録時にメモリの最大値を書き換えて強制) |
| 実行時間 | 1回30秒(順番待ちを含む)。超えるとスレッドごと止める |
| 同時実行 | Bot全体で4つまで。ほかは順番を待つ |
| `get` | 1回の実行で200回 |
| 画像 | 1回の実行で4枚 |
| 出力 | 標準出力4MB(超えると失敗)、標準エラー出力64KB・100行 |

Wasm のルールは state を書くかどうかが前もって分からないので、いつも1回ずつ順番に動きます([実行の順番](rules.md#実行の順番serial_by))。モジュールは登録のときにコンパイルしておき、最初の実行の前に一度、何も読めない状態で空回しします。

## 例

各言語の SDK を使う例は [言語と SDK](languages.md) にあります。SDK を使わない例もあります。

- [examples/wasm/go](../examples/wasm/go): `GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .`
- [examples/wasm/rust](../examples/wasm/rust): `cargo build --release --target wasm32-wasip1`

## JS エンジンのビルド

`wasm/js-runner/build.sh` が wasi-sdk と QuickJS-ng を取ってきて `src/wasm/js-runner.wasm` を作ります。結果はリポジトリに入れてあるので、Bot の起動や配布にビルドは要りません。ルールのコードは初回(または起動時)に QuickJS のバイトコードへコンパイルして DB に保存し、以後はそれを読み込んで動かします。

JS エンジンはふつうのモジュールの入力の前に1行のヘッダー `{"mode":"source"|"bytecode"|"compile","size":N}` と N バイトのプログラムを読みます。入力の各項目はグローバル変数になり、プログラムが返した文字列が標準出力になります。
