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
  let count = match (try @json.parse("[1, 2, 3]") catch { _ => Json::null() }) {
    Array(a) => a.length()
    _ => 0
  }
  @secretary.output({
    "reply": Json("ここは \{name} です(\{count})"),
    "steps": [],
  })
}
