import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { InteractionType } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { CATALOG } from "../src/plan/catalog.ts";
import { attachmentsFor } from "../src/plan/files.ts";
import { normalizeSteps } from "../src/plan/validate.ts";
import { RuleAdmin } from "../src/rules/admin.ts";
import { RuleEngine } from "../src/rules/engine.ts";
import { InteractionAnswer, interactionEvent, isRuleInteraction } from "../src/rules/interaction.ts";
import type { InteractionResponder } from "../src/rules/interaction.ts";
import { triggerProblems } from "../src/rules/triggers.ts";
import { DEFAULT_LIMITS } from "../src/rules/types.ts";
import type { RuleDefinition } from "../src/rules/types.ts";
import { Value } from "typebox/value";
import { GUILD, makeGuild, SELF } from "./helpers.ts";

const MODAL = { type: 9, data: { custom_id: "apply:form", title: "申請", components: [] } };

function world() {
  const store = new Store(":memory:", randomBytes(32));
  const cache = new GuildCache(GUILD);
  cache.guild = makeGuild();
  const caches = { get: (id: string | undefined) => (id === GUILD ? cache : undefined) };
  const admin = new RuleAdmin({ store, caches, selfId: () => SELF, now: () => 1_000_000 });
  const order: string[] = [];
  const seen: any[] = [];
  let status = "succeeded";
  let respond: unknown = MODAL;
  let steps: unknown[] = [];
  const engine = new RuleEngine({
    store,
    caches,
    planner: { runForRule: async () => (order.push("steps"), { plan: { id: "p1" }, status, reason: status === "succeeded" ? null : "だめ" }) as never },
    selfId: () => SELF,
    now: () => 1_000_000,
    makeReader: () => ({ get: async () => null }) as never,
    log: () => {},
    run: async (_program, bindings) => {
      seen.push(bindings);
      bindings.respond?.(respond);
      return { ok: true, value: steps.length ? { steps } : null, logs: [] };
    },
  });
  const responses: unknown[] = [];
  const responder: InteractionResponder = {
    send: async (r) => (order.push("answer"), responses.push(r), null),
    failed: async (name) => void (order.push("failed"), responses.push(`failed:${name}`)),
  };
  const definition: RuleDefinition = {
    name: "申請",
    sourcePrompt: "ボタンでフォーム",
    trigger: { event: "INTERACTION_CREATE" },
    allow: [],
    program: { kind: "js", code: "return null" },
    summary: null,
    limits: DEFAULT_LIMITS,
  };
  return {
    store, admin, engine, seen, responses, responder, definition, order,
    set: (o: { respond?: unknown; steps?: unknown[]; status?: string }) => {
      if ("respond" in o) respond = o.respond;
      if (o.steps) steps = o.steps;
      if (o.status) status = o.status;
    },
  };
}

const press = (channel: string, id = "900") => ({ id, type: InteractionType.MessageComponent, guild_id: GUILD, channel_id: channel, member: { user: { id: "3" }, roles: [] }, data: { custom_id: "apply:open", component_type: 2 } });

test("a press runs the server's INTERACTION_CREATE rules as their owners, and the code's form answers it", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", w.definition);
  w.admin.save(GUILD, "3", { ...w.definition, name: "見えない" });
  // "3" cannot see the staff channel, so only the owner's rule fires there.
  const counts = w.engine.dispatchInteraction(GUILD, press("11"), w.responder);
  await w.engine.idle();
  assert.deepEqual(counts, { fired: 1, limited: 0 });
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].actor.userId, "1");
  assert.equal(w.seen[0].eventName, "INTERACTION_CREATE");
  assert.deepEqual(w.responses, [MODAL]);
  assert.equal(w.store.recentRuleRuns(rule.id, 1)[0]!.outcome, "no_change");
});

test("a form goes out before the changes, other answers after them, and a failed run tells whoever pressed", async () => {
  const w = world();
  w.admin.save(GUILD, "1", { ...w.definition, allow: [{ op: "POST /channels/{channel}/messages" }] });
  w.set({ steps: [{ op: "POST /channels/{channel}/messages", path: { channel: "11" }, body: { content: "申請あり" } }] });
  w.engine.dispatchInteraction(GUILD, press("10", "901"), w.responder);
  await w.engine.idle();
  assert.deepEqual(w.order, ["answer", "steps"]);

  w.order.length = 0;
  const message = { type: 4, data: { content: "受け付けました", flags: 64 } };
  w.set({ respond: message });
  w.engine.dispatchInteraction(GUILD, press("10", "902"), w.responder);
  await w.engine.idle();
  assert.deepEqual(w.order, ["steps", "answer"]);
  assert.deepEqual(w.responses.at(-1), message);

  w.order.length = 0;
  w.set({ status: "failed" });
  w.engine.dispatchInteraction(GUILD, press("10", "903"), w.responder);
  await w.engine.idle();
  assert.deepEqual(w.order, ["steps", "failed"]);
});

