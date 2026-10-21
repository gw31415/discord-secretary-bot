import { test } from "node:test";
import assert from "node:assert/strict";
import type { REST } from "@discordjs/rest";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { respond } from "../src/agent/respond.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { Reader } from "../src/discord/reader.ts";
import { GUILD, makeGuild, SELF } from "./helpers.ts";

test("the agent calls read tools through the reader and returns its final text", async () => {
  const faux = registerFauxProvider();
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_channels", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read_messages", { channel_id: "11" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("チャンネルは #general です")]),
    ]);
    const rest = {
      get: async (path: string) => {
        if (path === `/guilds/${GUILD}/channels`) return [{ id: "10", type: 0, name: "general" }, { id: "11", type: 0, name: "staff" }];
        throw new Error(`unexpected ${path}`);
      },
    } as unknown as REST;
    const cache = new GuildCache(GUILD);
    cache.guild = makeGuild();
    const reader = new Reader(rest, cache, SELF, { channelId: "10", speakerId: "2" }, { maxMessages: 500 });
    const result = await respond({
      model: faux.getModel(), apiKey: "k", reader, botName: "bot",
      transcript: [], target: "[1] user: チャンネルを教えて", webSearch: false,
    });
    assert.equal(result.text, "チャンネルは #general です");
    assert.deepEqual(result.toolCalls, ["list_channels", "read_messages"]);
    assert.equal(result.turns, 3);
  } finally {
    faux.unregister();
  }
});
