import { input, get, output, HostError } from "./secretary";
import { topRoles, type Role } from "./util";

interface Params {
  count?: number;
}

const data = input();
const params = (data.params ?? {}) as Params;
let reply = "";
try {
  const roles = get(`/guilds/${data.guild}/roles`) as Role[];
  reply = topRoles(roles, params.count ?? 3).join("、");
} catch (e) {
  if (!(e instanceof HostError)) throw e;
  console.error("get failed:", e.message);
  reply = "ロールを読めませんでした";
}
const counts = new Map<string, number>();
for (const w of "a b a".split(" ")) counts.set(w, (counts.get(w) ?? 0) + 1);
output({ reply: `${reply}(${counts.get("a")})`, steps: [] });
