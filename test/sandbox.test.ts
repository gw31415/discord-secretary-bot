import { test } from "node:test";
import assert from "node:assert/strict";
import { runSandboxed } from "../src/sandbox.ts";

const limits = { wallTimeMs: 2000, maxGets: 3 };
const bindings = {
  guildId: "1",
  actor: { kind: "user" as const, userId: "42" },
  get: async (route: string, query: Record<string, unknown>) => ({ route, query }),
};

test("returns a JSON value and calls discord.get synchronously", async () => {
  const r = await runSandboxed(`const x = discord.get("GET /guilds/" + guild, { query: { a: 1 } }); log("hi", actor.userId); return { x, n: 2 };`, bindings, limits);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, { x: { route: "GET /guilds/1", query: { a: 1 } }, n: 2 });
  assert.deepEqual(r.logs, ['"hi" "42"']);
});

test("limits the number of discord.get calls", async () => {
  const r = await runSandboxed(`for (let i = 0; i < 5; i++) discord.get("/x"); return 1;`, bindings, limits);
  assert.equal(r.ok, false);
  assert.match(r.error!, /3回まで/);
});

test("interrupts infinite loops", async () => {
  const r = await runSandboxed(`while (true) {}`, bindings, { ...limits, wallTimeMs: 200 });
  assert.equal(r.ok, false);
});

test("enforces the memory limit", async () => {
  const r = await runSandboxed(`const a = []; while (true) a.push("x".repeat(1e5));`, bindings, limits);
  assert.equal(r.ok, false);
});

test("has no host globals", async () => {
  const r = await runSandboxed(`return [typeof process, typeof require, typeof fetch, typeof setTimeout];`, bindings, limits);
  assert.deepEqual(r.value, ["undefined", "undefined", "undefined", "undefined"]);
});

test("host errors surface as sandbox errors", async () => {
  const r = await runSandboxed(`return discord.get("/denied");`, { ...bindings, get: async () => { throw new Error("denied!"); } }, limits);
  assert.equal(r.ok, false);
  assert.match(r.error!, /denied!/);
});

test("plan(steps, rules) carries rules, and a rule's code reads its params", async () => {
  const r = await runSandboxed(`return plan([call("DELETE /channels/{channel}", { path: { channel: "1" } })], [rule({ name: "x", trigger_event: "VOICE_STATE_UPDATE" })]);`, bindings, limits);
  assert.deepEqual(r.value, { steps: [{ op: "DELETE /channels/{channel}", path: { channel: "1" } }], rules: [{ name: "x", trigger_event: "VOICE_STATE_UPDATE" }] });
  const p = await runSandboxed(`return [params.lobby, event.channel_id];`, { ...bindings, params: { lobby: "7" }, event: { channel_id: "7" } }, limits);
  assert.deepEqual(p.value, ["7", "7"]);
});

test("a rule's code reads which trigger fired as eventName", async () => {
  const { runRuleCode } = await import("../src/sandbox.ts");
  const bindings = { guildId: "1", actor: { kind: "user" as const, userId: "2" }, get: async () => null };
  const named = (b: object) => runRuleCode("return plan([call('X', { body: eventName })])", { ...bindings, ...b });
  assert.equal(((await named({ eventName: "CHANNEL_CREATE" })).value as { steps: Array<{ body: unknown }> }).steps[0]!.body, "CHANNEL_CREATE");
  assert.equal(((await named({})).value as { steps: Array<{ body: unknown }> }).steps[0]!.body, null);
});

test("rule code reads its state and sets the next one; other code has neither", async () => {
  const { runRuleCode, runSandboxed } = await import("../src/sandbox.ts");
  const bindings = { guildId: "100", actor: { kind: "user" as const, userId: "1" }, get: async () => null };
  const r = await runRuleCode("const s = state || { n: 0 }; s.n++; setState(s); s.n = 99; return null", { ...bindings, state: { n: 1 } });
  assert.deepEqual(r.state, { value: { n: 2 } });
  assert.equal(r.value, null);
  const untouched = await runRuleCode("return plan([])", { ...bindings, state: null });
  assert.equal(untouched.state, undefined);
  const agent = await runSandboxed("return [state, typeof setState]", bindings);
  assert.deepEqual(agent.value, [null, "undefined"]);
});

test("an interaction rule's code answers with respond(); other runs cannot", async () => {
  const { runRuleCode } = await import("../src/sandbox.ts");
  const bindings = { guildId: "100", actor: { kind: "user" as const, userId: "1" }, get: async () => null };
  let answered: unknown;
  const r = await runRuleCode("respond({ type: 9, data: { custom_id: 'f', title: event.data.custom_id, components: [] } }); return null", { ...bindings, event: { data: { custom_id: "apply" } }, respond: (x) => void (answered = x) });
  assert.equal(r.ok, true);
  assert.deepEqual(answered, { type: 9, data: { custom_id: "f", title: "apply", components: [] } });
  const outside = await runRuleCode("respond({ type: 4 }); return null", bindings);
  assert.equal(outside.ok, false);
  assert.match(outside.error!, /INTERACTION_CREATE/);
});

test("a rule's later() calls reach the host in order, and a module's later output does too", async () => {
  const { runRuleCode } = await import("../src/sandbox.ts");
  const asked: unknown[] = [];
  const bindings = { guildId: "1", actor: { kind: "user" as const, userId: "2" }, get: async () => null, later: (seconds: number, data: unknown) => void asked.push([seconds, data]) };
  const ok = await runRuleCode("later(600, { a: 1 }); later('120'); return null;", bindings);
  assert.equal(ok.ok, true);
  assert.deepEqual(asked, [[600, { a: 1 }], [120, null]]);
  const refused = await runRuleCode("later(1); return null;", { ...bindings, later: () => { throw new Error("later() の秒数は60〜"); } });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /秒数/);
  const without = await runRuleCode("later(600); return null;", { guildId: "1", actor: { kind: "user" as const, userId: "2" }, get: async () => null });
  assert.match(without.error ?? "", /later/);
});
