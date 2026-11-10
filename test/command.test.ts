import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, PermissionFlagsBits as P } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { COMMANDS, guildCommands, registerCommands, registerGlobalCommands, SETTINGS_COMMAND_ID, guildCommandIdsKey } from "../src/discord/commands.ts";
import { RuleAdmin } from "../src/rules/admin.ts";
import { commandEvent, commandJson, commandProblems, sampleCommandEvent } from "../src/rules/command.ts";
import type { CommandSpec } from "../src/rules/command.ts";
import { RuleEngine } from "../src/rules/engine.ts";
import { commandReplyText, RuleService } from "../src/rules/service.ts";
import { triggerProblems } from "../src/rules/triggers.ts";
import { PlanRejected } from "../src/plan/validate.ts";
import { NO_DECIDE } from "../src/wasm/run.ts";
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
  assert.match(commandProblems({ ...SPEC, name: "settings" }).join(), /Botが使っています/);
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

test("COMMAND goes alone or with INTERACTION_CREATE, and needs a command", () => {
  assert.deepEqual(triggerProblems({ event: "COMMAND", command: SPEC }), []);
  assert.deepEqual(triggerProblems({ event: "COMMAND", events: ["INTERACTION_CREATE"], command: SPEC }), []);
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

function world(visibilityScore?: (input: any) => Promise<number | null>, engineDeps: Partial<ConstructorParameters<typeof RuleEngine>[0]> = {}) {
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
    ...engineDeps,
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
    applicationCommands: { bulkOverwriteGuildCommands: async (_a: string, _g: string, body: unknown) => (calls.push(["register", body]), [] as Array<{ name: string; id: string }>), getGuildCommands: async () => [], bulkOverwriteGlobalCommands: async (_a: string, body: unknown) => (calls.push(["global", body]), [{ name: "settings", id: "900" }]), getGlobalCommands: async () => (calls.push(["global-read", null]), [{ name: "settings", id: "901" }]) },
  } as never;
  const service = new RuleService({ api, store, caches, admin, engine, selfId: () => SELF, now: () => 1_000_000, log: () => {}, ...(visibilityScore ? { visibilityScore } : {}) });
  const definition: RuleDefinition = {
    name: "お知らせ",
    sourcePrompt: "/announce で投稿",
    trigger: { event: "COMMAND", command: SPEC },
    allow: [{ op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } } }],
    program: { kind: "js", code: "" },
    summary: null,
    limits: DEFAULT_LIMITS,
  };
  return { store, admin, engine, service, runs, readers, calls, definition, setCode: (f: typeof code) => (code = f), api };
}

test("running the command runs the rule as whoever ran it and replies with what the code said", async () => {
  const w = world();
  w.admin.save(GUILD, "1", w.definition);
  assert.equal(await w.service.handleCustomCommand(interaction({ text: "お知らせです" })), true);
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].actorId, "3");
  assert.deepEqual(w.runs[0].drafts?.[0]?.body ?? w.runs[0].steps?.[0]?.body, { content: "お知らせです" });
  // Reads are limited to what the channel's viewers may see, as whoever ran it.
  assert.deepEqual([w.readers.at(-1).speakerId, w.readers.at(-1).audience, w.readers.at(-1).channelId], ["3", "channel", "10"]);
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
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /このコマンドを使うには「チャンネルの管理」の権限が必要です/);
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.ManageChannels));
  assert.equal(w.runs.length, 1);
  // Administrator counts as every permission, as in the command list.
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.Administrator));
  assert.equal(w.runs.length, 2);

  assert.throws(() => w.admin.save(GUILD, "2", w.definition), /announce/);
  w.admin.setEnabled(GUILD, "1", rule.id, false);
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.ManageChannels));
  assert.equal(w.runs.length, 2);
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /今は使えません/);
  // Reserved names are left to the bot's own handlers.
  assert.equal(await w.service.handleCustomCommand({ ...(interaction({}) as object), data: { type: ApplicationCommandType.ChatInput, name: "settings" } } as never), false);
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

