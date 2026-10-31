import secretary
from util import words

data = secretary.input()
name = "このサーバー"
try:
    guild = secretary.get("/guilds/" + str(data.get("guild", "")))
    name = guild.get("name", name)
except secretary.HostError as e:
    print("get failed:", e)
secretary.output({"reply": "ここは %s です(%d)" % (name, len(words("a b c"))), "steps": []})
