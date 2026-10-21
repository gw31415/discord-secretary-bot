import { Client, GatewayDispatchEvents, GatewayIntentBits } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { judgeAddressed } from "./agent/judge.ts";
import { respond } from "./agent/respond.ts";
import { summarizeCode } from "./agent/summarize.ts";
import { loadConfig } from "./config.ts";
import { Conversations, MAX_MESSAGES_PER_REPLY } from "./conversation.ts";
import type { GuildMessage } from "./conversation.ts";
import { Store } from "./db.ts";
import { GuildCaches } from "./discord/cache.ts";
import { registerCommands } from "./discord/commands.ts";
import { Reader } from "./discord/reader.ts";
import { handleInteraction } from "./interactions.ts";
import { findChatModel } from "./llm/models.ts";
import { Planner } from "./plan/service.ts";

const config = loadConfig();
const store = new Store(config.dbPath, config.masterKey);
const caches = new GuildCaches();

function served(guildId: string | undefined): guildId is string {
  return !!guildId && (config.allowedGuildIds.size === 0 || config.allowedGuildIds.has(guildId));
}

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

const planner = new Planner({
  api: client.api,
  store,
  caches,
  selfId: () => selfId,
  now: () => Date.now(),
  log,
  revise: (input) => conversations.revise(input),
  // The actor's own response model and key, as for their conversation.
  summarize: async (code, actorId) => {
    const ref = store.getSettings(actorId).response;
    const model = ref && findChatModel(ref.provider, ref.model);
    const apiKey = ref && store.getApiKey(actorId, ref.provider);
    if (!model || !apiKey) return null;
    return summarizeCode({ model, apiKey, code });
  },
});

const conversations = new Conversations({
  store,
  selfId: () => selfId,
  botName: () => botName,
  now: () => Date.now(),
  webSearch: process.env.WEB_SEARCH !== "off",
  fetchBefore: (channelId, beforeId, limit) => client.api.channels.getMessages(channelId, { before: beforeId, limit }),
  sendReply: async (channelId, replyToId, content) => {
    await client.api.channels.createMessage(channelId, {
      content,
      ...(replyToId ? { message_reference: { message_id: replyToId, fail_if_not_exists: false } } : {}),
      // Never ping anyone from model output.
      allowed_mentions: { parse: [], replied_user: false },
    });
  },
  sendDm: async (userId, content) => {
    const dm = await client.api.users.createDM(userId);
    await client.api.channels.createMessage(dm.id, { content, allowed_mentions: { parse: [] } });
  },
  typing: (channelId) => client.api.channels.showTyping(channelId),
  makeReader: (scope) => {
    const cache = caches.get(scope.guildId);
    if (!cache) throw new Error(`サーバー ${scope.guildId} の情報をまだ受信していません`);
    return new Reader(rest, cache, selfId, scope, { maxMessages: MAX_MESSAGES_PER_REPLY });
  },
  respond,
  judge: judgeAddressed,
  propose: (input) => planner.propose(input),
  log,
});

client.once(GatewayDispatchEvents.Ready, ({ data }) => {
  selfId = data.user.id;
  botName = data.user.global_name ?? data.user.username;
  log(`${data.user.username} としてログインしました(参加サーバー ${data.guilds.length} 件)`);
});

// Registering on GUILD_CREATE (not READY) also covers the bot being invited while running.
client.on(GatewayDispatchEvents.GuildCreate, async ({ data, api }) => {
  if (!served(data.id)) {
    log(`サーバー ${data.name}(${data.id})は DISCORD_GUILD_IDS にないので使いません`);
    return;
  }
  const cache = caches.load(data);
  try {
    const changed = await registerCommands(api, store, config.applicationId, data.id);
    log(`${data.name}: ${changed ? "ギルドコマンドを登録しました" : "ギルドコマンドは変更なし"}`);
  } catch (e) {
    log(`${data.name}: ギルドコマンドの登録に失敗`, e);
  }
  // GUILD_CREATE only carries some members; fetch the rest for audience checks.
  try {
    for await (const { members } of client.requestGuildMembersIterator({ guild_id: data.id, query: "", limit: 0 })) {
      for (const m of members) if (m.user) cache.upsertMember({ ...m, user: m.user });
    }
    log(`${data.name}: メンバー ${cache.guild?.members.size ?? 0} 人を読み込みました`);
  } catch (e) {
    log(`${data.name}: メンバー一覧の取得に失敗`, e);
  }
});

