import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { open, seal } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { findChatModel, lightestThinking, selectableModels } from "../src/llm/models.ts";
import { parseCustomId, renderPanel, setupStatus } from "../src/llm/panel.ts";

const master = randomBytes(32);

test("sealed secrets open only with the same master key and owner", () => {
  const sealed = seal(master, "sk-secret", "u1:anthropic");
  assert.equal(open(master, sealed, "u1:anthropic"), "sk-secret");
  assert.throws(() => open(master, sealed, "u2:anthropic"));
  assert.throws(() => open(randomBytes(32), sealed, "u1:anthropic"));
});

test("keys are stored encrypted and summarized by last four characters", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  const raw = store.db.prepare("SELECT ciphertext FROM api_keys").get() as { ciphertext: Buffer };
  assert.ok(!raw.ciphertext.toString("latin1").includes("sk-ant"));
  assert.equal(store.getApiKey("u1", "anthropic"), "sk-ant-abcdefgh1234");
  assert.deepEqual(store.listKeys("u1"), [{ provider: "anthropic", last4: "1234" }]);
  assert.equal(store.deleteApiKey("u1", "anthropic"), true);
  assert.equal(store.getApiKey("u1", "anthropic"), undefined);
});

test("setup is complete only with a key and both models", () => {
  const store = new Store(":memory:", master);
  assert.equal(setupStatus(store, "u1").complete, false);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  store.setModel("u1", "response", { provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.deepEqual(setupStatus(store, "u1").missing, ["宛先判定に使うモデル"]);
  store.setModel("u1", "judge", { provider: "anthropic", model: "claude-haiku-4-5" });
  assert.equal(setupStatus(store, "u1").complete, true);
  store.deleteApiKey("u1", "anthropic");
  assert.equal(setupStatus(store, "u1").complete, false, "models without their provider's key do not count");
});

test("the model select menus stay within Discord's 25 options", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  store.setApiKey("u1", "typesafe", "ts-abcdefgh5678");
  const panel = JSON.stringify(renderPanel(store, "u1"));
  for (const match of panel.matchAll(/"options":\[(.*?)\]\}/g)) {
    assert.ok((match[1]!.match(/"value"/g) ?? []).length <= 25);
  }
  assert.match(panel, /llm:model:response/);
  assert.match(panel, /llm:model:judge/);
});

test("every selectable model is offered, with unique custom ids, within the component limit", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  store.setApiKey("u1", "typesafe", "ts-abcdefgh5678");
  store.setApiKey("u1", "zai", "glm-abcdefgh9012");
  store.setApiKey("u1", "tavily", "tvly-abcdefgh3456");
  // A warning line is the most the web section ever adds.
  store.setModel("u1", "response", { provider: "zai", model: selectableModels("zai", "response")[0]!.id });
  store.setWebTool("u1", "anthropic");
  const panel = renderPanel(store, "u1");
  assert.match(JSON.stringify(panel), /応答モデルがClaudeではない/);
  const selects: { custom_id: string; options: { value: string }[] }[] = [];
  let components = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const c = node as { type?: number; custom_id?: string; options?: { value: string }[]; components?: unknown };
    if (typeof c.type === "number") components++;
    if (c.type === 3) selects.push(c as (typeof selects)[number]);
    if (c.type === 1 && Array.isArray(c.components)) assert.ok(c.components.length <= 5, "action row over five components");
    walk(c.components);
  };
  walk(panel.components);
  assert.ok(components <= 40, `${components} components`);
  assert.equal(new Set(selects.map((s) => s.custom_id)).size, selects.length);
  const offered = (role: string) =>
    new Set(selects.filter((s) => s.custom_id.startsWith(`llm:model:${role}:`)).flatMap((s) => s.options.map((o) => o.value)));
  for (const role of ["response", "judge"] as const) {
    for (const provider of ["anthropic", "typesafe", "zai"] as const) {
      for (const m of selectableModels(provider, role)) assert.ok(offered(role).has(`${provider}/${m.id}`), `${role} ${provider}/${m.id}`);
    }
  }
  assert.ok(offered("response").has("anthropic/claude-opus-5-5"));
  assert.ok(offered("judge").has("typesafe/jev-latest"), "Jev is offered for judgment");
  assert.ok(!offered("response").has("typesafe/jev-latest"), "a classifier cannot answer");
});

