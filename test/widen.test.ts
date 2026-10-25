import { test } from "node:test";
import assert from "node:assert/strict";
import type { API } from "@discordjs/core";
import type { APIInteraction } from "discord-api-types/v10";
import { InteractionType } from "discord-api-types/v10";
import { WidenPrompts } from "../src/discord/widen.ts";

function fakeApi() {
  const posted: Array<{ components: Array<{ components: Array<{ custom_id: string }> }> }> = [];
  const updates: string[] = [];
  const ephemeral: string[] = [];
  const edits: string[] = [];
  const api = {
    channels: {
      createMessage: async (_c: string, body: never) => (posted.push(body), { id: "m1" }),
      editMessage: async (_c: string, _m: string, body: { content: string }) => void edits.push(body.content),
    },
    interactions: {
      updateMessage: async (_i: string, _t: string, body: { content: string }) => void updates.push(body.content),
      reply: async (_i: string, _t: string, body: { content: string }) => void ephemeral.push(body.content),
    },
  } as unknown as API;
  return { api, posted, updates, ephemeral, edits };
}

const press = (customId: string, userId: string) =>
  ({ id: "i", token: "t", type: InteractionType.MessageComponent, data: { custom_id: customId }, member: { user: { id: userId } } }) as unknown as APIInteraction;

test("only the speaker's press answers the question", async () => {
  const f = fakeApi();
  const prompts = new WidenPrompts(f.api);
  const answer = prompts.ask({ channelId: "10", replyToId: "1", speakerId: "2", reason: "staff を読むため" });
  await new Promise((r) => setImmediate(r));
  const [yes] = f.posted[0]!.components[0]!.components.map((b) => b.custom_id);
  assert.equal(await prompts.handleInteraction(press(yes!, "3")), true);
  assert.equal(f.ephemeral.length, 1);
  assert.equal(await prompts.handleInteraction(press(yes!, "2")), true);
  assert.equal(await answer, true);
  assert.match(f.updates[0]!, /🔓/);
  // A second press after the answer changes nothing.
  await prompts.handleInteraction(press(yes!, "2"));
  assert.match(f.updates[1]!, /もう終わっています/);
  assert.equal(await prompts.handleInteraction(press("plan:x:run", "2")), false);
});

test("no answer in time counts as not allowed and takes the buttons away", async () => {
  const f = fakeApi();
  const prompts = new WidenPrompts(f.api, 10);
  assert.equal(await prompts.ask({ channelId: "10", replyToId: "1", speakerId: "2", reason: "x" }), false);
  assert.equal(f.edits.length, 1);
});

test("going on past the turn limit is asked the same way", async () => {
  const f = fakeApi();
  const prompts = new WidenPrompts(f.api);
  const answer = prompts.askContinue({ channelId: "10", replyToId: "1", speakerId: "2", turns: 12 });
  await new Promise((r) => setImmediate(r));
  assert.match((f.posted[0] as unknown as { content: string }).content, /手順が12回に達した/);
  const [, no] = f.posted[0]!.components[0]!.components.map((b) => b.custom_id);
  await prompts.handleInteraction(press(no!, "2"));
  assert.equal(await answer, false);
  assert.match(f.updates[0]!, /ここで終えました/);
});
