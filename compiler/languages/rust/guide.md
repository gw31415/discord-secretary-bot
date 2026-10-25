# Rust でモジュールを書く

Rust 1.90 の wasm32-wasip1 です。`src/main.rs` が入口で、`src/` の下に `.rs` を32個まで置けます。Cargo.toml・build.rs は書けず、依存は固定です。

- 使えるクレート: 標準ライブラリ、`serde`(derive 付き)、`serde_json`
- SDK は `mod secretary;` で使えます(`src/secretary.rs` を自分で置かなければ自動で入ります)
- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワーク・スレッドはありません。メモリは64MiBまで
- `panic` は異常終了(失敗)になります

## SDK

```rust
secretary::input() -> serde_json::Value                         // guild, actor, eventName, event, batch, params, state
secretary::call(request: Value) -> Result<Value, String>        // {"fn": ...} を送り value を返す
secretary::get(route: &str) -> Result<Value, String>            // Discord REST の GET(作成者が読める範囲)
secretary::output(result: Value)                                // 標準出力に { steps, state?, reply? }
```

## 例: コマンドに返事をする

```rust
mod secretary;
use serde_json::json;

fn main() {
    let input = secretary::input();
    let channel = input["event"]["channel_id"].as_str().unwrap_or_default();
    let reply = match secretary::get(&format!("/channels/{channel}/pins")) {
        Ok(pins) => format!("ピン留めは {} 件です", pins.as_array().map_or(0, |a| a.len())),
        Err(e) => {
            eprintln!("get failed: {e}");
            std::process::exit(1);
        }
    };
    secretary::output(json!({ "reply": reply, "steps": [] }));
}
```
