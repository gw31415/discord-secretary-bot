//! The bot's side of the ABI: read the input, call the host, write the output.
#![allow(dead_code)]
use serde_json::{json, Value};
use std::io::{Read, Write};

#[link(wasm_import_module = "secretary")]
extern "C" {
    #[link_name = "call"]
    fn host_call(req_ptr: *const u8, req_len: u32, resp_ptr: *mut u8, resp_cap: u32) -> i32;
}

/// The run's input: guild, actor, eventName, event, batch, params, state.
pub fn input() -> Value {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("stdin");
    serde_json::from_str(&raw).expect("input JSON")
}

/// Sends one request (e.g. {"fn":"get","route":"/guilds/1"}) and returns its value.
pub fn call(request: Value) -> Result<Value, String> {
    let req = request.to_string();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = unsafe { host_call(req.as_ptr(), req.len() as u32, buf.as_mut_ptr(), buf.len() as u32) };
        if n < 0 {
            buf = vec![0u8; (-n) as usize];
            continue;
        }
        let res: Value = serde_json::from_slice(&buf[..n as usize]).map_err(|e| e.to_string())?;
        if let Some(err) = res.get("error").and_then(Value::as_str) {
            return Err(err.to_string());
        }
        return Ok(res.get("value").cloned().unwrap_or(Value::Null));
    }
}

/// GET a Discord route the rule's owner may read.
pub fn get(route: &str) -> Result<Value, String> {
    call(json!({ "fn": "get", "route": route }))
}

/// GET with a query string, e.g. `get_with("/channels/1/messages", json!({ "limit": 1 }))`.
pub fn get_with(route: &str, query: Value) -> Result<Value, String> {
    call(json!({ "fn": "get", "route": route, "query": query }))
}

/// Writes the result: { steps, state?, reply? }.
pub fn output(result: Value) {
    std::io::stdout().write_all(result.to_string().as_bytes()).expect("stdout");
}