test("nothing fires without a rule, and debounce does not go with presses", () => {
  const w = world();
  assert.deepEqual(w.engine.dispatchInteraction(GUILD, press("10"), w.responder), { fired: 0, limited: 0 });
  assert.match(triggerProblems({ event: "INTERACTION_CREATE", debounceSeconds: 5 }).join(), /debounce_seconds/);
  assert.deepEqual(triggerProblems({ event: "INTERACTION_CREATE" }), []);
});

test("the bot's own panels keep their presses, and the rule never sees the token", () => {
  const base = { id: "1", application_id: "2", token: "secret", guild_id: GUILD, channel: { id: "10" }, member: { user: { id: "3" } } };
  const of = (custom_id: string, type = InteractionType.MessageComponent) => ({ ...base, type, data: { custom_id } }) as never;
  assert.equal(isRuleInteraction(of("llm:page:home")), false);
  assert.equal(isRuleInteraction(of("plan:run:x:12345678")), false);
  assert.equal(isRuleInteraction(of("apply:open")), true);
  assert.equal(isRuleInteraction(of("apply:form", InteractionType.ModalSubmit)), true);
  assert.equal(isRuleInteraction({ ...base, type: InteractionType.ApplicationCommand, data: { name: "x" } } as never), false);
  const event = interactionEvent(of("apply:open"));
  assert.equal(event.token, undefined);
  assert.equal(event.channel_id, "10");
});

function fakeApi() {
  const calls: Array<[string, unknown]> = [];
  const api = {
    rest: { post: async (route: string, options: { body: unknown }) => void calls.push([route, options.body]) },
    interactions: {
      deferMessageUpdate: async () => void calls.push(["defer", null]),
      followUp: async (_a: string, _t: string, body: unknown) => void calls.push(["followUp", body]),
      editReply: async (_a: string, _t: string, body: unknown) => void calls.push(["editReply", body]),
    },
  };
  return { api: api as never, calls };
}

const interaction = { id: "5", application_id: "6", token: "tok", type: InteractionType.MessageComponent, data: { custom_id: "apply:open" } } as never;

test("the first answer is the interaction's response; later ones follow up, and a late form cannot open", async () => {
  const { api, calls } = fakeApi();
  const answer = new InteractionAnswer(api, interaction, () => {});
  assert.equal(await answer.send({ type: 4, data: { content: "@everyone hi" } }), null);
  assert.deepEqual(calls[0], ["/interactions/5/tok/callback", { type: 4, data: { content: "@everyone hi", allowed_mentions: { parse: [] } } }]);
  assert.equal(await answer.send({ type: 4, data: { content: "more" } }), null);
  assert.equal(calls[1]![0], "followUp");
  assert.match((await answer.send(MODAL))!, /フォームを出せません/);
  assert.match((await answer.send({ type: 1 }))!, /type/);
});

test("a press nothing answered in time is acknowledged, and an update after that edits the message", async () => {
  const { api, calls } = fakeApi();
  const answer = new InteractionAnswer(api, interaction, () => {});
  answer.arm(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [["defer", null]]);
  assert.equal(await answer.send({ type: 7, data: { content: "済み", components: [] } }), null);
  assert.equal(calls[1]![0], "editReply");
});

test("posts and the bot's edits carry components as Discord takes them", () => {
  const post = CATALOG.get("POST /channels/{channel}/messages")!;
  const components = [{ type: 1, components: [{ type: 2, style: 1, label: "申請", custom_id: "apply:open" }] }];
  assert.equal(Value.Check(post.body!, { components }), true);
  assert.equal(Value.Check(post.body!, { components, flags: 32768 }), true);
  // A post with only buttons needs no text.
  const steps = normalizeSteps([{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { components, flags: 32768 } }], GUILD, "p");
  assert.deepEqual(attachmentsFor(steps, []).problems, []);
  const edit = CATALOG.get("PATCH /channels/{channel}/messages/{message}")!;
  assert.equal(Value.Check(edit.body!, { components: [] }), true);
  assert.equal(Value.Check(edit.body!, {}), false);
  // Undo puts back what the message had.
  const inverse = edit.inverse!({ channel: "10", message: "7" }, { components: [] }, { content: "x", components }, null);
  assert.deepEqual(inverse?.body, { components });
});