test("enabled command rules are the server's guild commands; /settings is global and holds the rules", async () => {
  const w = world();
  assert.deepEqual(guildCommands(w.store, GUILD), []);
  const rule = w.admin.save(GUILD, "1", w.definition);
  assert.deepEqual(guildCommands(w.store, GUILD).map((c) => c.name), ["announce"]);
  assert.equal(await registerCommands(w.api, w.store, "app", GUILD), true);
  assert.equal(await registerCommands(w.api, w.store, "app", GUILD), false);
  w.admin.setEnabled(GUILD, "1", rule.id, false);
  assert.equal(await registerCommands(w.api, w.store, "app", GUILD), true);
  assert.deepEqual(w.calls.at(-1)![1], []);
  assert.deepEqual(COMMANDS.map((c) => c.name), ["settings"]);
  assert.ok(COMMANDS.every((c) => JSON.stringify(c.contexts) === "[0]"), "server-only");
  assert.equal(await registerGlobalCommands(w.api, w.store, "app"), true);
  assert.equal(w.store.getMeta(SETTINGS_COMMAND_ID), "900");
  assert.equal(await registerGlobalCommands(w.api, w.store, "app"), false);
  // An id lost while the commands stayed the same is read back without re-registering.
  w.store.setMeta(SETTINGS_COMMAND_ID, "");
  assert.equal(await registerGlobalCommands(w.api, w.store, "app"), false);
  assert.equal(w.store.getMeta(SETTINGS_COMMAND_ID), "901");
  assert.equal(w.calls.filter((c) => c[0] === "global").length, 1);
});

test("by default the judge model of whoever ran it decides who sees the reply; failures and errors stay private", async () => {
  const asked: any[] = [];
  let verdict: () => Promise<number> = async () => 0.9;
  const w = world(async (input) => (asked.push(input), verdict()));
  w.admin.save(GUILD, "1", w.definition);
  await w.service.handleCustomCommand(interaction({ text: "お知らせです" }));
  assert.deepEqual(asked.map((a) => [a.userId, a.command.name, a.options.text, a.reply, a.steps]), [["3", "announce", "お知らせです", "こんにちは", 1]]);
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

test("a public command's failures and the replies its code marks ephemeral go only to whoever ran it", async () => {
  const w = world();
  w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, visibility: "public" } } });
  w.setCode((b) => (b.reply("文字が多すぎます"), b.respond!({ type: 4, data: { flags: 64 } }), { ok: true, value: null, logs: [] }));
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "followUp", "delete"]);
  assert.equal((w.calls[0]![1] as { flags?: number }).flags, undefined);
  assert.equal((w.calls[1]![1] as { flags?: number }).flags, 64);
  assert.match((w.calls[1]![1] as { content: string }).content, /文字が多すぎます/);

  w.calls.length = 0;
  w.setCode((b) => (b.reply("途中まで"), { ok: false, error: "boom", logs: [] }));
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "followUp", "delete"]);
  assert.equal((w.calls[1]![1] as { flags?: number }).flags, 64);

  w.calls.length = 0;
  w.setCode((b) => (b.reply("できました"), { ok: true, value: null, logs: [] }));
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.deepEqual(w.calls.map((c) => c[0]), ["defer", "edit"]);
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
  assert.deepEqual(after.program, rule.program);
  const view = JSON.stringify(w.calls.at(-1)![1]);
  assert.match(view, /全員に見せる」にしました/);
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
  assert.match(JSON.stringify(w.calls.at(-1)![1]), /「お知らせ」を削除します/);
});

