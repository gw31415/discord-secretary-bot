import itertools
from collections import defaultdict
import secretary
from util import words

data = secretary.input()
name = "このサーバー"
try:
    guild = secretary.get("/guilds/" + str(data.get("guild", "")))
    name = guild.get("name", name)
except secretary.HostError as e:
    print("get failed:", e)
counts = defaultdict(int)
for w in words("a b a"):
    counts[w] += 1
pairs = len(list(itertools.combinations(sorted(counts), 2)))
secretary.output({"reply": "ここは %s です(%d・%d)" % (name, counts["a"], pairs), "steps": []})
