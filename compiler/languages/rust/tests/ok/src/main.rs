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