test("the commands section lists every command the presser may run as a link, and the owner manages theirs", async () => {
  const w = world();
  const mine = w.admin.save(GUILD, "1", w.definition);
  const gated = w.admin.save(GUILD, "2", { ...w.definition, name: "掃除", trigger: { event: "COMMAND", command: { ...SPEC, name: "cleanup", description: "掃除する", permissions: ["ManageChannels"] } } });
  w.store.setMeta(guildCommandIdsKey(GUILD), JSON.stringify({ announce: "501", cleanup: "502" }));
  const press = (userId: string, custom: string, permissions: bigint, values?: string[]) => ({
    id: "i4", token: "tok", application_id: "app", type: InteractionType.MessageComponent, guild_id: GUILD,
    member: { user: { id: userId }, roles: [], permissions: permissions.toString() },
    data: { custom_id: custom, component_type: values ? 3 : 2, ...(values ? { values } : {}) },
  }) as never;
  const last = () => JSON.stringify(w.calls.at(-1)![1]);

  // Someone without Manage Channels sees only what they can run, each a link.
  await w.service.handleInteraction(press("3", "rule:commands:", P.SendMessages));
  assert.match(last(), /<\/announce:501>/);
  assert.doesNotMatch(last(), /cleanup/);
  assert.doesNotMatch(last(), /rule:cmd:/, "no menu without commands of their own");
  await w.service.handleInteraction(press("3", "rule:commands:", P.ManageChannels));
  assert.match(last(), /<\/cleanup:502>/);

  // The owner opens theirs, changes who sees replies, and deletes it with its rule.
  await w.service.handleInteraction(press("1", "rule:commands:", 0n));
  assert.match(last(), /rule:cmd:/);
  assert.doesNotMatch(last(), /cleanup/);
  await w.service.handleInteraction(press("1", "rule:cmd:", 0n, [mine.id]));
  assert.match(last(), new RegExp(`rule:open:${mine.id}`));
  assert.match(last(), new RegExp(`rule:cmddel:${mine.id}`));
  await w.service.handleInteraction(press("1", `rule:cmdvis:${mine.id}`, 0n, ["private"]));
  assert.equal(w.store.getRule(mine.id)!.trigger.command!.visibility, "private");
  await w.service.handleInteraction(press("2", `rule:cmd:${mine.id}`, 0n));
  assert.match(String((w.calls.at(-1)![1] as { content?: string }).content), /作成者だけ/);
  await w.service.handleInteraction(press("1", `rule:cmddel:${mine.id}`, 0n));
  assert.match(last(), new RegExp(`rule:cmddel2:${mine.id}`));
  await w.service.handleInteraction(press("1", `rule:cmddel2:${mine.id}`, 0n));
  assert.equal(w.store.getRule(mine.id), undefined);
  assert.match(last(), /コマンド \/announce とルール「お知らせ」を削除しました/);
  assert.ok(w.store.getRule(gated.id));
});

test("a command acts within the allow list and the runner's permissions; their refusals do not switch the rule off", async () => {
  const w = world(undefined, {
    planner: {
      // Stands in for the planner's check of the runner's permissions.
      runForRule: async (input) => {
        if (input.actorId !== "1") throw new PlanRejected(["依頼者に権限 ManageChannels がありません"]);
        return { plan: { id: "p1" }, status: "succeeded", reason: null } as never;
      },
    },
  });
  const rule = w.admin.save(GUILD, "1", w.definition);
  for (let i = 0; i < DEFAULT_LIMITS.maxConsecutiveFailures + 1; i++) await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /ManageChannels/);
  assert.equal(w.store.getRule(rule.id)!.enabled, true);
});

test("a runner without a judge model still runs the parts that need none; judge() fails without switching the rule off", async () => {
  const asked: string[] = [];
  const w = world(undefined, { decide: (userId) => (asked.push(userId), undefined) });
  w.setCode((b) => (b.decide ? { ok: true, value: null, logs: [] } : { ok: false, error: `Error: ${NO_DECIDE}`, logs: [] }));
  const rule = w.admin.save(GUILD, "1", { ...w.definition, allow: [] });
  for (let i = 0; i < DEFAULT_LIMITS.maxConsecutiveFailures + 1; i++) await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.ok(asked.length > 0 && asked.every((id) => id === "3"));
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /\/settings/);
  assert.equal(w.store.getRule(rule.id)!.enabled, true);

  // Without judge(), the same runner's command just works.
  w.setCode((b) => (b.reply("ok"), { ok: true, value: null, logs: [] }));
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /ok/);
});

