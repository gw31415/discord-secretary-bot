# 言語と SDK

wasm-compiler(`compiler/`)を入れてあれば、ビルドしなくてもソースを渡すだけで Wasm モジュールになります。会話で「C で書いて /hello にして」のように頼むと、Botが書き方を読み(`wasm_language_guide`)、コンパイルします(`compile_wasm`)。できるモジュールの ABI は [Wasm](wasm.md#abi) のとおりです。

## コンパイルの流れ

1. Botがソースを書くか、メッセージに添付されたソースを使います。
2. `compile_wasm` でコンパイルします。エラーは `ファイル:行:列` つきで返るので、Botが直して出し直します。
3. できたモジュールは30分だけ手元に置きます。`run_wasm` で試すか、`register_wasm` で名前を付けて登録します。登録するとソースも一緒に残ります。
4. 登録した名前をルールの `wasm` に入れます。

確認ダイアログと `/settings` の「Wasm」では、sha256 の代わりにこのソースが見られます。

- 渡せるのはソースだけです。Cargo.toml・go.mod・moon.pkg・build.zig・nim.cfg・build.rs などのビルド設定と、依存の追加はできません。
- ソースは合計256KB まで、ファイルは32個までです。
- コンパイルは1人1件ずつ、1時間に30回までです。同じ言語・同じソースの結果は覚えておき、2回目からはすぐに返します(回数にも数えません)。
- 最適化は既定でサイズ優先です。速さ優先も選べます。

コンパイラはBotとは別のサービス(別ユーザー・Unix ソケット)で、1回のビルドごとに使い捨ての箱(bubblewrap)で動きます。箱にはネットワークがなく(ループバックだけ)、ホストのファイルもほかのプロセスも見えません。入れ方と隔離の中身は [compiler/README.md](../compiler/README.md) にあります。

## 言語の一覧

| id | 言語 | ツールチェーン | 入口 | 置けるファイル | ライブラリ | 時間 |
|---|---|---|---|---|---|---|
| `c` | C/C++ | wasi-sdk 25(clang) | `main.c`・`main.cpp`・`main.cc` | `.c` `.h` `.cc` `.cpp` `.hpp`。最上位か1階層下 | 標準ライブラリ、cJSON 1.7.18 | 60秒 |
| `go` | Go(TinyGo) | TinyGo 0.43(Go 1.25) | `main.go` | `.go`。サブパッケージ可 | 標準ライブラリ(TinyGo の対応範囲) | 180秒 |
| `rust` | Rust | Rust 1.90、wasm32-wasip1 | `src/main.rs` | `src/` の下の `.rs` | 標準ライブラリ、serde(derive)、serde_json | 180秒 |
| `moonbit` | MoonBit | MoonBit 0.10.17、`--target wasm` | `main.mbt` | 同じパッケージの `.mbt` だけ | moonbitlang/core | 120秒 |
| `nim` | Nim | Nim 2.2.12 → wasi-sdk 25 の clang | `main.nim` | `.nim`。サブディレクトリ可 | 標準ライブラリ(ファイル・ネットワーク・プロセス・スレッドを使わないもの) | 120秒 |
| `zig` | Zig | Zig 0.17、wasm32-wasi | `main.zig` | `.zig`。サブディレクトリ可 | 標準ライブラリ | 120秒 |

どの言語も、実行時に使えるのは標準入出力・時計・乱数だけです。ファイル・ネットワークはなく、メモリは64MiB までです。言語ごとの細かい決まりと例は各言語の `guide.md` にあります。Botが `wasm_language_guide` で読むのはこれに、どの言語にも共通の [secretary.call](wasm.md#secretarycall) と [ホスト関数](wasm.md#ホスト関数) の節を足したものです。

## SDK

どの言語にも同じ4つの働きの SDK が付いています。ソースの隣に置かれるので、import するだけで使えます。

| 働き | 中身 |
|---|---|
| input | 標準入力の JSON(`guild`・`actor`・`eventName`・`event`・`batch`・`params`・`state`)を読む |
| call | `{ "fn": ... }` を `secretary.call` で送り、`value` を返す。`error` なら失敗にする。バッファの取り直しは SDK がする |
| get | `call` の `get`。Discord REST の GET(読める範囲だけ)。`limit` などのクエリを渡す形もある(route に `?limit=1` と書いても同じに扱う) |
| output | 標準出力に `{ steps, state?, reply? }` を書く |

`judge`・`rank`・`renderMath` などは `call` に `fn` を入れて呼びます([ホスト関数](wasm.md#ホスト関数))。

### C/C++

`#include "secretary.h"`。JSON は cJSON です。返ってくるポインタは呼んだ側のものです。C は C17、C++ は C++20 で、例外(`throw`)は使えません。

```c
cJSON *secretary_input(void);
cJSON *secretary_call(const cJSON *request, char **error);  // 失敗は NULL と *error(free する)
cJSON *secretary_get(const char *route, char **error);
cJSON *secretary_get_query(const char *route, const cJSON *query, char **error);  // query は呼んだ側が消す
void   secretary_output(const cJSON *result);
char  *secretary_read_stdin(size_t *length);                 // 生の標準入力
char  *secretary_call_raw(const char *request, size_t length); // 生の要求と応答
```

案内と例: [compiler/languages/c/guide.md](../compiler/languages/c/guide.md)

### Go(TinyGo)

モジュール名は `bot`、SDK は `bot/secretary` です。サブパッケージは `bot/<dir>` で import します。cgo と go generate は動きません。`encoding/json` と `reflect` の一部は動き、goroutine は動きますが並列にはなりません。できるモジュールは数百KB です。

```go
secretary.Input(v any) error
secretary.Call(request any, out any) error
secretary.Get(route string, out any) error
secretary.GetQuery(route string, query map[string]any, out any) error
secretary.Output(result any) error
```

案内と例: [compiler/languages/go/guide.md](../compiler/languages/go/guide.md)

### Rust

`mod secretary;` で使えます。`src/secretary.rs` を自分で置かなければ自動で入ります。スレッドはなく、`panic` は失敗になります。

```rust
secretary::input() -> serde_json::Value
secretary::call(request: Value) -> Result<Value, String>
secretary::get(route: &str) -> Result<Value, String>
secretary::get_with(route: &str, query: Value) -> Result<Value, String>
secretary::output(result: Value)
```

案内と例: [compiler/languages/rust/guide.md](../compiler/languages/rust/guide.md)

### MoonBit

`fn main` が入口で、SDK は `@secretary` です。core のパッケージは `@json`・`@strconv` のように名前を書けば自動で import されます。`call`・`get` は失敗すると `Failure` を投げるので、`try ... catch` で受けます(`fn main` は失敗を投げられません)。できるモジュールは100KB 前後です。

```moonbit
@secretary.input() -> Json
@secretary.call(request : Json) -> Json raise
@secretary.get(route : String, query? : Json) -> Json raise  // query={ "limit": 1 }
@secretary.output(result : Json) -> Unit
```

案内と例: [compiler/languages/moonbit/guide.md](../compiler/languages/moonbit/guide.md)

### Nim

`import secretary`(`std/json` も一緒に使えます)。ビルドの設定は固定で、`--mm:orc`、スレッドなしです。スタックは1MiB です。捕まえなかった例外は記録され、実行は失敗します。

```nim
proc input*(): JsonNode
proc call*(request: JsonNode): JsonNode   # 失敗は HostError
proc get*(route: string): JsonNode
proc get*(route: string, query: JsonNode): JsonNode
proc output*(result: JsonNode)
```

案内と例: [compiler/languages/nim/guide.md](../compiler/languages/nim/guide.md)

### Zig

`pub fn main() !void` が入口で、SDK は `@import("secretary")` です。メモリは `secretary.allocator` から取り、解放しなくてかまいません(実行が終わると消えます)。標準入出力は SDK を通します。スタックは1MiB です。

```zig
secretary.input(T) !T                    // 知らないフィールドは無視
secretary.inputText() ![]u8              // 標準入力そのまま
secretary.request(req) !std.json.Value   // .{ .@"fn" = ..., ... }
secretary.get(route) !std.json.Value
secretary.getQuery(route, query) !std.json.Value  // query は .{ .limit = 1 } など
secretary.output(result) !void           // null の optional は省く
secretary.last_error                     // error.HostRefused のときの理由
```

案内と例: [compiler/languages/zig/guide.md](../compiler/languages/zig/guide.md)

## 自分でビルドする

コンパイラを使わず、手元でビルドして `.wasm` を上げることもできます。WASI preview 1 のコマンドになれば、言語は問いません。

| 言語 | ビルド |
|---|---|
| Go | `GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .`(または TinyGo の `-target=wasip1`) |
| Rust | `cargo build --release --target wasm32-wasip1` |
| C/C++ | wasi-sdk の clang(`--target=wasm32-wasip1`) |
| Zig | `zig build-exe -target wasm32-wasi` |

`secretary.call` を import として宣言する書き方は [examples/wasm](../examples/wasm) にあります。

## コンパイラの API

Botとコンパイラは Unix ソケット(既定 `/run/wasm-compiler/compiler.sock`、環境変数 `WASM_COMPILER_SOCKET` で変更、空にすると使わない)上の HTTP+JSON でつながります。

| | |
|---|---|
| `GET /v1/health` | `{ ok, running, waiting, compiled, cached }` |
| `GET /v1/languages` | 言語の一覧(用意できているかの `ready` つき) |
| `GET /v1/languages/<id>/guide` | 書き方の案内(Markdown) |
| `POST /v1/compile` | 下の要求と応答 |

```json
{ "language": "rust", "abi": "secretary/1", "optimize": "size",
  "files": [{ "path": "src/main.rs", "content": "…" }] }
```

- 成功: `{ ok: true, wasm(base64), sha256, log, durationMs, cached, language, version }`
- 失敗: `{ ok: false, stage, diagnostics: [{ file, line, col, severity, message }], log, durationMs, cached, language, version }`

`abi` は省くと `secretary/1`、`optimize` は省くと `size` です。パスは言語ごとの決まりに合うものだけで、`.` で始まる名前や `..` は使えません。要求は2MB までです。一度に1件ずつビルドし、待ちは8件までです。

言語を足すときは `compiler/languages/<id>/` を1つ足します。サービスのコードは変えません([compiler/README.md](../compiler/README.md#言語を足す))。
