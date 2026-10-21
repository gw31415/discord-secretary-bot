import { Client, GatewayDispatchEvents, GatewayIntentBits } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import type { APIMessage } from "discord-api-types/v10";
import { judgeAddressed } from "./agent/judge.ts";
import { respond } from "./agent/respond.ts";
import { loadConfig } from "./config.ts";
import { Conversations, MAX_MESSAGES_PER_REPLY } from "./conversation.ts";
import { Store } from "./db.ts";
import { GuildCache } from "./discord/cache.ts";
import { registerCommands } from "./discord/commands.ts";
import { Reader } from "./discord/reader.ts";
import { handleInteraction } from "./interactions.ts";

const config = loadConfig();
const store = new Store(config.dbPath, config.masterKey);
const cache = new GuildCache(config.guildId);

const rest = new REST({ version: "10" }).setToken(config.discordToken);
const gateway = new WebSocketManager({
  token: config.discordToken,
  rest,
  intents:
    GatewayIntentBits.Guilds |
    GatewayIntentBits.GuildMembers |
    GatewayIntentBits.GuildMessages |
    GatewayIntentBits.MessageContent,
});
const client = new Client({ rest, gateway });

let selfId = "";
let botName = "Bot";

function log(message: string, error?: unknown): void {
  const time = new Date().toISOString();
  if (error) console.error(`${time} ${message}`, error);
  else console.log(`${time} ${message}`);
}

const conversations = new Conversations({
  store,
  guildId: config.guildId,
  selfId: () => selfId,
  botName: () => botName,
  now: () => Date.now(),
  webSearch: process.env.WEB_SEARCH !== "off",
  fetchBefore: (channelId, beforeId, limit) => client.api.channels.getMessages(channelId, { before: beforeId, limit }),
  sendReply: async (channelId, replyToId, content) => {
    await client.api.channels.createMessage(channelId, {
      content,
      message_reference: { message_id: replyToId, fail_if_not_exists: false },
      // Never ping anyone from model output.
      allowed_mentions: { parse: [], replied_user: false },
    });
  },
  sendDm: async (userId, content) => {
    const dm = await client.api.users.createDM(userId);
    await client.api.channels.createMessage(dm.id, { content, allowed_mentions: { parse: [] } });
  },
  typing: (channelId) => client.api.channels.showTyping(channelId),
  makeReader: (scope) => new Reader(rest, cache, selfId, scope, { maxMessages: MAX_MESSAGES_PER_REPLY }),
  respond,
  judge: judgeAddressed,
  log,
});

client.once(GatewayDispatchEvents.Ready, ({ data }) => {
  selfId = data.user.id;
  botName = data.user.global_name ?? data.user.username;
  log(`${data.user.username} としてログインしました`);
  if (!data.guilds.some((g) => g.id === config.guildId)) {
    log(`Botがサーバー ${config.guildId} に参加していません。招待されると自動で準備します`);
  }
});

// Registering on GUILD_CREATE (not READY) also covers the bot being invited while running.
client.on(GatewayDispatchEvents.GuildCreate, async ({ data, api }) => {
  if (data.id !== config.guildId) return;
  cache.loadGuild(data);
  try {
    const changed = await registerCommands(api, store, config.applicationId, config.guildId);
    log(changed ? "ギルドコマンドを登録しました" : "ギルドコマンドは変更なし");
  } catch (e) {
    log("ギルドコマンドの登録に失敗", e);
  }
  // GUILD_CREATE only carries some members; fetch the rest for audience checks.
  try {
    for await (const { members } of client.requestGuildMembersIterator({ guild_id: data.id, query: "", limit: 0 })) {
      for (const m of members) if (m.user) cache.upsertMember({ ...m, user: m.user });
    }
    log(`メンバー ${cache.guild?.members.size ?? 0} 人を読み込みました`);
  } catch (e) {
    log("メンバー一覧の取得に失敗", e);
  }
});

client.on(GatewayDispatchEvents.GuildUpdate, ({ data }) => {
  if (data.id === config.guildId) cache.setOwner(data.owner_id);
});
client.on(GatewayDispatchEvents.GuildRoleCreate, ({ data }) => cache.upsertRole(data.role));
client.on(GatewayDispatchEvents.GuildRoleUpdate, ({ data }) => cache.upsertRole(data.role));
client.on(GatewayDispatchEvents.GuildRoleDelete, ({ data }) => cache.deleteRole(data.role_id));
client.on(GatewayDispatchEvents.ChannelCreate, ({ data }) => cache.upsertChannel(data));
client.on(GatewayDispatchEvents.ChannelUpdate, ({ data }) => cache.upsertChannel(data));
client.on(GatewayDispatchEvents.ChannelDelete, ({ data }) => cache.deleteChannel(data.id));
client.on(GatewayDispatchEvents.ThreadCreate, ({ data }) => cache.upsertChannel(data));
client.on(GatewayDispatchEvents.ThreadUpdate, ({ data }) => cache.upsertChannel(data));
client.on(GatewayDispatchEvents.ThreadDelete, ({ data }) => cache.deleteChannel(data.id));
client.on(GatewayDispatchEvents.ThreadListSync, ({ data }) => {
  for (const thread of data.threads) cache.upsertChannel(thread);
});
client.on(GatewayDispatchEvents.GuildMemberAdd, ({ data }) => {
  if (data.guild_id === config.guildId && data.user) cache.upsertMember({ ...data, user: data.user });
});
client.on(GatewayDispatchEvents.GuildMemberUpdate, ({ data }) => {
  if (data.guild_id === config.guildId) cache.upsertMember(data);
});
client.on(GatewayDispatchEvents.GuildMemberRemove, ({ data }) => {
  if (data.guild_id === config.guildId) cache.deleteMember(data.user.id);
});

client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
  if (data.guild_id !== config.guildId || !cache.guild) return;
  // The message carries the author's current roles; keep the cache fresh with them.
  if (data.member && !data.author.bot) cache.upsertMember({ roles: data.member.roles, user: data.author });
  void conversations.handle(data as APIMessage);
});

client.on(GatewayDispatchEvents.InteractionCreate, async ({ data, api }) => {
  try {
    await handleInteraction(api, store, config.guildId, data);
  } catch (e) {
    log("インタラクションの処理に失敗", e);
  }
});

const sweeper = setInterval(() => conversations.sweep(), 60_000);

async function shutdown(signal: string): Promise<void> {
  log(`${signal} を受けたので停止します`);
  clearInterval(sweeper);
  await gateway.destroy();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await gateway.connect();
