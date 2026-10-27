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
import { RuleService } from "../src/rules/service.ts";
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
  assert.match((w.calls.at(-1)![1] as { content: string }).content, /ManageChannels/);
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.ManageChannels));
  assert.equal(w.runs.length, 1);

  assert.throws(() => w.admin.save(GUILD, "2", w.definition), /announce/);
  w.admin.setEnabled(GUILD, "1", rule.id, false);
  await w.service.handleCustomCommand(interaction({ text: "x" }, P.ManageChannels));
  assert.equal(w.runs.length, 1);
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
  assert.deepEqual(w.runs.at(-1).drafts[0].path, { channel: "10", message: "880" });
});
