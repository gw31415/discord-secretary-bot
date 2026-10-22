import { test } from "node:test";
import assert from "node:assert/strict";
import { runSandboxed } from "../src/sandbox.ts";

const limits = { wallTimeMs: 2000, memoryBytes: 16 * 1024 * 1024, maxGets: 3 };
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