test("a public command's later() gets its reply's message, and run_as owner runs the command as the owner", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, visibility: "public" }, runAs: "owner" }, allow: [] });
  ((w.api as any).interactions).editReply = async (_a: string, _t: string, body: unknown) => (w.calls.push(["edit", body]), { id: "880", channel_id: "10" });
  const seen: any[] = [];
  w.setCode((b) => {
    seen.push(b);
    if (b.eventName === "TIMER") return { ok: true, value: { steps: [{ op: "PATCH /channels/{channel}/messages/{message}", path: { channel: b.event.message.channel_id, message: b.event.message.id }, body: { components: [] } }] }, logs: [] };
    b.later(600);
    b.reply("できました");
    return { ok: true, value: null, logs: [] };
  });
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(seen[0].actor.userId, "1", "run_as owner");
  assert.equal(w.store.countRuleTimers(rule.id), 1);
  w.engine.runTimers([GUILD], 1_000_000 + 660_000);
  await w.engine.idle();
  assert.equal(seen[1].eventName, "TIMER");
  assert.deepEqual(seen[1].event.message, { channel_id: "10", id: "880" });
  assert.equal(w.runs.at(-1).actorId, "1");
  assert.deepEqual([w.readers.at(-1).speakerId, w.readers.at(-1).audience, w.readers.at(-1).channelId], ["1", "channel", "10"]);
  assert.deepEqual(w.runs.at(-1).drafts[0].path, { channel: "10", message: "880" });
  assert.deepEqual(w.runs.at(-1).rule.ownReply, { channelId: "10", messageId: "880" });
});

test("a public command's later() edits its reply as whoever ran it, so their judge model is used throughout", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "COMMAND", command: { ...SPEC, visibility: "public" } }, allow: [] });
  ((w.api as any).interactions).editReply = async (_a: string, _t: string, body: unknown) => (w.calls.push(["edit", body]), { id: "880", channel_id: "10" });
  const seen: any[] = [];
  w.setCode((b) => {
    seen.push(b);
    if (b.eventName === "TIMER") return { ok: true, value: { steps: [{ op: "PATCH /channels/{channel}/messages/{message}", path: { channel: b.event.message.channel_id, message: b.event.message.id }, body: { components: [] } }] }, logs: [] };
    b.later(600);
    b.reply("できました");
    return { ok: true, value: null, logs: [] };
  });
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(seen[0].actor.userId, "3");
  assert.equal(w.store.countRuleTimers(rule.id), 1);
  w.engine.runTimers([GUILD], 1_000_000 + 660_000);
  await w.engine.idle();
  assert.equal(seen[1].actor.userId, "3");
  // The reply is read from its channel, as the command was (a private thread is not readable otherwise).
  assert.deepEqual([w.readers.at(-1).speakerId, w.readers.at(-1).audience, w.readers.at(-1).channelId], ["3", "channel", "10"]);
  assert.equal(w.runs.at(-1).actorId, "3");
  assert.deepEqual(w.runs.at(-1).rule.ownReply, { channelId: "10", messageId: "880" });
});

// --- Rule panels: order, wording ------------------------------------------

/** A panel's parts in order: each text, "[select: placeholder]", "[buttons: a | b]", and "---" for a divider. */
function layout(view: unknown): string[] {
  const container = (view as { components: Array<{ components: Array<{ type: number; content?: string; placeholder?: string; components?: Array<{ type: number; label?: string; placeholder?: string }> }> }> }).components[0]!;
  return container.components.map((c) => {
    if (c.type === 10) return c.content!;
    if (c.type === 14) return "---";
    const first = c.components![0]!;
    return first.type === 3 ? `[select: ${first.placeholder ?? first.label ?? ""}]` : `[buttons: ${c.components!.map((b) => b.label).join(" | ")}]`;
  });
}

function ruleOf(trigger: RuleDefinition["trigger"], extra: Partial<import("../src/rules/types.ts").Rule> = {}): import("../src/rules/types.ts").Rule {
  return {
    id: "r1", guildId: GUILD, ownerId: "1", name: "お知らせ", sourcePrompt: "", trigger, allow: [], program: { kind: "js", code: "1" }, summary: "要約です。",
    limits: DEFAULT_LIMITS, version: 1, enabled: true, consecutiveFailures: 0, disabledReason: null, createdAt: "", updatedAt: "", ...extra,
  };
}

