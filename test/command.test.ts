import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, PermissionFlagsBits as P } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { COMMANDS, guildCommands, registerCommands, registerGlobalCommands } from "../src/discord/commands.ts";
import { RuleAdmin } from "../src/rules/admin.ts";
import { commandEvent, commandJson, commandProblems, sampleCommandEvent } from "../src/rules/command.ts";
import type { CommandSpec } from "../src/rules/command.ts";
import { RuleEngine } from "../src/rules/engine.ts";
import { RuleService } from "../src/rules/service.ts";
import { triggerProblems } from "../src/rules/triggers.ts";
import { DEFAULT_LIMITS } from "../src/rules/types.ts";
import type { RuleDefinition } from "../src/rules/types.ts";
import { GUILD, makeGuild, SELF } from "./helpers.ts";

const SPEC: CommandSpec = {
  name: "announce",
  description: "お知らせを投稿する",
  options: [
    { name: "text", description: "本文", type: "string", required: true },
    { name: "where", description: "投稿先", type: "channel" },
  ],
};

test("a command's shape is checked and turned into what Discord registers", () => {
  assert.deepEqual(commandProblems(SPEC), []);
  assert.match(commandProblems({ ...SPEC, name: "Announce" }).join(), /小文字/);
  assert.match(commandProblems({ ...SPEC, name: "rules" }).join(), /Botが使っています/);
  assert.match(commandProblems(SPEC, new Set(["announce"])).join(), /別のルール/);
  assert.match(commandProblems({ ...SPEC, options: [SPEC.options![1]!, SPEC.options![0]!] }).join(), /前に置いて/);
  assert.match(commandProblems({ ...SPEC, options: [{ name: "n", description: "d", type: "boolean", choices: [{ name: "a", value: "a" }] }] }).join(), /choices/);
  assert.match(commandProblems({ ...SPEC, permissions: ["Nope"] }).join(), /権限 Nope/);
  assert.match(commandProblems({ ...SPEC, visibility: "everyone" as never }).join(), /visibility/);

  const json = commandJson({ ...SPEC, permissions: ["ManageChannels"] });
  assert.equal(json.type, ApplicationCommandType.ChatInput);
  assert.equal(json.default_member_permissions, P.ManageChannels.toString());
  assert.deepEqual(json.options!.map((o) => [o.name, o.type, o.required]), [["text", ApplicationCommandOptionType.String, true], ["where", ApplicationCommandOptionType.Channel, false]]);
  assert.equal(commandJson(SPEC).default_member_permissions, undefined);
});

test("COMMAND must be the rule's only trigger and needs a command", () => {
  assert.deepEqual(triggerProblems({ event: "COMMAND", command: SPEC }), []);
  assert.match(triggerProblems({ event: "COMMAND" }).join(), /command/);
  assert.match(triggerProblems({ event: "COMMAND", events: ["MESSAGE_CREATE"], command: SPEC }).join(), /COMMAND/);
  assert.match(triggerProblems({ event: "MESSAGE_CREATE", command: SPEC }).join(), /command/);
});

test("the event carries who ran it and the option values; the dry run fills in stand-ins", () => {
  const event = commandEvent(interaction({ text: "hi", where: "10" }));
  assert.deepEqual(event.options, { text: "hi", where: "10" });
  assert.equal((event.user as { id: string }).id, "3");
  assert.equal(event.channel_id, "10");
  const sample = sampleCommandEvent(SPEC, GUILD, "10", { userId: "1", roleIds: [], bot: false }, undefined);
  assert.deepEqual(sample.options, { text: "test" });
  assert.deepEqual(sampleCommandEvent(SPEC, GUILD, "10", undefined, { options: { text: "x", where: "12" } }).options, { text: "x", where: "12" });
});

