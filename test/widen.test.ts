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
  const before = Math.floor(Date.now() / 1000);
  const answer = prompts.ask({ channelId: "10", replyToId: "1", speakerId: "2", reason: "staff を読むため" });
  await new Promise((r) => setImmediate(r));
  const question = (f.posted[0] as unknown as { content: string }).content.split("\n");
  assert.equal(question[0], "<@2> 読み取りをあなたが見られる範囲まで広げてよいですか?");
  // The question says when it is taken back, two minutes on.
  const deadline = Number(/^-# 期限 <t:(\d+):R>$/.exec(question[3]!)![1]);
  assert.ok(deadline >= before + 120 && deadline <= before + 121);
  const [yes] = f.posted[0]!.components[0]!.components.map((b) => b.custom_id);
  assert.equal(await prompts.handleInteraction(press(yes!, "3")), true);
  assert.deepEqual(f.ephemeral, ["依頼した本人だけが押せます"]);
  assert.equal(await prompts.handleInteraction(press(yes!, "2")), true);
  assert.equal(await answer, true);
  assert.equal(f.updates[0], "🔓 <@2> が見られる範囲まで読み取ります");
  // A second press after the answer changes nothing.
  await prompts.handleInteraction(press(yes!, "2"));
  assert.equal(f.updates[1], "この確認はもう終わっています");
  assert.equal(await prompts.handleInteraction(press("plan:x:run", "2")), false);
});

test("no answer in time counts as not allowed and takes the buttons away", async () => {
  const f = fakeApi();
  const prompts = new WidenPrompts(f.api, 10);
  assert.equal(await prompts.ask({ channelId: "10", replyToId: "1", speakerId: "2", reason: "x" }), false);
  assert.deepEqual(f.edits, ["🔒 返事がなかったので、読み取りは広げません"]);
});

test("going on past the turn limit is asked the same way", async () => {
  const f = fakeApi();
  const prompts = new WidenPrompts(f.api);
  const answer = prompts.askContinue({ channelId: "10", replyToId: "1", speakerId: "2", turns: 12 });
  await new Promise((r) => setImmediate(r));
  assert.equal((f.posted[0] as unknown as { content: string }).content, "⏸️ <@2> 手順が12回に達したので止めています。続けますか?");
  const [, no] = f.posted[0]!.components[0]!.components.map((b) => b.custom_id);
  await prompts.handleInteraction(press(no!, "2"));
  assert.equal(await answer, false);
  assert.equal(f.updates[0], "⏹️ ここで終えました");
});
