//! A /pins command in Rust: counts the pinned messages in the channel it runs in.
//! Build: cargo build --release --target wasm32-wasip1
//! (target/wasm32-wasip1/release/pin-count.wasm)
mod secretary;
use serde_json::json;

fn main() {
    let input = secretary::input();
    let channel = input["event"]["channel_id"].as_str().unwrap_or_default().to_string();
    let reply = match secretary::get(&format!("/channels/{channel}/pins")) {
        Ok(pins) => format!("このチャンネルのピン留めは {} 件です(Rustより)", pins.as_array().map_or(0, |a| a.len())),
        Err(e) => {
            eprintln!("get failed: {e}");
            std::process::exit(1);
        }
    };
    secretary::output(json!({ "reply": reply, "steps": [] }));
}
