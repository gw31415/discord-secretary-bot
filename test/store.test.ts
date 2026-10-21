import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { open, seal } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { findModel, lightestThinking, selectableModels } from "../src/llm/models.ts";
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
  store.setApiKey("u1", "opencode-go", "sk-oc-abcdefgh5678");
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
  store.setApiKey("u1", "opencode-go", "sk-oc-abcdefgh5678");
  store.setApiKey("u1", "zai", "zai-abcdefgh9012");
  const panel = renderPanel(store, "u1");
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
  const offered = new Set(selects.filter((s) => s.custom_id.startsWith("llm:model:response")).flatMap((s) => s.options.map((o) => o.value)));
  for (const provider of ["anthropic", "opencode-go", "zai"] as const) {
    for (const m of selectableModels(provider)) assert.ok(offered.has(`${provider}/${m.id}`), `${provider}/${m.id}`);
  }
  assert.ok(offered.has("anthropic/claude-opus-5-5"));
  assert.ok(offered.has("zai/glm-5.3"));
});

test("custom ids parse into panel actions and reject unknown models", () => {
  assert.deepEqual(parseCustomId("llm:key:anthropic"), { kind: "openKeyModal", provider: "anthropic" });
  assert.deepEqual(parseCustomId("llm:model:judge:anthropic:0", ["anthropic/claude-haiku-4-5"]), {
    kind: "selectModel", role: "judge", provider: "anthropic", model: "claude-haiku-4-5",
  });
  assert.equal(parseCustomId("llm:model:judge", ["anthropic/not-a-model"]), null);
  assert.equal(parseCustomId("llm:key:openai"), null);
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
  assert.equal(lightestThinking(findModel("zai", "glm-5.3")!), "low");
  assert.equal(lightestThinking(findModel("zai", "glm-5.2")!), undefined);
  assert.equal(lightestThinking(findModel("anthropic", "claude-haiku-5-5")!), undefined);
});
