import std/strutils
import secretary

let input = secretary.input()
let guild = input{"guild"}.getStr
var name = "このサーバー"
try:
  name = secretary.get("/guilds/" & guild){"name"}.getStr(name)
except HostError as e:
  stderr.writeLine("get failed: ", e.msg)
output(%*{"reply": "ここは " & name & " です(" & $"a b c".split(' ').len & ")", "steps": []})
