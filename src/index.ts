import { Client, GatewayDispatchEvents, GatewayIntentBits } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { PresenceUpdateStatus } from "discord-api-types/v10";
import { judgeAddressed, judgePublicReply } from "./agent/judge.ts";
import { chooseReaction } from "./agent/react.ts";
import { respond } from "./agent/respond.ts";
import { summarizeCode } from "./agent/summarize.ts";
import { loadConfig } from "./config.ts";
import { Conversations, MAX_MESSAGES_PER_REPLY } from "./conversation.ts";
import type { GuildMessage, ReactionAdd } from "./conversation.ts";
import { Store } from "./db.ts";
import { GuildCaches } from "./discord/cache.ts";
import { registerCommands } from "./discord/commands.ts";
import { Presence } from "./discord/presence.ts";
import { Reader } from "./discord/reader.ts";
import { WidenPrompts } from "./discord/widen.ts";
import type { ReadScope } from "./discord/reader.ts";
import { handleInteraction } from "./interactions.ts";
import { findChatModel, findJudgeModel } from "./llm/models.ts";
import { Planner, SNAPSHOT_RETENTION_MS } from "./plan/service.ts";
import { RuleAdmin } from "./rules/admin.ts";
import { RuleEngine } from "./rules/engine.ts";
import { RuleService } from "./rules/service.ts";
import { TRIGGER_INTENTS, TRIGGERS } from "./rules/triggers.ts";

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
    GatewayIntentBits.MessageContent |
    TRIGGER_INTENTS,
  // Asleep until someone talks to it.
  initialPresence: { status: PresenceUpdateStatus.Idle, activities: [], since: null, afk: true },
});
const client = new Client({ rest, gateway });

const presence = new Presence({
  awakeUntil: (now) => store.awakeUntil(now),
  send: async (data) => {
    for (const shardId of await gateway.getShardIds()) await client.updatePresence(shardId, data);
  },
  now: () => Date.now(),
  log,
});

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
  onWrite: (plan, step, response) => {
    caches.get(plan.guildId)?.applyWrite(step.op, step.pathParams, response);
    engine.noteWrite(plan, step, response);
  },
  rules: {
    prepare: (input) => rules.prepare(input),
    register: (guildId, ownerId, draft) => rules.register(guildId, ownerId, draft),
  },
});

function makeReader(scope: ReadScope): Reader {
  const cache = caches.get(scope.guildId);
  if (!cache) throw new Error(`サーバー ${scope.guildId} の情報をまだ受信していません`);
  return new Reader(rest, cache, selfId, scope, { maxMessages: MAX_MESSAGES_PER_REPLY });
}

async function sendDm(userId: string, content: string): Promise<void> {
  const dm = await client.api.users.createDM(userId);
  await client.api.channels.createMessage(dm.id, { content, allowed_mentions: { parse: [] } });
}

// Custom slash commands follow the rules; changes close together register once.
const commandSyncs = new Map<string, ReturnType<typeof setTimeout>>();
function syncCommands(guildId: string): void {
  clearTimeout(commandSyncs.get(guildId));
  commandSyncs.set(
    guildId,
    setTimeout(() => {
      commandSyncs.delete(guildId);
      registerCommands(client.api, store, config.applicationId, guildId)
        .then((changed) => changed && log(`${guildId}: ルールの変更に合わせてギルドコマンドを登録し直しました`))
        .catch((e) => log(`${guildId}: ギルドコマンドの登録に失敗`, e));
    }, 2_000),
  );
}

const engine = new RuleEngine({
  store,
  caches,
  planner,
  selfId: () => selfId,
  now: () => Date.now(),
  makeReader,
  notifyOwner: sendDm,
  onRulesChanged: syncCommands,
  log,
});
const admin = new RuleAdmin({ store, caches, selfId: () => selfId, now: () => Date.now(), onChange: syncCommands });
const rules = new RuleService({
  api: client.api,
  store,
  caches,
  admin,
  engine,
  selfId: () => selfId,
  now: () => Date.now(),
  log,
  summarize: async (code, ownerId, trigger) => {
    const ref = store.getSettings(ownerId).response;
    const model = ref && findChatModel(ref.provider, ref.model);
    const apiKey = ref && store.getApiKey(ownerId, ref.provider);
    if (!model || !apiKey) return null;
    return summarizeCode({ model, apiKey, code, subject: { kind: "rule", trigger } });
  },
  decideVisibility: async ({ ownerId, command, options, reply, images, steps }) => {
    const ref = store.getSettings(ownerId).judge;
    const model = ref && findJudgeModel(ref.provider, ref.model);
    const apiKey = ref && store.getApiKey(ownerId, ref.provider);
    if (!model || !apiKey) return false;
    return judgePublicReply({ model, apiKey, command, options, reply, images, steps, signal: AbortSignal.timeout(10_000) });
  },
});

const widenPrompts = new WidenPrompts(client.api);

