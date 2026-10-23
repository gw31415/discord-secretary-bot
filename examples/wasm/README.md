# Wasm モジュールの例

ABI は [docs/wasm.md](../../docs/wasm.md) にあります。

| 例 | 内容 | ビルド |
|---|---|---|
| [go](go) | `/hello`: サーバー名と実行した人を返す | `GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .` |
| [rust](rust) | `/pins`: チャンネルのピン留めの数を返す | `cargo build --release --target wasm32-wasip1` |

できた `.wasm` を `/settings` の「Wasm」から登録し、会話で「hello を /hello コマンドにして。返事だけで変更はなし」のように頼みます。