test("custom ids parse into panel actions and reject unknown models", () => {
  assert.deepEqual(parseCustomId("llm:key:anthropic"), { kind: "openKeyModal", provider: "anthropic" });
  assert.deepEqual(parseCustomId("llm:model:judge:anthropic:0", ["anthropic/claude-haiku-4-5"]), {
    kind: "selectModel", role: "judge", provider: "anthropic", model: "claude-haiku-4-5",
  });
  assert.equal(parseCustomId("llm:model:judge", ["anthropic/not-a-model"]), null);
  assert.equal(parseCustomId("llm:model:judge:typesafe:0", ["typesafe/jev-latest"])?.kind, "selectModel");
  assert.equal(parseCustomId("llm:model:response:typesafe:0", ["typesafe/jev-latest"]), null);
  assert.equal(parseCustomId("llm:key:openai"), null);
  assert.deepEqual(parseCustomId("llm:key:tavily"), { kind: "openKeyModal", provider: "tavily" });
  assert.deepEqual(parseCustomId("llm:web:tool", ["tavily"]), { kind: "selectWeb", tool: "tavily" });
  assert.equal(parseCustomId("llm:web:tool", ["bing"]), null);
  assert.equal(parseCustomId("llm:model:response:tavily:0", ["tavily/search"]), null);
  assert.equal(parseCustomId("plan:run:1"), null);
});

test("the audit log keeps actions without secrets", () => {
  const store = new Store(":memory:", master);
  store.audit({ kind: "user", userId: "u1", via: "panel" }, "llm.key.set", { provider: "anthropic" });
  const row = store.db.prepare("SELECT action, detail_json FROM audit_log").get() as { action: string; detail_json: string };
  assert.equal(row.action, "llm.key.set");
  assert.equal(row.detail_json, '{"provider":"anthropic"}');
});

test("models that cannot turn thinking off get their lightest level", () => {
  const base = findChatModel("anthropic", "claude-haiku-5-5")!;
  const thinkingOnly = { ...base, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", high: "high" } };
  assert.equal(lightestThinking(thinkingOnly), "low");
  assert.equal(lightestThinking({ ...base, reasoning: true, thinkingLevelMap: { off: "none", high: "high" } }), undefined);
  assert.equal(lightestThinking(base), undefined);
});

test("keys and settings of providers the bot dropped are ignored", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  store.db.prepare("INSERT INTO api_keys (user_id, provider, ciphertext, wrapped_dek, last4, created_at) VALUES ('u1', 'opencode-go', x'00', x'00', 'abcd', 0)").run();
  store.db.prepare("INSERT INTO user_settings (user_id, default_provider, default_model) VALUES ('u1', 'opencode-go', 'glm-5.3')").run();
  assert.deepEqual(store.listKeys("u1").map((k) => k.provider), ["anthropic"]);
  assert.equal(store.getSettings("u1").response, null);
  assert.doesNotThrow(() => renderPanel(store, "u1"));
});

test("a Tavily key alone does not complete setup, and the web tool defaults to the model's own", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "tavily", "tvly-abcdefgh3456");
  assert.ok(setupStatus(store, "u1").missing.includes("APIキー"));
  assert.equal(store.getSettings("u1").web, "auto");
  store.setWebTool("u1", "tavily");
  assert.equal(store.getSettings("u1").web, "tavily");
  assert.doesNotMatch(JSON.stringify(renderPanel(store, "u1")), /llm:model:response:tavily/);
});
