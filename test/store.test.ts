import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { open, seal } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { findChatModel, judgeRef, lightestThinking, selectableModels } from "../src/llm/models.ts";
import { CUSTOM_ID, parseCustomId, renderPanel, setupStatus } from "../src/llm/panel.ts";
import { SETTINGS_HOME_ID } from "../src/rules/panel.ts";

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

test("setup needs a key and the language model; the judge model is optional", () => {
  const store = new Store(":memory:", master);
  assert.equal(setupStatus(store, "u1").complete, false);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  assert.deepEqual(setupStatus(store, "u1").missing, ["言語モデル"]);
  store.setModel("u1", "response", { provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.equal(setupStatus(store, "u1").complete, true);
  assert.deepEqual(judgeRef(store.getSettings("u1")), { provider: "anthropic", model: "claude-sonnet-4-5" }, "the language model judges");
  store.setModel("u1", "judge", { provider: "anthropic", model: "claude-haiku-4-5" });
  assert.equal(setupStatus(store, "u1").complete, true);
  assert.equal(judgeRef(store.getSettings("u1"))!.model, "claude-haiku-4-5");
  store.deleteApiKey("u1", "anthropic");
  assert.equal(setupStatus(store, "u1").complete, false, "models without their provider's key do not count");
});

test("the model select menus stay within Discord's 25 options", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  store.setApiKey("u1", "typesafe", "ts-abcdefgh5678");
  const panel = JSON.stringify(renderPanel(store, "u1", undefined, "models"));
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
  store.setApiKey("u1", "openai", "sk-proj-abcdefgh7890");
  store.setApiKey("u1", "openrouter", "sk-or-abcdefgh1357");
  // A warning line is the most the web section ever adds.
  store.setModel("u1", "response", { provider: "zai", model: selectableModels("zai", "response")[0]!.id });
  store.setWebTool("u1", "anthropic");
  store.setModel("u1", "code", { provider: "anthropic", model: selectableModels("anthropic", "code")[0]!.id });
  const models = renderPanel(store, "u1", undefined, "models");
  const advanced = renderPanel(store, "u1", undefined, "advanced");
  assert.match(JSON.stringify(advanced), /応答モデルがClaudeではない/);
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
  for (const panel of [models, advanced]) {
    components = 0;
    const before = selects.length;
    walk(panel.components);
    assert.ok(components <= 40, `${components} components`);
    const ids = selects.slice(before).map((s) => s.custom_id);
    assert.equal(new Set(ids).size, ids.length);
  }
  // Discord rejects a select whose options repeat a value (gpt-6-luna is both a chat model and a classifier).
  for (const s of selects) assert.equal(new Set(s.options.map((o) => o.value)).size, s.options.length, s.custom_id);
  const offered = (role: string) =>
    new Set(selects.filter((s) => s.custom_id.startsWith(`llm:model:${role}:`)).flatMap((s) => s.options.map((o) => o.value)));
  const code = selects.filter((s) => s.custom_id.startsWith("llm:model:code:")).flatMap((s) => s.options.map((o) => o.value));
  assert.equal(code[0], "none");
  assert.equal(code.length, 1 + selectableModels("anthropic", "code").length + selectableModels("zai", "code").length + selectableModels("openai", "code").length);
  for (const role of ["response", "judge", "addressee"] as const) {
    for (const provider of ["anthropic", "typesafe", "zai", "openai"] as const) {
      for (const m of selectableModels(provider, role)) assert.ok(offered(role).has(`${provider}/${m.id}`), `${role} ${provider}/${m.id}`);
    }
  }
  assert.ok(offered("response").has("anthropic/claude-opus-5-5"));
  assert.ok(offered("judge").has("typesafe/jev-latest"), "Jev is offered for judgment");
  assert.ok(offered("judge").has("openai/gpt-6-luna"), "the Decisions API is offered for judgment");
  assert.ok(!offered("response").has("openai/gpt-4"), "old OpenAI models stay out of the menus");
  assert.ok(!offered("response").has("typesafe/jev-latest"), "a classifier cannot answer");
  assert.ok(offered("reaction").has("typesafe/jev-latest"), "Jev is offered for reactions");
  const reaction = selects.filter((s) => s.custom_id.startsWith("llm:model:reaction:")).flatMap((s) => s.options.map((o) => o.value));
  assert.equal(reaction[0], "none");
});

test("custom ids parse into panel actions and reject unknown models", () => {
  assert.deepEqual(parseCustomId("llm:key:anthropic"), { kind: "openKeyModal", provider: "anthropic" });
  assert.deepEqual(parseCustomId("llm:read:scope", ["always"]), { kind: "selectReadScope", scope: "always" });
  assert.equal(parseCustomId("llm:read:scope", ["everything"]), null);
  assert.deepEqual(parseCustomId("llm:model:judge:anthropic:0", ["anthropic/claude-haiku-4-5"]), {
    kind: "selectModel", role: "judge", provider: "anthropic", model: "claude-haiku-4-5",
  });
  assert.equal(parseCustomId("llm:model:judge", ["anthropic/not-a-model"]), null);
  assert.equal(parseCustomId("llm:model:judge:typesafe:0", ["typesafe/jev-latest"])?.kind, "selectModel");
  assert.equal(parseCustomId("llm:model:response:typesafe:0", ["typesafe/jev-latest"]), null);
  assert.equal(parseCustomId("llm:key:mistral"), null);
  // OpenRouter models are typed in: the select opens a modal for the role.
  assert.deepEqual(parseCustomId("llm:typed:role", ["judge"]), { kind: "openTypedModelModal", role: "judge" });
  assert.equal(parseCustomId("llm:typed:role", ["boss"]), null);
  assert.deepEqual(parseCustomId("llm:typedmodal:response"), { kind: "submitTypedModel", role: "response" });
  assert.equal(parseCustomId("llm:model:judge:all:0", ["openrouter/~typesafe/jev-latest"])?.kind, "selectModel");
  assert.deepEqual(parseCustomId("llm:key:set", ["openai"]), { kind: "openKeyModal", provider: "openai" });
  assert.deepEqual(parseCustomId("llm:key:delete", ["tavily"]), { kind: "deleteKey", provider: "tavily" });
  assert.equal(parseCustomId("llm:key:delete", ["mistral"]), null);
  // OpenAI: chat models for answers, and the Decisions API (gpt-6-luna) for judgment.
  assert.equal(parseCustomId("llm:model:response:all:0", ["openai/gpt-6-sol"])?.kind, "selectModel");
  assert.equal(parseCustomId("llm:model:judge:all:0", ["openai/gpt-6-luna"])?.kind, "selectModel");
  assert.deepEqual(parseCustomId("llm:key:tavily"), { kind: "openKeyModal", provider: "tavily" });
  assert.deepEqual(parseCustomId("llm:web:tool", ["tavily"]), { kind: "selectWeb", tool: "tavily" });
  assert.equal(parseCustomId("llm:web:tool", ["bing"]), null);
  assert.equal(parseCustomId("llm:model:response:tavily:0", ["tavily/search"]), null);
  assert.equal(parseCustomId("plan:run:1"), null);
  // The code model is optional: one select across providers, led by "leave it to the response model".
  assert.deepEqual(parseCustomId("llm:model:code:all:0", ["none"]), { kind: "clearModel", role: "code" });
  assert.equal(parseCustomId("llm:model:code:all:0", ["typesafe/jev-latest"]), null);
  assert.equal(parseCustomId("llm:model:code:all:0", ["zai/glm-5.2"])?.kind, "selectModel");
  // The reaction model is optional too, and takes a classifier.
  assert.deepEqual(parseCustomId("llm:model:reaction:all:0", ["none"]), { kind: "clearModel", role: "reaction" });
  // The judge model may be left to the language model; the language model may not.
  assert.deepEqual(parseCustomId("llm:model:judge:all:0", ["none"]), { kind: "clearModel", role: "judge" });
  assert.equal(parseCustomId("llm:model:response:all:0", ["none"]), null);
  assert.deepEqual(parseCustomId("llm:page:models"), { kind: "page", page: "models" });
  assert.equal(parseCustomId("llm:page:secret"), null);
  assert.equal(parseCustomId("llm:model:reaction:all:0", ["typesafe/jev-latest"])?.kind, "selectModel");
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

test("OpenRouter models are typed in, and the one chosen is shown in its role's menu", () => {
  const store = new Store(":memory:", master);
  store.setApiKey("u1", "anthropic", "sk-ant-abcdefgh1234");
  store.setApiKey("u1", "openrouter", "sk-or-abcdefgh1357");
  const before = JSON.stringify(renderPanel(store, "u1", undefined, "models"));
  assert.match(before, /llm:typed:role/);
  assert.doesNotMatch(before, /"openrouter\//, "hundreds of models stay out of the menus");
  store.setModel("u1", "response", { provider: "openrouter", model: "anthropic/claude-sonnet-5" });
  const after = renderPanel(store, "u1", undefined, "models");
  const values: Array<{ value: string; default?: boolean; label?: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const c = node as { custom_id?: string; options?: Array<{ value: string; default?: boolean; label?: string }>; components?: unknown };
    if (c.custom_id?.startsWith("llm:model:response:")) values.push(...(c.options ?? []));
    walk(c.components);
  };
  walk(after.components);
  assert.deepEqual(values.filter((o) => o.value.startsWith("openrouter/")), [{ value: "openrouter/anthropic/claude-sonnet-5", default: true, label: values.find((o) => o.value.startsWith("openrouter/"))!.label, description: "OpenRouter · anthropic/claude-sonnet-5" } as never]);
  assert.ok(setupStatus(store, "u1").missing.every((m) => !m.startsWith("言語")));
});

test("the settings panel moves between its pages with buttons, each well within Discord's limits", () => {
  const store = new Store(":memory:", master);
  for (const [p, k] of [["anthropic", "sk-ant-abcdefgh1234"], ["typesafe", "ts-abcdefgh5678"], ["zai", "glm-abcdefgh9012"], ["tavily", "tvly-abcdefgh3456"], ["openai", "sk-proj-abcdefgh7890"], ["openrouter", "sk-or-abcdefgh1357"]] as const) store.setApiKey("u1", p, k);
  store.setModel("u1", "response", { provider: "anthropic", model: "claude-sonnet-4-5" });
  const count = (node: unknown): number => Array.isArray(node) ? node.reduce((n, c) => n + count(c), 0) : node && typeof node === "object" ? (typeof (node as { type?: unknown }).type === "number" ? 1 : 0) + count((node as { components?: unknown }).components) : 0;
  const home = JSON.stringify(renderPanel(store, "u1"));
  assert.match(home, /llm:page:keys/);
  assert.match(home, /llm:page:models/);
  assert.match(home, /判定モデル\*\*: 言語モデルを使う/);
  assert.match(home, /llm:read:scope/);
  assert.match(JSON.stringify(renderPanel(store, "u1", undefined, "advanced")), /llm:web:tool/);
  assert.match(JSON.stringify(renderPanel(store, "u1", undefined, "advanced")), /llm:model:addressee:/);
  assert.doesNotMatch(JSON.stringify(renderPanel(store, "u1", undefined, "models")), /llm:model:(addressee|code|reaction):/);
  assert.doesNotMatch(home, /llm:model:/);
  const keys = JSON.stringify(renderPanel(store, "u1", undefined, "keys"));
  assert.match(keys, /llm:key:set/);
  assert.match(keys, /llm:page:home/);
  for (const page of ["home", "keys", "models", "advanced"] as const) assert.ok(count(renderPanel(store, "u1", undefined, page).components) <= 40, page);
  // The rules are a section of the panel, and their panel leads back here.
  assert.match(home, /rule:home:/);
  assert.equal(SETTINGS_HOME_ID, CUSTOM_ID.page("home"));
  const rows = (renderPanel(store, "u1", undefined, "keys").components[0] as { components: Array<{ type: number; components?: Array<{ type: number }> }> }).components.filter((c) => c.type === 1 && c.components!.every((b) => b.type === 2));
  assert.ok(rows.every((r) => r.components!.length <= 3));
});
