// The bot's side of the ABI: read the input, call the host, write the output.

///|
fn wasi_fd_read(fd : Int, iovs : Int, n : Int, nread : Int) -> Int = "wasi_snapshot_preview1" "fd_read"

///|
fn host_call(req : Int, req_len : Int, resp : Int, resp_cap : Int) -> Int = "secretary" "call"

///|
/// Where a byte array's contents start in linear memory.
#borrow(b)
extern "wasm" fn addr(b : FixedArray[Byte]) -> Int =
  #|(func (param i32) (result i32) (local.get 0))

///|
fn put_u32(b : FixedArray[Byte], at : Int, v : Int) -> Unit {
  for i in 0..<4 {
    b[at + i] = ((v >> (8 * i)) & 0xff).to_byte()
  }
}

///|
fn get_u32(b : FixedArray[Byte], at : Int) -> Int {
  let mut v = 0
  for i in 0..<4 {
    v = v | (b[at + i].to_int() << (8 * i))
  }
  v
}

///|
fn read_stdin() -> String {
  let out = Buffer()
  let chunk = FixedArray::make(65536, b'\x00')
  let iov = FixedArray::make(8, b'\x00')
  let nread = FixedArray::make(4, b'\x00')
  put_u32(iov, 0, addr(chunk))
  put_u32(iov, 4, chunk.length())
  while true {
    let err = wasi_fd_read(0, addr(iov), 1, addr(nread))
    let n = get_u32(nread, 0)
    if err != 0 || n == 0 {
      break
    }
    for i in 0..<n {
      out.write_byte(chunk[i])
    }
  }
  @utf8.decode_lossy(out.to_bytes())
}

///|
fn call_raw(request : String) -> String {
  let req = @utf8.encode(request)
  let req_buf = FixedArray::make(req.length(), b'\x00')
  for i in 0..<req.length() {
    req_buf[i] = req[i]
  }
  let mut cap = 65536
  while true {
    let resp = FixedArray::make(cap, b'\x00')
    let n = host_call(addr(req_buf), req_buf.length(), addr(resp), cap)
    if n < 0 {
      cap = -n
      continue
    }
    let out = Buffer()
    for i in 0..<n {
      out.write_byte(resp[i])
    }
    return @utf8.decode_lossy(out.to_bytes())
  }
  ""
}

///|
/// The run's input: guild, actor, eventName, event, batch, params, state.
pub fn input() -> Json {
  @json.parse(read_stdin()) catch {
    _ => Json::null()
  }
}

///|
/// Sends one request (e.g. { "fn": "get", "route": "/guilds/1" }) and returns its value.
pub fn call(request : Json) -> Json raise Failure {
  let res = @json.parse(call_raw(request.stringify())) catch {
    e => fail("secretary.call の答えを読めません: \{e}")
  }
  match res {
    { "error": String(e), .. } => fail(e)
    { "value": v, .. } => v
    _ => Json::null()
  }
}

///|
/// GET a Discord route the rule's owner may read; `query` is its query string, e.g. { "limit": 1 }.
pub fn get(route : String, query? : Json) -> Json raise Failure {
  match query {
    Some(q) => call({ "fn": "get", "route": Json(route), "query": q })
    None => call({ "fn": "get", "route": Json(route) })
  }
}

///|
/// Writes the result: { "steps": [...], "state"?: ..., "reply"?: ... }.
pub fn output(result : Json) -> Unit {
  println(result.stringify())
}
