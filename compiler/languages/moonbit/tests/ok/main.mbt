///|
fn main {
  let input = @secretary.input()
  let guild_id = match input {
    { "guild": String(g), .. } => g
    _ => ""
  }
  let name = match (try? @secretary.get("/guilds/\{guild_id}")) {
    Ok({ "name": String(n), .. }) => n
    _ => "このサーバー"
  }
  let words = @string.split("a b c", " ").to_array().length()
  @secretary.output({
    "reply": Json("ここは \{name} です(\{words})"),
    "steps": [],
  })
}
