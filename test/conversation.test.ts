import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { APIMessage } from "discord-api-types/v10";
import { Conversations, SESSION_MS, SETUP_NOTICE, splitForDiscord, styleSamples } from "../src/conversation.ts";
import type { ConversationDeps, GuildMessage } from "../src/conversation.ts";
import { Store } from "../src/db.ts";
import { parseJudgement } from "../src/agent/judge.ts";
import type { Reader } from "../src/discord/reader.ts";

const SELF = "999";

function message(id: string, author: string, content: string, extra: Partial<APIMessage> = {}): GuildMessage {
  return {
    id, channel_id: "10", guild_id: "100", content, timestamp: "2026-10-21T00:00:00Z",
    author: { id: author, username: `user${author}`, discriminator: "0", global_name: null, avatar: null },
    attachments: [], embeds: [], mentions: [], mention_roles: [], mention_everyone: false, pinned: false, tts: false, type: 0,
    ...extra,
  } as GuildMessage;
}

const mention = { id: SELF, username: "bot", discriminator: "0", global_name: null, avatar: null };

function setup(opts: { judge?: { addressed: boolean; confidence: number }; respond?: ConversationDeps["respond"] } = {}) {
  const store = new Store(":memory:", randomBytes(32));
  for (const user of ["1", "2"]) {
    store.setApiKey(user, "anthropic", `sk-ant-key-for-${user}`);
    store.setModel(user, "response", { provider: "anthropic", model: "claude-sonnet-4-5" });
    store.setModel(user, "judge", { provider: "anthropic", model: "claude-haiku-4-5" });
  }
  let now = 1_000_000;
  const replies: string[] = [];
  const dms: string[] = [];
  const responded: Array<{ apiKey: string; target: string }> = [];
  const judged: string[] = [];
  const deps: ConversationDeps = {
    store, webSearch: false,
    selfId: () => SELF, botName: () => "bot", now: () => now,
    fetchBefore: async () => [],
    sendReply: async (_c, _r, content) => void replies.push(content),
    sendDm: async (userId) => void dms.push(userId),
    typing: async () => undefined,
    makeReader: () => ({ messagesRead: 0 }) as unknown as Reader,
    respond: async (input) => {
      responded.push({ apiKey: input.apiKey, target: input.target });
      return opts.respond ? opts.respond(input) : { text: "answer", progress: 0, turns: 1, toolCalls: [] };
    },
    judge: async (input) => {
      judged.push(input.apiKey);
      return opts.judge ?? { addressed: true, confidence: 0.9 };
    },
    log: () => undefined,
  };
  return { conv: new Conversations(deps), store, replies, dms, responded, judged, advance: (ms: number) => (now += ms) };
}

test("ignores ordinary messages while asleep", async () => {
  const t = setup();
  await t.conv.handle(message("1", "1", "hello"));
  assert.equal(t.replies.length, 0);
  assert.equal(t.judged.length, 0);
});

test("a mention wakes the bot and replies with the speaker's key", async () => {
  const t = setup();
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  assert.deepEqual(t.replies, ["answer"]);
  assert.equal(t.responded[0]!.apiKey, "sk-ant-key-for-1");
  assert.equal(t.store.getConversation("10")!.startedBy, "1");
});

test("while awake, other members are judged with the waker's key and answered with their own", async () => {
  const t = setup();
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  await t.conv.handle(message("2", "2", "and what about roles?"));
  assert.deepEqual(t.judged, ["sk-ant-key-for-1"]);
  assert.equal(t.responded[1]!.apiKey, "sk-ant-key-for-2");
});

test("low-confidence or negative judgements stay quiet", async () => {
  const t = setup({ judge: { addressed: true, confidence: 0.5 } });
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  await t.conv.handle(message("2", "2", "lol"));
  assert.equal(t.replies.length, 1);
});

test("falls asleep after five quiet minutes", async () => {
  const t = setup();
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  t.advance(SESSION_MS + 1);
  await t.conv.handle(message("2", "2", "still there?"));
  assert.equal(t.judged.length, 0);
  assert.equal(t.replies.length, 1);
});

test("unregistered speakers are never judged and get one DM per session on mention", async () => {
  const t = setup();
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  await t.conv.handle(message("2", "3", "what is this bot"));
  await t.conv.handle(message("3", "3", "<@999> hello?", { mentions: [mention] }));
  await t.conv.handle(message("4", "3", "<@999> hello??", { mentions: [mention] }));
  assert.equal(t.judged.length, 0);
  assert.deepEqual(t.dms, ["3"]);
  assert.equal(t.replies.length, 1);
});