const CAN = { enable: true, disable: true, remove: true, owner: true };

test("a rule's summary puts the audience select right under the trigger, and the buttons last", async () => {
  const { detailView } = await import("../src/rules/panel.ts");
  const rule = ruleOf({ event: "COMMAND", command: { ...SPEC, visibility: "auto" } });
  const owner = layout(detailView({ rule, userId: "1", runs: [], can: CAN, notice: "止めました" }, (id) => id));
  assert.deepEqual(owner, [
    "### お知らせ\n🟢 動作中 · v1",
    "`/announce` が実行されたとき",
    "返事を見せる相手:",
    "[select: ]",
    "要約です。",
    "-# まだ実行されていません",
    "[select: 詳しく見る]",
    "---",
    "-# 止めました",
    "[buttons: 止める | ドライラン]",
    "[buttons: ← 一覧へ]",
  ]);
  // Whoever has no select reads the audience in the sentence.
  const viewer = layout(detailView({ rule, userId: "2", runs: [], can: { ...CAN, owner: false, enable: false, disable: false, remove: false } }, (id) => id));
  assert.equal(viewer[1], "`/announce` が実行されたとき(返事を見せる相手: 判定モデルが決める)");
  assert.ok(!viewer.includes("返事を見せる相手:"));
  // A stopped rule offers 再開する, and a halted server says so instead.
  const stopped = layout(detailView({ rule: { ...rule, enabled: false }, userId: "1", runs: [], can: CAN, halted: true }, (id) => id));
  assert.match(stopped[0]!, /🛑 全ルール停止中/);
  assert.ok(stopped.includes("[buttons: 再開する | ドライラン]"));
  // While a dry run works, only the way out is left.
  assert.ok(layout(detailView({ rule, userId: "1", runs: [], can: CAN, busy: true, notice: "ドライラン中…" }, (id) => id)).includes("[buttons: ← 一覧へ]"));
  assert.ok(!layout(detailView({ rule, userId: "1", runs: [], can: CAN, busy: true }, (id) => id)).some((p) => p.includes("ドライラン |") || p.includes("止める")));
});

test("the allow page says whose permissions the rule runs with, and warns only when the owner is chosen", async () => {
  const { detailView } = await import("../src/rules/panel.ts");
  const page = (trigger: RuleDefinition["trigger"]) => layout(detailView({ rule: ruleOf(trigger), userId: "1", page: "allow", runs: [], can: CAN }, (id) => id)).join("\n");
  assert.match(page({ event: "COMMAND", command: SPEC }), /動かした人の権限と判定モデルで動きます/);
  assert.match(page({ event: "INTERACTION_CREATE" }), /動かした人の権限と判定モデルで動きます/);
  assert.match(page({ event: "MESSAGE_CREATE" }), /^<@1> の権限で動きます/m);
  assert.doesNotMatch(page({ event: "MESSAGE_CREATE" }), /⚠️/);
  assert.match(page({ event: "COMMAND", command: SPEC, runAs: "owner" }), /⚠️ <@1> の権限で動きます/);
});

test("the code page puts 'ファイルで受け取る' under the code, and a run history says how many it shows", async () => {
  const { detailView } = await import("../src/rules/panel.ts");
  const rule = ruleOf({ event: "MESSAGE_CREATE" });
  const source = layout(detailView({ rule, userId: "1", page: "source", runs: [], can: CAN }, (id) => id));
  assert.ok(source.findIndex((p) => p.startsWith("```js")) < source.indexOf("[buttons: ファイルで受け取る]"));
  assert.ok(source.indexOf("[buttons: ファイルで受け取る]") < source.indexOf("[select: 詳しく見る]"));
  const run = { id: 1, ruleId: "r1", ruleVersion: 1, startedAt: new Date(1_000_000).toISOString(), outcome: "executed", planId: "p1", error: null } as unknown as import("../src/rules/types.ts").RuleRun;
  const runs = layout(detailView({ rule, userId: "1", page: "runs", runs: [run, run], can: CAN, state: { n: 1 } }, (id) => id));
  assert.match(runs[1]!, /^\*\*最近の実行\*\*\(2件\)/);
  assert.match(runs[1]!, /変更案 `p1`/);
  assert.ok(runs.indexOf("[buttons: 状態を消す]") > runs.findIndex((p) => p.startsWith("**状態**")));
  assert.equal(runs.at(-1), "[buttons: ← 一覧へ]");
});