function interaction(options: Record<string, string>, permissions = P.SendMessages) {
  return {
    id: "i1",
    token: "tok",
    application_id: "app",
    type: InteractionType.ApplicationCommand,
    guild_id: GUILD,
    channel: { id: "10" },
    member: { user: { id: "3", username: "member" }, roles: [], permissions: permissions.toString() },
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "announce",
      options: Object.entries(options).map(([name, value]) => ({ name, value, type: ApplicationCommandOptionType.String })),
    },
  } as never;
}

function world(visibilityScore?: (input: any) => Promise<number | null>) {
  const store = new Store(":memory:", randomBytes(32));
  const cache = new GuildCache(GUILD);
  cache.guild = makeGuild();
  const caches = { get: (id: string | undefined) => (id === GUILD ? cache : undefined) };
  const admin = new RuleAdmin({ store, caches, selfId: () => SELF, now: () => 1_000_000 });
  const runs: any[] = [];
  const readers: any[] = [];
  let code: (bindings: any) => any = (b) => (b.reply("こんにちは"), { ok: true, value: { steps: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: b.event.options.text } }] }, logs: [] });
  const engine = new RuleEngine({
    store,
    caches,
    planner: { runForRule: async (input) => (runs.push(input), { plan: { id: "p1" }, status: "succeeded", reason: null }) as never },
    selfId: () => SELF,
    now: () => 1_000_000,
    makeReader: (input: unknown) => (readers.push(input), { get: async () => null }) as never,
    notifyOwner: async () => {},
    log: () => {},
    run: async (_code, bindings) => code(bindings),
  });
  const calls: Array<[string, unknown]> = [];
  const api = {
    interactions: {
      reply: async (_id: string, _t: string, body: unknown) => void calls.push(["reply", body]),
      defer: async (_id: string, _t: string, body: unknown) => void calls.push(["defer", body]),
      editReply: async (_a: string, _t: string, body: unknown) => void calls.push(["edit", body]),
      followUp: async (_a: string, _t: string, body: unknown) => void calls.push(["followUp", body]),
      updateMessage: async (_id: string, _t: string, body: unknown) => void calls.push(["update", body]),
      deleteReply: async () => void calls.push(["delete", null]),
    },
    applicationCommands: { bulkOverwriteGuildCommands: async (_a: string, _g: string, body: unknown) => void calls.push(["register", body]), bulkOverwriteGlobalCommands: async (_a: string, body: unknown) => void calls.push(["global", body]) },
  } as never;
  const service = new RuleService({ api, store, caches, admin, engine, selfId: () => SELF, now: () => 1_000_000, log: () => {}, ...(visibilityScore ? { visibilityScore } : {}) });
  const definition: RuleDefinition = {
    name: "お知らせ",
    sourcePrompt: "/announce で投稿",
    trigger: { event: "COMMAND", command: SPEC },
    allow: [{ op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } } }],
    code: "",
    summary: null,
    limits: DEFAULT_LIMITS,
  };
  return { store, admin, engine, service, runs, readers, calls, definition, setCode: (f: typeof code) => (code = f), api };
}

test("running the command runs the rule as its owner and replies with what the code said", async () => {
  const w = world();
  w.admin.save(GUILD, "1", w.definition);
  assert.equal(await w.service.handleCustomCommand(interaction({ text: "お知らせです" })), true);
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].ownerId, "1");
  assert.deepEqual(w.runs[0].drafts?.[0]?.body ?? w.runs[0].steps?.[0]?.body, { content: "お知らせです" });
  // Reads are limited to what the channel's viewers may see, as the owner.
  assert.deepEqual([w.readers.at(-1).speakerId, w.readers.at(-1).audience, w.readers.at(-1).channelId], ["1", "channel", "10"]);
  const [defer, edit] = w.calls;
  assert.equal(defer![0], "defer");
  assert.ok((defer![1] as { flags?: number }).flags); // only the person who ran it sees the reply
  assert.match((edit![1] as { content: string }).content, /こんにちは/);
});