test("a refused DM is ignored", async () => {
  const t = setup();
  t.conv.deps.sendDm = async () => { throw new Error("Cannot send messages to this user"); };
  await t.conv.handle(message("1", "3", "<@999> hi", { mentions: [mention] }));
  assert.equal(t.replies.length, 0);
});

test("replies to the bot count as addressed without judging", async () => {
  const t = setup();
  const botMessage = message("0", SELF, "earlier answer");
  await t.conv.handle(message("1", "2", "thanks, and roles?", { referenced_message: botMessage }));
  assert.equal(t.judged.length, 0);
  assert.equal(t.replies.length, 1);
});

test("other bots are ignored", async () => {
  const t = setup();
  await t.conv.handle(message("1", "5", "<@999>", { mentions: [mention], author: { id: "5", username: "b", discriminator: "0", global_name: null, avatar: null, bot: true } }));
  assert.equal(t.replies.length, 0);
});

test("long replies are split under Discord's limit", () => {
  const chunks = splitForDiscord("a".repeat(1500) + "\n" + "b".repeat(1500));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 2000));
});

test("judgements parse defensively", () => {
  assert.deepEqual(parseJudgement('{"addressed": true, "confidence": 0.8}'), { addressed: true, confidence: 0.8 });
  assert.deepEqual(parseJudgement('結果: {"addressed": false, "confidence": 3}'), { addressed: false, confidence: 1 });
  assert.equal(parseJudgement("yes"), null);
  assert.equal(parseJudgement('{"addressed": "yes"}'), null);
});

test("the setup notice points to /llm", () => {
  assert.match(SETUP_NOTICE, /\/llm/);
});

test("the model's <next> lines split a reply into separate posts", () => {
  assert.deepEqual(splitForDiscord("了解です\n<next>\n調べてみますね"), ["了解です", "調べてみますね"]);
  assert.deepEqual(splitForDiscord("一つだけ"), ["一つだけ"]);
  assert.deepEqual(splitForDiscord("a\n<next>\n\n<next>\nb"), ["a", "b"], "empty parts are dropped");
});

test("style samples keep only human messages, while the transcript keeps everything", () => {
  const human = message("1", "3", "おはよう");
  const bot = message("2", "999", "長い長いBotの返答".repeat(50), { author: { id: "999", username: "bot", discriminator: "0", global_name: null, avatar: null, bot: true } });
  const hook = message("3", "4", "webhookの投稿", { webhook_id: "77" });
  const empty = message("4", "3", "   ");
  assert.deepEqual(styleSamples([human, bot, hook, empty]), ["おはよう"]);
});

test("progress goes out while the agent works, and the answer follows", async () => {
  const t = setup({
    respond: async (input) => {
      await input.onProgress!("ロールを調べます");
      return { text: "answer", progress: 1, turns: 2, toolCalls: ["list_channels"] };
    },
  });
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  assert.deepEqual(t.replies, ["ロールを調べます", "answer"]);
});

test("nothing more is posted when progress already said it all", async () => {
  const t = setup({
    respond: async (input) => {
      await input.onProgress!("変更案を出します");
      return { text: "", progress: 1, turns: 2, toolCalls: ["propose_plan"] };
    },
  });
  await t.conv.handle(message("1", "1", "<@999> hi", { mentions: [mention] }));
  assert.deepEqual(t.replies, ["変更案を出します"]);
});

test("the speaker's follow-ups and edits reach the answer being worked on", async () => {
  const delivered: string[] = [];
  let finish!: () => void;
  const working = new Promise<void>((resolve) => (finish = resolve));
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const t = setup({
    respond: async (input) => {
      input.inbox!.open((text) => delivered.push(text));
      started();
      await working;
      input.inbox!.close();
      return { text: "answer", progress: 0, turns: 1, toolCalls: [] };
    },
  });
  const first = t.conv.handle(message("1", "1", "<@999> 一覧を", { mentions: [mention] }));
  await ready;
  await t.conv.handle(message("2", "1", "あとロールも"));
  t.conv.edited(message("1", "1", "<@999> チャンネル一覧を"));
  // Someone else's edit, or an edit to an unrelated message, is not passed on.
  t.conv.edited(message("1", "2", "x"));
  t.conv.edited(message("7", "1", "y"));
  finish();
  await first;
  assert.equal(t.responded.length, 1);
  assert.equal(delivered.length, 2);
  assert.match(delivered[0]!, /^\[追いコメント\].*あとロールも/);
  assert.match(delivered[1]!, /^\[編集\].*チャンネル一覧を/);
  assert.deepEqual(t.replies, ["answer"]);

  // Once the answer is out, a new message is a new turn.
  await t.conv.handle(message("3", "1", "ありがとう"));
  assert.equal(t.responded.length, 2);
});