test("the rule list counts what the select cannot show, names a stop, and keeps 'ほかの人の' with the state first", async () => {
  const { homeView } = await import("../src/rules/panel.ts");
  const many = Array.from({ length: 30 }, (_, i) => ruleOf({ event: "MESSAGE_CREATE" }, { id: `r${i}`, enabled: i !== 0, ownerId: i === 1 ? "2" : "1" }));
  const input = { rules: many, userId: "1", canSeeAll: true, canHalt: true, halted: null, lastRuns: new Map() };
  const view = homeView(input);
  assert.deepEqual(layout(view), [
    "## ルール",
    "[select: ルールを開く(30件中25件)]",
    "[buttons: 変更案の履歴 | 監査ログ]",
    "---",
    "[buttons: 緊急停止]",
    "[buttons: ← 設定のトップへ]",
  ]);
  const options = (view as any).components[0].components[1].components[0].options;
  assert.match(options[0].description, /^停止中 · /);
  assert.match(options[1].description, /^動作中 · .*ほかの人のルール$/);
  assert.equal(layout(homeView({ ...input, rules: many.slice(0, 3) }))[1], "[select: ルールを開く(3件)]");
  const halted = layout(homeView({ ...input, rules: [], halted: { by: "1", at: new Date(0).toISOString() }, notice: "全ルールを止めました。再開するまでどのルールも動きません。" }));
  assert.deepEqual(halted.map((p) => p.split(/[(\n]/)[0]), ["## ルール", "🛑 全ルールを停止中", "まだありません。会話でBotに頼むと作れます。", "[buttons: 変更案の履歴 | 監査ログ]", "---", "-# 全ルールを止めました。再開するまでどのルールも動きません。", "[buttons: 全ルールを再開]", "[buttons: ← 設定のトップへ]"]);
});

test("the history and audit screens count their lines, name the operations, and end with the way back", async () => {
  const { plansView, auditView } = await import("../src/rules/panel.ts");
  const row = (steps: string[]) => ({ plan: { id: "p1", createdAt: new Date(1_000_000).toISOString(), actor: { userId: "1" }, steps: steps.map((op) => ({ op })) }, status: "pending_approval", reason: null }) as never;
  const own = layout(plansView([row(["POST /channels/{channel}/messages", "POST /channels/{channel}/messages", "PUT /guilds/{guild}/members/{user}/roles/{role}"])], false));
  assert.equal(own[0], "### 変更案の履歴(1件)\n-# あなたの分だけです(ルールによるものを含む)");
  assert.match(own[1]!, /実行待ち · <@1> · 3件 投稿・/);
  assert.doesNotMatch(own[1]!, /POST /);
  assert.equal(own[2], "[buttons: ← 一覧へ]");
  assert.equal(layout(plansView([], true))[0], "### 変更案の履歴(0件)");
  const audit = layout(auditView([{ at: new Date(1_000_000).toISOString(), actor: { kind: "user", userId: "1", via: "panel" }, action: "plan.approve", planId: "p1" } as never], false));
  assert.equal(audit[0], "### 監査ログ(1件)\n-# あなたの分だけです。全件は「監査ログを表示」の権限で見られます。");
  assert.match(audit[1]!, /<@1> 実行 変更案 `p1`/);
  assert.doesNotMatch(audit[1]!, /plan\.approve/);
  assert.equal(audit[2], "[buttons: ← 一覧へ]");
});

test("the command screens follow the same order, name a halt, and say 動作中 or 停止中 in the menu", async () => {
  const { commandsView, commandView } = await import("../src/rules/panel.ts");
  const rule = ruleOf({ event: "COMMAND", command: { ...SPEC, permissions: ["ManageChannels"] } }, { enabled: false });
  const list = commandsView({ rules: [rule], userId: "1", ids: {}, halted: true });
  assert.deepEqual(layout(list).map((p) => p.split("\n")[0]), ["## コマンド", "🛑 全ルール停止中", "`/announce` ⏸️ 停止中 お知らせを投稿する", "[select: 自分のコマンドを開く(1件)]", "[buttons: ← 設定のトップへ]"]);
  assert.match((list as any).components[0].components[3].components[0].options[0].description, /^停止中 · お知らせを投稿する/);
  const own = layout(commandView({ rule: { ...rule, enabled: true }, ids: {}, notice: "「全員に見せる」にしました" }));
  assert.deepEqual(own.slice(-7), ["返事を見せる相手:", "[select: ]", "---", "-# 「全員に見せる」にしました", "[buttons: コマンドを削除]", "[buttons: 関連ルールを見る]", "[buttons: ← 一覧へ]"]);
  assert.match(layout(commandView({ rule, ids: {} })).join("\n"), /⏸️ 停止中\(ルールを再開すると使えます\)/);
  assert.match(layout(commandView({ rule, ids: {}, confirmDelete: true })).join("\n"), /⚠️ 「\/announce」とルール「お知らせ」を削除します。実行履歴と監査ログは残ります。/);
});

test("a failed command reply says what happened, then why, and a successful one counts operations", () => {
  const failed = { outcome: "failed", error: "実行中にエラーが起きました", reply: null, images: [], steps: 0 } as never;
  assert.equal(commandReplyText("x", failed), "⚠️ 実行できませんでした。実行中にエラーが起きました。");
  assert.equal(commandReplyText("x", { ...(failed as object), error: "混み合っています。少し待ってからもう一度使ってください。" } as never), "⚠️ 実行できませんでした。混み合っています。少し待ってからもう一度使ってください。");
  assert.equal(commandReplyText("x", { ...(failed as object), error: "Missing Permissions" } as never), "⚠️ 実行できませんでした。権限が足りません。");
  assert.equal(commandReplyText("x", { outcome: "executed", error: null, reply: null, images: [], steps: 2 } as never), "「x」を実行しました(操作2件)");
});

test("the dry run answers at once with the buttons gone, then shows its result", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "MESSAGE_CREATE" } });
  (w.api as any).interactions.deferMessageUpdate = async () => void w.calls.push(["deferred", null]);
  await w.service.handleInteraction({
    id: "i5", token: "tok", application_id: "app", type: InteractionType.MessageComponent, guild_id: GUILD, channel: { id: "10" },
    member: { user: { id: "1" }, roles: [], permissions: "0" },
    data: { custom_id: `rule:dry:${rule.id}`, component_type: 2 },
  } as never);
  assert.deepEqual(w.calls.map((c) => c[0]), ["update", "edit"]);
  const [running, done] = w.calls.map((c) => layout(c[1]));
  assert.ok(running!.includes("-# ドライラン中…"));
  assert.ok(!running!.some((p) => p.includes("ドライラン |") || p.includes("止める")));
  assert.ok(done!.some((p) => p.startsWith("**ドライラン**")));
});

test("a command that cannot run says so in the same short form, whatever the reason", async () => {
  const w = world();
  w.admin.save(GUILD, "1", w.definition);
  const said = () => (w.calls.at(-1)![1] as { content: string }).content;
  w.admin.halt(GUILD, "1");
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(said(), "⚠️ 実行できませんでした。いまは全ルールが止まっています。");
  w.admin.resume(GUILD, "1");
  await w.service.handleCustomCommand({ ...(interaction({ text: "x" }) as object), channel: { id: "999" } } as never);
  assert.equal(said(), "⚠️ 実行できませんでした。このチャンネルでは使えません。");
  const rule = w.store.enabledRules(GUILD, "COMMAND")[0]!;
  w.store.updateRuleSettings(rule.id, { ...rule, limits: { ...rule.limits, perMinute: 1 } });
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  await w.service.handleCustomCommand(interaction({ text: "x" }));
  assert.equal(said(), "⚠️ 実行できませんでした。混み合っています。少し待ってからもう一度使ってください。");
});
