import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { API } from "@discordjs/core";
import { ComponentType, InteractionType } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { handleInteraction } from "../src/interactions.ts";
import { selectableModels } from "../src/llm/models.ts";

function fake() {
  const ephemeral: string[] = [];
  const updated: unknown[] = [];
  const api = {
    interactions: {
      reply: async (_i: string, _t: string, body: { content: string }) => void ephemeral.push(body.content),
      updateMessage: async (_i: string, _t: string, body: unknown) => void updated.push(body),
    },
  } as unknown as API;
  return { api, ephemeral, updated, store: new Store(":memory:", randomBytes(32)) };
}

const press = (customId: string, values?: string[]) =>
  ({
    id: "i", token: "t", application_id: "app", type: InteractionType.MessageComponent, member: { user: { id: "1" } },
    data: { custom_id: customId, component_type: values ? ComponentType.StringSelect : ComponentType.Button, ...(values ? { values } : {}) },
  }) as unknown as APIInteraction;

const submit = (customId: string, field: string, value: string) =>
  ({
    id: "i", token: "t", application_id: "app", type: InteractionType.ModalSubmit, member: { user: { id: "1" } },
    data: { custom_id: customId, components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.TextInput, custom_id: field, value }] }] },
  }) as unknown as APIInteraction;

/** Every text the panel shows, joined. */
function texts(view: unknown): string {
  return JSON.stringify(view);
}

test("a press on a control the panel no longer draws gets an answer instead of failing silently", async () => {
  const f = fake();
  await handleInteraction(f.api, f.store, press("llm:gone:x"));
  await handleInteraction(f.api, f.store, submit("llm:oldmodal:x", "key", "k"));
  await handleInteraction(f.api, f.store, submit("llm:keymodal:anthropic", "key", "  "));
  assert.deepEqual(f.ephemeral, [
    "この画面は古くなっています。開き直してください。",
    "この画面は古くなっています。開き直してください。",
    "処理できませんでした。もう一度試してください。",
  ]);
  assert.equal(f.store.listKeys("1").length, 0);
});

test("a chosen model is named as the menus name it", async () => {
  const f = fake();
  f.store.setApiKey("1", "anthropic", "sk-test");
  const model = selectableModels("anthropic", "response")[0]!;
  await handleInteraction(f.api, f.store, press("llm:model:response:anthropic:0", [`anthropic/${model.id}`]));
  assert.notEqual(model.name, model.id);
  assert.ok(texts(f.updated[0]).includes(`モデルを ${model.name} にしました`));
  assert.equal(f.store.getSettings("1").response?.model, model.id);
});