test("a command needs its permissions, an enabled rule, and a name nobody else uses", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, permissions: ["ManageChannels"] } } });
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(w.runs.length, 0);
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /ManageChannels/);
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.ManageChannels));
  assert.equal(w.runs.length, 1);

  assert.throws(() => w.admin.save(GUILD, "2", w.definition), /announce/);
  w.admin.setEnabled(GUILD, "1", rule.id, false);
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.ManageChannels));
  assert.equal(w.runs.length, 1);
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /今は使えません/);
  // Reserved names are left to the bot's own handlers.
  assert.equal(await w.service.handleCustomCommand({ ...(interaction({}) as object), data: { type: ApplicationCommandType.ChatInput, name: "rules" } } as never), false);
});

test("a command that only replies needs no allowed operations", async () => {
  const w = world();
  w.setCode((b) => (b.reply("今日は晴れ"), { ok: true, value: null, logs: [] }));
  w.admin.save(GUILD, "1", { ...w.definition, allow: [] });
  assert.throws(() => w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "MESSAGE_CREATE" }, allow: [] }), /1つもありません/);
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(w.runs.length, 0);
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /今日は晴れ/);
});

test("enabled command rules are the server's guild commands; /settings and /rules are global", async () => {
  const w = world();
  assert.deepEqual(guildCommands(w.store, GUILD), []);
  const rule = w.admin.save(GUILD, "1", w.definition);
  assert.deepEqual(guildCommands(w.store, GUILD).map((c) => c.name), ["announce"]);
  assert.equal(await registerCommands(w.api, w.store, "app", GUILD), true);
  assert.equal(await registerCommands(w.api, w.store, "app", GUILD), false);
  w.admin.setEnabled(GUILD, "1", rule.id, false);
  assert.equal(await registerCommands(w.api, w.store, "app", GUILD), true);
  assert.deepEqual(w.calls.at(-1)![1], []);
  assert.deepEqual(COMMANDS.map((c) => c.name), ["settings", "rules"]);
  assert.ok(COMMANDS.every((c) => JSON.stringify(c.contexts) === "[0]"), "server-only");
  assert.equal(await registerGlobalCommands(w.api, w.store, "app"), true);
  assert.equal(await registerGlobalCommands(w.api, w.store, "app"), false);
});

test("by default the owner's judge model decides who sees the reply; failures and errors stay private", async () => {
  const asked: any[] = [];
  let verdict: () => Promise<number> = async () => 0.9;
  const w = world(async (input) => (asked.push(input), verdict()));
  w.admin.save(GUILD, "1", w.definition);
  await w.service.handleCustomCommand(interaction({ text: "お知らせです" }));
  assert.deepEqual(asked.map((a) => [a.ownerId, a.command.name, a.options.text, a.reply, a.steps]), [["1", "announce", "お知らせです", "こんにちは", 1]]);
  // Starts private, then moves to a public follow-up.
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "followUp", "delete"]);
  assert.ok((w.calls[0]![1] as { flags?: number }).flags);
  assert.match((w.calls[1]![1] as { content: string }).content, /こんにちは/);

  w.calls.length = 0;
  verdict = async () => { throw new Error("down"); };
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "edit"]);

  // A failed run is not judged.
  w.calls.length = 0;
  w.setCode((b) => (b.reply("途中まで"), { ok: false, error: "boom", logs: [] }));
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(asked.length, 2);
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "edit"]);
});

test("a fixed visibility is used as is, without asking the judge", async () => {
  const asked: any[] = [];
  const w = world(async (input) => (asked.push(input), 1));
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, visibility: "public" } } });
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "edit"]);
  assert.equal((w.calls[0]![1] as { flags?: number }).flags, undefined);
  w.admin.remove(GUILD, "1", rule.id);
  w.calls.length = 0;
  w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, visibility: "private" } } });
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "edit"]);
  assert.ok((w.calls[0]![1] as { flags?: number }).flags);
  assert.equal(asked.length, 0);
});