const conversations = new Conversations({
  store,
  selfId: () => selfId,
  botName: () => botName,
  now: () => Date.now(),
  webSearch: process.env.WEB_SEARCH !== "off",
  fetchBefore: (channelId, beforeId, limit) => client.api.channels.getMessages(channelId, { before: beforeId, limit }),
  sendReply: async (channelId, replyToId, content, files) => {
    await client.api.channels.createMessage(channelId, {
      ...(content ? { content } : {}),
      ...(files?.length ? { files } : {}),
      ...(replyToId ? { message_reference: { message_id: replyToId, fail_if_not_exists: false } } : {}),
      // Never ping anyone from model output.
      allowed_mentions: { parse: [], replied_user: false },
    });
  },
  sendDm,
  typing: (channelId) => client.api.channels.showTyping(channelId),
  makeReader: (scope) => makeReader(scope),
  respond,
  judge: judgeAddressed,
  // The bot's own way of answering, like a reply post: not a change to the server, so no plan.
  react: async (channelId, messageId, emoji) => {
    await client.api.channels.addMessageReaction(channelId, messageId, emoji);
  },
  chooseReaction,
  fetchMessage: (channelId, messageId) => client.api.channels.getMessage(channelId, messageId),
  propose: (input) => planner.propose(input),
  rules: {
    list: (guildId, ownerId, shareable) => rules.rulesFor(guildId, ownerId, shareable),
    runs: (guildId, ownerId, ruleId, shareable, limit) => rules.runsFor(guildId, ownerId, ruleId, shareable, limit),
  },
  askWiden: (input) => widenPrompts.ask(input),
  onAwake: () => presence.refresh(),
  log,
});

// Every (re)connection starts from the initial presence, so the status is sent again.
client.on(GatewayDispatchEvents.Ready, () => {
  presence.reset();
  presence.refresh();
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
  // After the members, so the owners' permissions are known.
  try {
    engine.dispatch("BOT_READY", data.id, { guild_id: data.id });
  } catch (e) {
    log(`${data.name}: BOT_READY のルールの振り分けに失敗`, e);
  }
});

client.on(GatewayDispatchEvents.GuildDelete, ({ data }) => {
  // An outage also sends GUILD_DELETE (with unavailable), followed by a fresh GUILD_CREATE.
  caches.delete(data.id);
  if (!data.unavailable) log(`サーバー ${data.id} から退出しました`);
});

client.on(GatewayDispatchEvents.GuildUpdate, ({ data }) => {
  const cache = caches.get(data.id);
  cache?.setOwner(data.owner_id);
  for (const role of data.roles) cache?.upsertRole(role);
});
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
client.on(GatewayDispatchEvents.GuildMemberRemove, ({ data }) => {
  caches.get(data.guild_id)?.deleteMember(data.user.id);
  engine.ownerLeft(data.guild_id, data.user.id);
});

client.on(GatewayDispatchEvents.VoiceStateUpdate, ({ data }) => {
  // Rules are told where the user was before; the payload only says where they are now.
  const before = caches.get(data.guild_id)?.setVoice(data.user_id, data.channel_id) ?? null;
  (data as typeof data & { before_channel_id: string | null }).before_channel_id = before;
});

// Rules see each event after the cache has taken it in (listeners run in the order added).
for (const [event, spec] of Object.entries(TRIGGERS)) {
  if (spec.synthetic) continue;
  client.on(event as GatewayDispatchEvents.MessageCreate, ({ data }) => {
    const payload = data as unknown as Record<string, unknown>;
    const guildId = spec.guildId ? spec.guildId(payload) : ((payload.guild_id as string | undefined) ?? undefined);
    if (!served(guildId)) return;
    try {
      engine.dispatch(event, guildId, payload);
    } catch (e) {
      log(`ルールの振り分けに失敗 (${event})`, e);
    }
  });
}

client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
  const cache = caches.get(data.guild_id);
  if (!cache?.guild) return; // DMs and servers not (yet) served
  // The message carries the author's current roles; keep the cache fresh with them.
  if (data.member && !data.author.bot) cache.upsertMember({ roles: data.member.roles, user: data.author });
  void conversations.handle(data as GuildMessage);
});

client.on(GatewayDispatchEvents.MessageReactionAdd, ({ data }) => {
  if (!served(data.guild_id) || !caches.get(data.guild_id)?.guild) return;
  void conversations.reacted(data as ReactionAdd);
});

client.on(GatewayDispatchEvents.MessageUpdate, ({ data }) => {
  if (!data.guild_id || !caches.get(data.guild_id)?.guild) return;
  conversations.edited(data);
});

client.on(GatewayDispatchEvents.InteractionCreate, async ({ data, api }) => {
  if (!caches.get(data.guild_id)) return;
  try {
    if (await widenPrompts.handleInteraction(data)) return;
    if (await planner.handleInteraction(data)) return;
    if (await rules.handleCommand(data)) return;
    if (await rules.handleCustomCommand(data)) return;
    if (await rules.handleInteraction(data)) return;
    await handleInteraction(api, store, data);
  } catch (e) {
    log("インタラクションの処理に失敗", e);
  }
});

function guildOf(channel: object): string | undefined {
  return "guild_id" in channel ? (channel.guild_id as string | undefined) : undefined;
}

// SCHEDULE rules: checked at the start of every minute.
let scheduler: ReturnType<typeof setTimeout> | undefined;
function scheduleTick(): void {
  scheduler = setTimeout(() => {
    try {
      engine.tick(caches.ids());
    } catch (e) {
      log("時刻のルールの振り分けに失敗", e);
    }
    scheduleTick();
  }, 60_000 - (Date.now() % 60_000) + 50);
}
scheduleTick();

const sweeper = setInterval(() => {
  conversations.sweep();
  planner.sweep().catch((e) => log("変更の期限処理に失敗", e));
  engine.sweep();
  store.deleteRuleRunsBefore(new Date(Date.now() - SNAPSHOT_RETENTION_MS));
}, 60_000);

async function shutdown(signal: string): Promise<void> {
  log(`${signal} を受けたので停止します`);
  clearInterval(sweeper);
  clearTimeout(scheduler);
  presence.stop();
  await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 10_000))]);
  await gateway.destroy();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Plans a restart cut off are marked failed (and can be resumed) before anything else runs.
await planner.recover().catch((e) => log("中断された変更の後始末に失敗", e));
await gateway.connect();