client.on(GatewayDispatchEvents.GuildDelete, ({ data }) => {
  // An outage also sends GUILD_DELETE (with unavailable), followed by a fresh GUILD_CREATE.
  caches.delete(data.id);
  if (!data.unavailable) log(`サーバー ${data.id} から退出しました`);
});

client.on(GatewayDispatchEvents.GuildUpdate, ({ data }) => caches.get(data.id)?.setOwner(data.owner_id));
client.on(GatewayDispatchEvents.GuildRoleCreate, ({ data }) => caches.get(data.guild_id)?.upsertRole(data.role));
client.on(GatewayDispatchEvents.GuildRoleUpdate, ({ data }) => caches.get(data.guild_id)?.upsertRole(data.role));
client.on(GatewayDispatchEvents.GuildRoleDelete, ({ data }) => caches.get(data.guild_id)?.deleteRole(data.role_id));
client.on(GatewayDispatchEvents.ChannelCreate, ({ data }) => caches.get(guildOf(data))?.upsertChannel(data));
client.on(GatewayDispatchEvents.ChannelUpdate, ({ data }) => caches.get(guildOf(data))?.upsertChannel(data));
client.on(GatewayDispatchEvents.ChannelDelete, ({ data }) => caches.get(guildOf(data))?.deleteChannel(data.id));
client.on(GatewayDispatchEvents.ThreadCreate, ({ data }) => caches.get(data.guild_id)?.upsertChannel(data));
client.on(GatewayDispatchEvents.ThreadUpdate, ({ data }) => caches.get(data.guild_id)?.upsertChannel(data));
client.on(GatewayDispatchEvents.ThreadDelete, ({ data }) => caches.get(data.guild_id)?.deleteChannel(data.id));
client.on(GatewayDispatchEvents.ThreadListSync, ({ data }) => {
  const cache = caches.get(data.guild_id);
  for (const thread of data.threads) cache?.upsertChannel(thread);
});
client.on(GatewayDispatchEvents.GuildMemberAdd, ({ data }) => {
  if (data.user) caches.get(data.guild_id)?.upsertMember({ ...data, user: data.user });
});
client.on(GatewayDispatchEvents.GuildMemberUpdate, ({ data }) => caches.get(data.guild_id)?.upsertMember(data));
client.on(GatewayDispatchEvents.GuildMemberRemove, ({ data }) => caches.get(data.guild_id)?.deleteMember(data.user.id));

client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
  const cache = caches.get(data.guild_id);
  if (!cache?.guild) return; // DMs and servers not (yet) served
  // The message carries the author's current roles; keep the cache fresh with them.
  if (data.member && !data.author.bot) cache.upsertMember({ roles: data.member.roles, user: data.author });
  void conversations.handle(data as GuildMessage);
});

client.on(GatewayDispatchEvents.InteractionCreate, async ({ data, api }) => {
  if (!caches.get(data.guild_id)) return;
  try {
    if (await planner.handleInteraction(data)) return;
    await handleInteraction(api, store, data);
  } catch (e) {
    log("インタラクションの処理に失敗", e);
  }
});

function guildOf(channel: object): string | undefined {
  return "guild_id" in channel ? (channel.guild_id as string | undefined) : undefined;
}

const sweeper = setInterval(() => {
  conversations.sweep();
  planner.sweep().catch((e) => log("変更の期限処理に失敗", e));
}, 60_000);

async function shutdown(signal: string): Promise<void> {
  log(`${signal} を受けたので停止します`);
  clearInterval(sweeper);
  await gateway.destroy();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Plans a restart cut off are marked failed (and can be resumed) before anything else runs.
await planner.recover().catch((e) => log("中断された変更の後始末に失敗", e));
await gateway.connect();