test("a command's code can make images for its reply and its posts", async () => {
  const w = world();
  w.setCode(async (b) => {
    const id = await b.media.math("x^2", {}, "eq");
    b.reply(`式: ${id}`);
    return { ok: true, value: { steps: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { files: [id] } }] }, logs: [] };
  });
  w.admin.save(GUILD, "1", w.definition);
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  const edit = w.calls.at(-1)![1] as { content: string; files?: Array<{ name: string; data: Buffer }> };
  assert.match(edit.content, /式: img1/);
  assert.deepEqual(edit.files!.map((f) => f.name), ["eq.png"]);
  assert.ok(edit.files![0]!.data.length > 100);
  assert.deepEqual(Object.keys(w.runs[0].images), ["img1"]);
  assert.equal(w.runs[0].images.img1.name, "eq.svg");
});

test("the owner changes who sees a command's replies from /rules, keeping the version and the code", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, visibility: "auto" } } });
  const pick = (userId: string, value: string) => ({
    id: "i2", token: "tok", application_id: "app", type: InteractionType.MessageComponent, guild_id: GUILD,
    member: { user: { id: userId }, roles: [], permissions: "0" },
    data: { custom_id: `rule:visibility:${rule.id}`, component_type: 3, values: [value] },
  }) as never;
  await w.service.handleInteraction(pick("2", "public"));
  assert.equal(w.store.getRule(rule.id)!.trigger.command!.visibility, "auto");
  await w.service.handleInteraction(pick("1", "public"));
  const after = w.store.getRule(rule.id)!;
  assert.equal(after.trigger.command!.visibility, "public");
  assert.equal(after.version, rule.version);
  assert.equal(after.code, rule.code);
  const view = JSON.stringify(w.calls.at(-1)![1]);
  assert.match(view, /返事を全員に見せる」にしました/);
  assert.throws(() => w.admin.setVisibility(GUILD, "1", rule.id, "everyone" as never), /選べない/);
});

test("a rule's panel opens on a short summary; allow, code and runs are pages in one menu", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", w.definition);
  const press = (action: string, values?: string[]) => ({
    id: "i3", token: "tok", application_id: "app", type: InteractionType.MessageComponent, guild_id: GUILD,
    member: { user: { id: "1" }, roles: [], permissions: "0" },
    data: { custom_id: `rule:${action}:${action === "open" && values ? "" : rule.id}`, component_type: values ? 3 : 2, ...(values ? { values } : {}) },
  }) as never;
  await w.service.handleInteraction(press("home"));
  const home = JSON.stringify(w.calls.at(-1)![1]);
  assert.doesNotMatch(home, /会話でBotに頼む/);
  await w.service.handleInteraction(press("open", [rule.id]));
  const summary = w.calls.at(-1)![1] as { components: Array<{ components: Array<{ type: number; components?: Array<{ type: number; custom_id?: string; options?: Array<{ value: string }> }> }> }> };
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, /```js/);
  assert.doesNotMatch(text, /許す操作\*\*/);
  const rows = summary.components[0]!.components.filter((c) => c.type === 1);
  for (const r of rows) assert.ok(r.components!.length <= 3, "at most three buttons in a row");
  const menu = rows.flatMap((r) => r.components!).find((c) => c.custom_id === `rule:view:${rule.id}`)!;
  assert.deepEqual(menu.options!.map((o) => o.value), ["summary", "allow", "source", "runs", "delete"]);
  await w.service.handleInteraction(press("view", ["source"]));
  const source = JSON.stringify(w.calls.at(-1)![1]);
  assert.match(source, /```js/);
  assert.match(source, /rule:code:/);
  await w.service.handleInteraction(press("view", ["allow"]));
  assert.match(JSON.stringify(w.calls.at(-1)![1]), /許す操作\*\*/);
  await w.service.handleInteraction(press("view", ["runs"]));
  assert.match(JSON.stringify(w.calls.at(-1)![1]), /最近の実行/);
  await w.service.handleInteraction(press("view", ["delete"]));
  assert.match(JSON.stringify(w.calls.at(-1)![1]), /本当に削除/);
});
