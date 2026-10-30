import { createHash } from "node:crypto";
import type { RuleTimer, Store } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import { toChannel } from "../discord/cache.ts";
import { canView, needsThreadMembership } from "../discord/permissions.ts";
import { ownerAllowProblems } from "./allow.ts";
import type { GuildState } from "../discord/permissions.ts";
import type { Reader, ReadScope } from "../discord/reader.ts";
import { CATALOG } from "../plan/catalog.ts";
import type { Planner } from "../plan/service.ts";
import type { Plan, Step, StepDraft } from "../plan/types.ts";
import { PlanRejected } from "../plan/validate.ts";
import { jsProgram, SANDBOX_LIMITS } from "../sandbox.ts";
import type { Decide } from "../agent/decide.ts";
import type { SandboxBindings, SandboxResult } from "../sandbox.ts";
import { DEFAULT_TIMEZONE, isoNext, parseCron, startCron } from "./schedule.ts";
import { ACTOR_EVENTS, createdKindOf, MAX_BATCH, reactionKey, syntheticEvent, TRIGGERS, voiceMoveKey, voiceMuteKey } from "./triggers.ts";
import { MAX_STATE_JSON } from "./types.ts";
import { MAX_REPLY } from "./command.ts";
import { fetchImage, imageRefs } from "../agent/images.ts";
import { convertImage, ConvertOptionsSchema, MathOptionsSchema, parseOptions, renderMath } from "../media.ts";
import type { APIMessage } from "discord-api-types/v10";
import type { Rule, RunOutcome } from "./types.ts";
import { NO_DECIDE, runModule } from "../wasm/run.ts";
import { ANSWER_TTL_MS, isModalResponse } from "./interaction.ts";
import type { InteractionResponder } from "./interaction.ts";
import type { Program } from "../wasm/run.ts";
import type { WasmRegistry } from "../wasm/registry.ts";

// Fires event rules. Each matching event runs the rule's code in the sandbox
// with its owner's read scope; the steps it returns go to the Planner, which
// checks them against the allow list and the owner's current permissions and
// runs them without a dialog. Safety: the bot's own changes are ignored unless
// the rule opts in, each rule is rate limited, repeated failures switch it off,
// and anyone with Manage Server can stop every rule in the server at once.
// SCHEDULE rules fire from a cron job each (syncSchedules); rules with a debounce wait for
// a quiet moment and run once on the batch of events. COMMAND rules run when
// someone uses their slash command, as that person: their read scope, their
// permissions (within the allow list) and their judge model, and the outcome
// goes back to them. INTERACTION_CREATE rules run on presses of the bot's
// messages' buttons and forms sent from them, and what the code passes to
// respond() answers whoever pressed. Those and reaction rules act as whoever
// pressed or reacted, like a command, unless the rule runs as its owner.
// A run may ask with later(seconds) to run the rule again that much
// later; the request is kept in the database (so it survives restarts) and
// comes back as a TIMER event, acting as whoever the run that asked acted as.
// Nothing polls for them: one timer sleeps until the earliest is due.

/** How long after the bot changes something an event about it counts as the bot's own. */
export const RECENT_WRITE_MS = 15_000;
const MAX_ERROR = 500;
/** later(): how far ahead, and how many per run and per rule. What a later run is for, the code keeps in its state. */
export const LATER_MIN_SECONDS = 60;
export const LATER_MAX_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LATER_PER_RUN = 10;
export const MAX_PENDING_LATER = 100;
/** TIMER runs that ask for later() again: at most this many in a row, so a rule cannot keep itself going forever. */
export const MAX_LATER_CHAIN = 10;
/** A rule's later() runs that came while it was over its per-minute limit wait this much longer. */
const LATER_RETRY_MS = 60_000;
/** The longest the timer for later() sleeps at once (timers further off are looked at again then). */
const LATER_MAX_SLEEP_MS = 6 * 60 * 60 * 1000;
/** A debounced rule runs at the latest this many debounce periods after the first event. */
const MAX_WAIT_PERIODS = 5;

export interface RuleEngineDeps {
  store: Store;
  caches: Pick<GuildCaches, "get">;
  planner: Pick<Planner, "runForRule">;
  selfId: () => string;
  now: () => number;
  makeReader: (scope: ReadScope) => Reader;
  /** A rule switched itself off; slash commands may need registering again. */
  onRulesChanged?: (guildId: string) => void;
  /** Tells the owner their rule switched itself off. Failures are ignored. */
  notifyOwner?: (userId: string, content: string) => Promise<void>;
  log: (message: string, error?: unknown) => void;
  run?: typeof runModule;
  /** Compiled uploaded modules, for rules that run one instead of JS. */
  wasm?: Pick<WasmRegistry, "compiled" | "resolve">;
  /** The judge model of whoever the run acts as, for judge() and rank() in rule code. */
  decide?: (userId: string) => Decide | undefined;
  /**
   * Whether the user is a member of the thread, asked of Discord because the
   * cache does not track thread members. Without it, private threads are never shown.
   */
  threadMember?: (threadId: string, userId: string) => Promise<boolean>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Runs a cron schedule until stopped (croner; replaced in tests). */
  startCron?: typeof startCron;
  /** The servers the bot serves now, whose later() requests may run. */
  guildIds?: () => Iterable<string>;
}

/** One event of a run, as the code reads it in `batch`. */
export interface BatchItem {
  eventName: string;
  event: Data;
}

/**
 * Who made a bot-made event: the rule whose write it was, null for a write
 * from a conversation, undefined when it cannot be told (the bot's own posts
 * and reactions).
 */
export interface Origin {
  rule: string | null | undefined;
}

/** How a command's run went, for the reply to whoever ran it. */
export interface CommandReport {
  outcome: RunOutcome | "skipped";
  /** Why it did not run or failed. */
  error: string | null;
  /** What the code passed to reply(). */
  reply: string | null;
  /** Images the code made for the reply. */
  images: CommandImage[];
  /** What the code passed to respond(): its `data` joins the reply (components such as buttons). */
  response?: unknown;
  steps: number;
  /** The run's later() requests, kept; the reply's message is added to them once it is sent. */
  timers?: number[];
}

/** An image a command's code drew, rendered or converted for its reply. */
export interface CommandImage {
  name: string;
  data: Buffer;
}

export function haltKey(guildId: string): string {
  return `rules_halted:${guildId}`;
}

export interface Halt {
  by: string;
  at: string;
}

type Data = Record<string, any>;

export class RuleEngine {
  readonly deps: RuleEngineDeps;
  /** `${guildId}\u0000${resource}` -> when the bot last wrote it, and for which rule. */
  readonly #recent = new Map<string, { at: number; rule: string | null }>();
  /** Debounced rules waiting for a quiet moment. */
  readonly #pending = new Map<string, { version: number; first: number; timer: unknown; batch: BatchItem[] }>();
  /** Start times of recent runs per rule, for the per-minute limit. */
  readonly #runs = new Map<string, number[]>();
  /** Events that came while a rule was over its per-minute limit, run together once it is not. */
  readonly #deferred = new Map<string, { version: number; batches: BatchItem[][]; timer: unknown }>();
  /** Rules whose rate-limit skip was already recorded this minute, so a flood leaves one row. */
  readonly #limitedNoted = new Map<string, number>();
  /** Runs that must not overlap, one after another in the order events arrived (see serialKey). */
  readonly #queues = new Map<string, Promise<void>>();
  #unqueued = 0;
  /** Interactions rules may still answer, by interaction id. */
  readonly #answers = new Map<string, { responder: InteractionResponder; at: number }>();

  constructor(deps: RuleEngineDeps) {
    this.deps = deps;
  }

  halted(guildId: string): Halt | null {
    const raw = this.deps.store.getMeta(haltKey(guildId));
    return raw ? (JSON.parse(raw) as Halt) : null;
  }

  /** The Planner reports each write, so events it causes are recognised. */
  noteWrite(plan: Plan, step: Step, response: unknown): void {
    const now = { at: this.deps.now(), rule: plan.rule?.id ?? null };
    const spec = CATALOG.get(step.op);
    const target = spec?.target?.(step.pathParams, plan.guildId);
    if (target) this.#recent.set(`${plan.guildId}\u0000${target}`, now);
    const created = createdKindOf(step.op);
    if (created) {
      this.#recent.set(`${plan.guildId}\u0000create:${created}`, now);
      const id = (response as { id?: string } | null)?.id;
      if (id) this.#recent.set(`${plan.guildId}\u0000${created}:${id}`, now);
    }
    if (step.op === "PATCH /guilds/{guild}/members/{user}") {
      const body = (step.body ?? {}) as Record<string, unknown>;
      const user = String(step.pathParams.user);
      if (Object.hasOwn(body, "channel_id")) this.#recent.set(`${plan.guildId}\u0000${voiceMoveKey(user, (body.channel_id as string | null) ?? null)}`, now);
      if (Object.hasOwn(body, "mute") || Object.hasOwn(body, "deaf")) this.#recent.set(`${plan.guildId}\u0000${voiceMuteKey(user)}`, now);
    }
    if (step.op === "POST /channels/{channel}/messages") {
      const id = (response as { id?: string } | null)?.id;
      if (id) this.#recent.set(`${plan.guildId}\u0000message:${step.pathParams.channel}/${id}`, now);
    }
    if (step.op === "DELETE /channels/{channel}/messages/{message}/reactions/{emoji}/{user}") {
      const p = step.pathParams as Record<string, string>;
      this.#recent.set(`${plan.guildId}\u0000${reactionKey(p.channel!, p.message!, p.emoji!, p.user!)}`, now);
    }
  }

  #recentWrite(guildId: string, key: string): { at: number; rule: string | null } | undefined {
    const write = this.#recent.get(`${guildId}\u0000${key}`);
    return write && this.deps.now() - write.at < RECENT_WRITE_MS ? write : undefined;
  }

  /** Whether the bot caused the event, as far as the payload and its own recent writes tell. */
  byBot(event: string, guildId: string, data: Data): boolean {
    return this.origin(event, guildId, data) !== null;
  }

  /** Who among the bot's writers caused the event, or null when the bot did not. */
  origin(event: string, guildId: string, data: Data): Origin | null {
    const spec = TRIGGERS[event]!;
    for (const key of spec.resources?.(data) ?? []) {
      const write = this.#recentWrite(guildId, key);
      if (write) return { rule: write.rule };
    }
    if (spec.createdKind) {
      const write = this.#recentWrite(guildId, `create:${spec.createdKind}`);
      if (write) return { rule: write.rule };
    }
    for (const key of spec.outcomes?.(data) ?? []) {
      const write = this.#recentWrite(guildId, key);
      if (!write) continue;
      this.#recent.delete(`${guildId}\u0000${key}`);
      return { rule: write.rule };
    }
    if (spec.actorId?.(data) === this.deps.selfId()) return { rule: undefined };
    return null;
  }

  /** Whether a rule fires on an event the bot made, by its include_bot_origin setting. */
  #firesOnBot(rule: Rule, origin: Origin): boolean {
    const setting = rule.trigger.includeBotOrigin;
    if (setting === true) return true;
    // Its own writes, and writes nobody can tell apart from them, would loop.
    if (setting === "other_rules") return origin.rule !== undefined && origin.rule !== rule.id;
    return false;
  }

  /** The owner (for a command, whoever ran it) must be able to view where the event happened. Events with no channel are server-wide. */
  #visible(rule: Rule, guild: GuildState, event: string, data: Data, userId = rule.ownerId): boolean {
    const spec = TRIGGERS[event]!;
    const owner = guild.members.get(userId);
    if (!owner) return false;
    const channelId = spec.channel?.(data);
    if (!channelId) return true;
    let view = guild;
    // A created or deleted channel may not be in the cache; its own overwrites decide.
    if (spec.isChannel && data.id) view = { ...guild, channels: new Map(guild.channels).set(data.id, toChannel(data as never)) };
    return canView(view, owner, channelId);
  }

  /**
   * #visible goes by channel permissions, which a thread takes from its parent;
   * a private thread is also shown only to its members (and to those who manage
   * threads), so they are asked of Discord. Only when the run starts, as it is async.
   */
  async #inThread(guild: GuildState, event: string, data: Data, userId: string): Promise<boolean> {
    const spec = TRIGGERS[event]!;
    const channelId = spec.channel?.(data);
    if (!channelId) return true;
    const member = guild.members.get(userId);
    if (!member) return false;
    let view = guild;
    if (spec.isChannel && data.id) view = { ...guild, channels: new Map(guild.channels).set(data.id, toChannel(data as never)) };
    if (!needsThreadMembership(view, member, channelId)) return true;
    try {
      return (await this.deps.threadMember?.(channelId, userId)) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Called for every Gateway event a rule can use. The checks that decide
   * whether a rule runs happen now, against the state at the moment of the
   * event; the runs themselves go side by side unless serialKey says they must wait.
   */
  dispatch(event: string, guildId: string | undefined, data: Data): void {
    if (!guildId || !TRIGGERS[event]) return;
    const cache = this.deps.caches.get(guildId);
    if (!cache?.guild) return;
    const rules = this.deps.store.enabledRules(guildId, event);
    if (rules.length === 0 || this.halted(guildId)) return;
    const guild = cache.guild;
    const origin = TRIGGERS[event]!.synthetic ? null : this.origin(event, guildId, data);
    for (const rule of rules) {
      if (origin && !this.#firesOnBot(rule, origin)) continue;
      const actor = this.#actorFor(rule, event, data);
      if (actor === null || !this.#visible(rule, guild, event, data, actor ?? rule.ownerId)) continue;
      this.#fire(rule, event, data);
    }
  }

  /**
   * A button, select or form on one of the bot's messages. Every enabled
   * INTERACTION_CREATE rule runs at once (no batching, since each press waits
   * for its own answer); one over its per-minute limit is skipped. By default
   * a run acts as whoever pressed, like a command: what everyone in the
   * channel may read, the allow list within their permissions, their judge
   * model. A rule set to run as its owner acts as an event rule does.
   * `responder` answers whoever pressed.
   */
  dispatchInteraction(guildId: string, data: Data, responder: InteractionResponder): { fired: number; limited: number } {
    const counts = { fired: 0, limited: 0 };
    const guild = this.deps.caches.get(guildId)?.guild;
    if (!guild || this.halted(guildId)) return counts;
    const rules = this.deps.store.enabledRules(guildId, "INTERACTION_CREATE").filter((rule) => {
      const actor = this.#actorFor(rule, "INTERACTION_CREATE", data);
      return actor !== null && this.#visible(rule, guild, "INTERACTION_CREATE", data, actor ?? rule.ownerId);
    });
    if (rules.length === 0) return counts;
    this.#answers.set(String(data.id), { responder, at: this.deps.now() });
    for (const rule of rules) {
      if (this.#allowRun(rule) !== 0) {
        counts.limited++;
        continue;
      }
      counts.fired++;
      const actor = this.#actorFor(rule, "INTERACTION_CREATE", data) ?? undefined;
      const reader = actor ? this.#actorReader(guildId, "INTERACTION_CREATE", data, actor) : undefined;
      this.#enqueue(serialKey(rule, data), () => this.#run(rule.id, rule.version, eventIdOf("INTERACTION_CREATE", data), [{ eventName: "INTERACTION_CREATE", event: data }], reader, actor));
    }
    return counts;
  }

  /** The cron job of each SCHEDULE rule that is on, by rule id. */
  readonly #schedules = new Map<string, { guildId: string; version: number; job: { stop(): void } }>();

  /**
   * Starts and stops the cron jobs of a server's SCHEDULE rules to match the
   * rules that are on now. Called when the server becomes ready and whenever
   * its rules change; nothing checks the clock in between.
   */
  syncSchedules(guildId: string): void {
    const ready = !!this.deps.caches.get(guildId)?.guild;
    const wanted = new Map((ready ? this.deps.store.enabledRules(guildId, "SCHEDULE") : []).map((rule) => [rule.id, rule]));
    for (const [id, entry] of this.#schedules) {
      if (entry.guildId !== guildId || wanted.get(id)?.version === entry.version) continue;
      entry.job.stop();
      this.#schedules.delete(id);
    }
    for (const rule of wanted.values()) {
      if (this.#schedules.has(rule.id)) continue;
      const timezone = rule.trigger.timezone ?? DEFAULT_TIMEZONE;
      try {
        parseCron(rule.trigger.schedule ?? "", timezone);
      } catch {
        continue; // Checked at approval; a schedule that no longer parses just never fires.
      }
      const job = (this.deps.startCron ?? startCron)(rule.trigger.schedule!, timezone, () => this.#scheduled(rule.id, rule.version));
      this.#schedules.set(rule.id, { guildId, version: rule.version, job });
    }
  }

  /** A SCHEDULE rule's time came. */
  #scheduled(ruleId: string, version: number): void {
    const rule = this.deps.store.getRule(ruleId);
    if (!rule?.enabled || rule.version !== version || this.halted(rule.guildId) || !this.deps.caches.get(rule.guildId)?.guild) return;
    this.#fire(rule, "SCHEDULE", syntheticEvent("SCHEDULE", rule.guildId, rule.trigger, this.deps.now())!);
  }

  /** Stops every cron job and the later() timer (shutdown and tests). */
  stopSchedules(): void {
    for (const entry of this.#schedules.values()) entry.job.stop();
    this.#schedules.clear();
    if (this.#sleep) (this.deps.clearTimer ?? defaultClearTimer)(this.#sleep.timer);
    this.#sleep = null;
  }

  /** The timer for the earliest later() request, and when it is due. */
  #sleep: { timer: unknown; at: number } | null = null;

  /**
   * Runs the later() requests that are due in these servers (a server that just
   * became ready runs what came due while it was not), then sleeps until the next.
   */
  runTimers(guildIds: Iterable<string>, now = this.deps.now()): void {
    for (const guildId of guildIds) {
      if (!this.deps.caches.get(guildId)?.guild) continue;
      // Stopped rules drop what they asked for meanwhile, rather than act on it late.
      const timers = this.deps.store.takeDueRuleTimers(guildId, now);
      if (this.halted(guildId)) continue;
      for (const timer of timers) this.#fireTimer(timer, now);
    }
    this.#armTimers();
  }

  /** Sleeps until the earliest later() request of the servers being served. */
  #armTimers(): void {
    const { setTimer = defaultSetTimer, clearTimer = defaultClearTimer } = this.deps;
    const served = [...(this.deps.guildIds?.() ?? [])].filter((id) => this.deps.caches.get(id)?.guild);
    const next = this.deps.store.nextRuleTimerDue(served);
    if (next === null) {
      if (this.#sleep) clearTimer(this.#sleep.timer);
      this.#sleep = null;
      return;
    }
    const now = this.deps.now();
    const at = Math.min(Math.max(next, now), now + LATER_MAX_SLEEP_MS);
    if (this.#sleep && this.#sleep.at <= at) return;
    if (this.#sleep) clearTimer(this.#sleep.timer);
    this.#sleep = {
      at,
      timer: setTimer(() => {
        this.#sleep = null;
        this.runTimers(this.deps.guildIds?.() ?? []);
      }, at - now),
    };
  }

  /** A later() request's time came: the rule runs on it as whoever the run that asked acted as. */
  #fireTimer(timer: RuleTimer, now: number): void {
    const { store } = this.deps;
    const rule = store.getRule(timer.ruleId);
    if (!rule?.enabled) return;
    const event: Data = {
      guild_id: timer.guildId,
      due_at: new Date(timer.dueAt).toISOString(),
      chain: timer.chain,
      ...(timer.message ? { message: { channel_id: timer.message.channelId, id: timer.message.messageId } } : {}),
    };
    if (this.#allowRun(rule) !== 0) {
      // Kept for a little later rather than lost.
      const [id] = store.addRuleTimers(rule.id, rule.guildId, timer.actorId, [{ dueAt: now + LATER_RETRY_MS, chain: timer.chain }]);
      if (timer.message) store.setRuleTimersMessage([id!], timer.message.channelId, timer.message.messageId);
      return; // runTimers sleeps until it after this.
    }
    const actor = timer.actorId && timer.actorId !== rule.ownerId ? timer.actorId : undefined;
    // A command's reply is read as the command was: from its channel (a private thread too), within what everyone there can see.
    const reader = timer.message
      ? this.deps.makeReader({ guildId: rule.guildId, channelId: timer.message.channelId, speakerId: actor ?? rule.ownerId, audience: "channel" })
      : actor ? this.deps.makeReader({ guildId: rule.guildId, channelId: "", speakerId: actor, audience: "owner" }) : undefined;
    this.#enqueue(serialKey(rule, event), () => this.#run(rule.id, rule.version, `TIMER:${timer.id}`, [{ eventName: "TIMER", event }], reader, actor));
  }

  /**
   * Whom a run on this event acts as: undefined for the owner, null when it
   * cannot run (the person who did it is not known). Reactions and presses act
   * as whoever made them, as a command does, unless the rule runs as its owner;
   * the bot's own reactions act as the owner, as they come from what was approved.
   */
  #actorFor(rule: Rule, event: string, data: Data): string | null | undefined {
    if (rule.trigger.runAs === "owner" || !ACTOR_EVENTS.has(event)) return undefined;
    const id = TRIGGERS[event]!.actorId?.(data);
    if (!id) return null;
    return id === this.deps.selfId() ? undefined : id;
  }

  /** The reader of a run acting as someone else: for a press, what everyone in the channel may see (the answer may go there); else theirs. */
  #actorReader(guildId: string, event: string, data: Data, actor: string): Reader {
    const channelId = String(TRIGGERS[event]!.channel?.(data) ?? "");
    return this.deps.makeReader({ guildId, channelId, speakerId: actor, audience: event === "INTERACTION_CREATE" ? "channel" : "owner" });
  }

  /** Runs now, or after the rule's debounce. */
  #fire(rule: Rule, event: string, data: Data): void {
    if (rule.trigger.debounceSeconds) {
      this.#debounce(rule, { eventName: event, event: data });
      return;
    }
    this.#start(rule, [{ eventName: event, event: data }]);
  }

  /**
   * Runs on a batch now, or, past the rule's per-minute limit, once a run is
   * allowed again: events that come meanwhile join that one run's batch, so
   * the last state is never left unhandled.
   */
  #start(rule: Rule, batch: BatchItem[]): void {
    const wait = this.#allowRun(rule);
    if (wait === 0) {
      const last = batch.at(-1)!;
      // A batch acts as whoever caused its last event; #run drops the events they may not see.
      const actor = this.#actorFor(rule, last.eventName, last.event);
      if (actor === null) return;
      const reader = actor ? this.#actorReader(rule.guildId, last.eventName, last.event, actor) : undefined;
      this.#enqueue(serialKey(rule, last.event), () => this.#run(rule.id, rule.version, eventIdOf(last.eventName, last.event), batch, reader, actor));
      return;
    }
    const { setTimer = defaultSetTimer } = this.deps;
    let deferred = this.#deferred.get(rule.id);
    if (deferred && deferred.version !== rule.version) deferred = undefined;
    const fresh = !deferred;
    deferred ??= { version: rule.version, batches: [], timer: null };
    // Nothing is dropped: past MAX_BATCH the events wait in the next batch, which runs as the limit allows.
    for (const item of batch) {
      const last = deferred.batches.at(-1);
      if (last && last.length < MAX_BATCH) last.push(item);
      else deferred.batches.push([item]);
    }
    if (!fresh) return;
    this.#deferred.set(rule.id, deferred);
    deferred.timer = setTimer(() => this.#resume(rule.id), wait);
  }

  /** The limit allows a run again: the batches that waited run in order, each as the limit allows. */
  #resume(ruleId: string): void {
    const deferred = this.#deferred.get(ruleId);
    if (!deferred) return;
    this.#deferred.delete(ruleId);
    const rule = this.deps.store.getRule(ruleId);
    if (!rule?.enabled || rule.version !== deferred.version || this.halted(rule.guildId)) return;
    for (const batch of deferred.batches) this.#start(rule, batch);
  }

  #debounce(rule: Rule, item: BatchItem): void {
    const { setTimer = defaultSetTimer, clearTimer = defaultClearTimer } = this.deps;
    const now = this.deps.now();
    let pending = this.#pending.get(rule.id);
    if (pending && pending.version !== rule.version) {
      clearTimer(pending.timer);
      pending = undefined;
    }
    pending ??= { version: rule.version, first: now, timer: null, batch: [] };
    pending.batch.push(item);
    clearTimer(pending.timer);
    this.#pending.set(rule.id, pending);
    // A full batch runs now rather than dropping events.
    if (pending.batch.length >= MAX_BATCH) {
      this.#flush(rule.id);
      return;
    }
    const period = rule.trigger.debounceSeconds! * 1000;
    const wait = Math.max(0, Math.min(period, pending.first + period * MAX_WAIT_PERIODS - now));
    pending.timer = setTimer(() => this.#flush(rule.id), wait);
  }

  /** A debounced rule's quiet moment came: one run on its batch, the latest event as `event`. */
  #flush(ruleId: string): void {
    const pending = this.#pending.get(ruleId);
    if (!pending) return;
    this.#pending.delete(ruleId);
    const rule = this.deps.store.getRule(ruleId);
    const last = pending.batch.at(-1);
    if (!rule?.enabled || rule.version !== pending.version || !last) return;
    this.#start(rule, pending.batch);
  }

  /** Runs every debounced or held-back rule now instead of after its wait (tests and shutdown). */
  flushDebounced(): void {
    for (const [id, pending] of this.#pending) {
      (this.deps.clearTimer ?? defaultClearTimer)(pending.timer);
      this.#flush(id);
    }
    for (const [id, deferred] of this.#deferred) {
      (this.deps.clearTimer ?? defaultClearTimer)(deferred.timer);
      this.#runs.delete(id);
      this.#resume(id);
    }
  }

  /** 0 when the rule may run now (and counts the run), else how long until it may. */
  #allowRun(rule: Rule): number {
    const now = this.deps.now();
    const recent = (this.#runs.get(rule.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= rule.limits.perMinute) {
      this.#runs.set(rule.id, recent);
      if ((this.#limitedNoted.get(rule.id) ?? 0) <= now) {
        this.#limitedNoted.set(rule.id, now + 60_000);
        const id = this.deps.store.startRuleRun({ ruleId: rule.id, ruleVersion: rule.version, eventId: "-" });
        this.deps.store.finishRuleRun(id, { outcome: "rate_limited", error: `1分あたり${rule.limits.perMinute}回を超えたため、この間のイベントは枠が空いたときにまとめて1回で処理します` });
      }
      return Math.max(1, recent[0]! + 60_000 - now);
    }
    recent.push(now);
    this.#runs.set(rule.id, recent);
    return 0;
  }

  /** Runs with the same key go one after another; a run without one starts at once. */
  #enqueue(key: string | null, task: () => Promise<unknown>): void {
    const queue = key ?? `\u0000${++this.#unqueued}`;
    const next = (this.#queues.get(queue) ?? Promise.resolve()).then(async () => void (await task())).catch((e) => this.deps.log("ルールの実行に失敗", e));
    this.#queues.set(queue, next);
    void next.finally(() => {
      if (this.#queues.get(queue) === next) this.#queues.delete(queue);
    });
  }

  /** Waits for queued runs (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all(this.#queues.values());
  }

  /** `actorId` is whose permissions and models the run uses: the owner's, or for a command whoever ran it. */
  async #run(ruleId: string, version: number, eventId: string, batch: BatchItem[], reader?: Pick<Reader, "get">, actorId?: string): Promise<CommandReport | null> {
    const { store } = this.deps;
    // The rule may have been switched off, changed or stopped while queued.
    const rule = store.getRule(ruleId);
    if (!rule?.enabled || rule.version !== version || this.halted(rule.guildId)) return null;
    const actor = actorId ?? rule.ownerId;
    const command = actorId !== undefined;
    const guild = this.deps.caches.get(rule.guildId)?.guild;
    if (!guild) return null;
    // Checked again now, not only when the events came: a debounced, held-back or queued run
    // may start well after them, and roles can change in between.
    const shown = batch.filter((item) => this.#visible(rule, guild, item.eventName, item.event, actor));
    const members = await Promise.all(shown.map((item) => this.#inThread(guild, item.eventName, item.event, actor)));
    const visible = shown.filter((_, i) => members[i]);
    if (visible.length === 0) return command ? { outcome: "skipped", error: "このチャンネルを見られる人として確認できないため、ここでは動きません", reply: null, images: [], steps: 0 } : null;
    batch = visible;
    const runId = store.startRuleRun({ ruleId, ruleVersion: version, eventId });
    // The owner must still hold everything the rule allows, as at approval, even when someone else ran its command.
    const owned = ownerAllowProblems(guild, rule.ownerId, this.deps.selfId(), rule.allow, "ルールの作成者");
    if (owned.length > 0) {
      const error = owned.join("\n").slice(0, MAX_ERROR);
      store.finishRuleRun(runId, { outcome: "rejected", error, logs: [] });
      store.audit({ kind: "user", userId: actor, via: "rule" }, "rule.run", { outcome: "rejected", event: eventId, version }, undefined, rule.id);
      // This is the rule's own problem, so it counts toward switching the rule off.
      this.#settle(rule, true, error);
      return { outcome: "rejected", error, reply: null, images: [], steps: 0 };
    }
    const last = batch.at(-1)!;
    let result = await this.evaluate(rule, last.event, reader, last.eventName, batch, store.getRuleState(rule.id), last.eventName === "COMMAND", actor);
    if (result.later?.length && store.countRuleTimers(rule.id) + result.later.length > MAX_PENDING_LATER) {
      result = { kind: "error", error: `later() で待っている予約がルールごとの上限(${MAX_PENDING_LATER}件)を超えます`, logs: result.logs };
    }
    // A TIMER run that asks again continues the chain; a chain ends after MAX_LATER_CHAIN runs.
    const chain = last.eventName === "TIMER" ? Number(last.event.chain) || 1 : 0;
    if (result.later?.length && chain >= MAX_LATER_CHAIN) {
      result = { kind: "error", error: `later() の予約から動いた実行が続けて予約できるのは${MAX_LATER_CHAIN}回までです(無限に続かないように)`, logs: result.logs };
    }
    const reply = result.reply ?? null;
    const images = result.images ?? [];
    // A form must be the interaction's first answer, so it goes before the changes; other answers wait for them.
    const responder = last.eventName === "INTERACTION_CREATE" ? this.#answers.get(String(last.event.id))?.responder : undefined;
    const response = responder ? result.response : undefined;
    let answerError: string | null = null;
    if (response !== undefined && (isModalResponse(response) || result.kind === "none")) answerError = await responder!.send(response);
    // Kept only when the run went through, so a failed run is retried from the same state.
    let timers: number[] = [];
    const keepState = () => {
      if (result.state) store.setRuleState(rule.id, result.state.value);
      if (result.later?.length) {
        timers = store.addRuleTimers(rule.id, rule.guildId, actor === rule.ownerId ? null : actor, result.later.map((dueAt) => ({ dueAt, chain: chain + 1 })));
        this.#armTimers();
      }
    };
    if (result.kind !== "steps") {
      if (result.kind === "none") keepState();
      const error = result.kind === "error" ? result.error : answerError;
      const outcome = error === null ? "no_change" : "failed";
      store.finishRuleRun(runId, { outcome, error, logs: result.logs });
      // A command run that failed only because whoever ran it has no judge model is not the rule's fault.
      this.#settle(rule, (result.kind === "error" && !(command && error?.includes(NO_DECIDE))) || answerError !== null, error);
      return { outcome, error, reply, images, steps: 0, ...(result.response !== undefined ? { response: result.response } : {}), ...(timers.length ? { timers } : {}) };
    }
    // A TIMER from a command may edit that command's reply as whoever ran it, without managing messages.
    const replied = last.eventName === "TIMER" ? (last.event.message as { channel_id?: string; id?: string } | undefined) : undefined;
    const ownReply = replied?.channel_id && replied.id ? { channelId: replied.channel_id, messageId: replied.id } : undefined;
    let outcome: RunOutcome;
    let planId: string | null = null;
    let error: string | null = null;
    try {
      const done = await this.deps.planner.runForRule({
        guildId: rule.guildId,
        actorId: actor,
        rule: { id: rule.id, version: rule.version, name: rule.name, eventId, ownerId: rule.ownerId, allow: rule.allow, ...(ownReply ? { ownReply } : {}) },
        drafts: result.drafts,
        ...(images.length ? { images: Object.fromEntries(images.map((image, i) => [`img${i + 1}`, { name: image.name, data: image.data.toString("base64") }])) } : {}),
      });
      planId = done.plan.id;
      outcome = done.status === "succeeded" ? "executed" : "failed";
      if (outcome === "failed") error = done.reason ?? done.status;
    } catch (e) {
      outcome = e instanceof PlanRejected ? "rejected" : "failed";
      error = e instanceof PlanRejected ? e.reasons.join("\n") : e instanceof Error ? e.message : String(e);
    }
    if (response !== undefined && !isModalResponse(response)) {
      if (outcome === "executed") answerError = await responder!.send(response);
      // Acting as whoever pressed, the reasons are about their own permissions.
      else await responder!.failed(rule.name, command ? (error ?? undefined)?.slice(0, 500) : undefined);
    }
    if (outcome === "executed") keepState();
    // The changes stand (and so does the state), but an answer Discord turned down is the rule's failure.
    if (answerError) {
      outcome = "failed";
      error = error ? `${error}\n${answerError}` : answerError;
    }
    store.finishRuleRun(runId, { outcome, planId, error: error?.slice(0, MAX_ERROR) ?? null, logs: result.logs });
    store.audit({ kind: "user", userId: actor, via: "rule" }, "rule.run", { outcome, event: eventId, version }, planId ?? undefined, rule.id);
    // A command turned down for what its runner may not do says nothing about the rule, and must not let anyone switch it off.
    this.#settle(rule, outcome === "failed" || (outcome === "rejected" && !command), error);
    return { outcome, error: error?.slice(0, MAX_ERROR) ?? null, reply, images, steps: result.drafts.length, ...(result.response !== undefined ? { response: result.response } : {}), ...(timers.length ? { timers } : {}) };
  }

  /**
   * Someone ran a COMMAND rule's slash command. The run waits its turn like any
   * other in the server and acts as that person: what the code reads is limited
   * to what everyone in the channel (and they) may see, since the reply goes
   * back there; its steps are checked against the allow list and their
   * permissions; judge() and rank() use their judge model. A rule that runs as
   * its owner uses the owner's permissions and model instead, with the same reads.
   */
  async runCommand(rule: Rule, event: Data, userId: string): Promise<CommandReport> {
    const skipped = (error: string): CommandReport => ({ outcome: "skipped", error, reply: null, images: [], steps: 0 });
    if (!rule.enabled) return skipped("このコマンドのルールは止まっています");
    if (this.halted(rule.guildId)) return skipped("このサーバーの全ルールが止められています");
    const guild = this.deps.caches.get(rule.guildId)?.guild;
    const channelId = typeof event.channel_id === "string" ? event.channel_id : "";
    if (!guild || !channelId || !this.#visible(rule, guild, "COMMAND", event, userId)) return skipped("このチャンネルを見られる人として確認できないため、ここでは動きません");
    if (this.#allowRun(rule) !== 0) return skipped(`1分に${rule.limits.perMinute}回までです。少し待ってからもう一度使ってください`);
    const actor = rule.trigger.runAs === "owner" ? rule.ownerId : userId;
    const reader = this.deps.makeReader({ guildId: rule.guildId, channelId, speakerId: actor, audience: "channel" });
    return new Promise((resolve) => {
      this.#enqueue(serialKey(rule, event), async () => {
        try {
          resolve((await this.#run(rule.id, rule.version, eventIdOf("COMMAND", event), [{ eventName: "COMMAND", event }], reader, actor)) ?? skipped("このコマンドのルールは止まっています"));
        } catch (e) {
          resolve(skipped(e instanceof Error ? e.message : String(e)));
          throw e;
        }
      });
    });
  }

  /** Counts the outcome; too many failures in a row switch the rule off and tell its owner. */
  #settle(rule: Rule, failed: boolean, error: string | null): void {
    const { store } = this.deps;
    const count = store.recordRuleResult(rule.id, failed);
    if (!failed || count < rule.limits.maxConsecutiveFailures) return;
    const reason = `${count}回続けて失敗したため自動で止めました`;
    store.setRuleEnabled(rule.id, false, reason);
    store.audit({ kind: "system" }, "rule.auto_disable", { reason, lastError: error?.slice(0, MAX_ERROR) ?? null }, undefined, rule.id);
    this.deps.onRulesChanged?.(rule.guildId);
    void this.deps.notifyOwner?.(
      rule.ownerId,
      `ルール「${rule.name}」は${count}回続けて失敗したため止めました。最後のエラー: ${(error ?? "").slice(0, 300)}\n直したら \`/settings\` の「ルール」から有効にできます。`,
    ).catch(() => undefined);
  }

  /**
   * Runs the rule's code on one event and returns the steps it asks for.
   * Used for real runs and for dry runs, which stop here. `actorId` is whose
   * read scope and judge model the code gets; by default the owner's.
   */
  async evaluate(
    rule: Pick<Rule, "guildId" | "ownerId" | "program" | "params"> & Partial<Pick<Rule, "trigger">>,
    event: unknown,
    reader?: Pick<Reader, "get">,
    eventName: string | null = null,
    batch: BatchItem[] = eventName ? [{ eventName, event: event as Data }] : [],
    state: unknown = null,
    command = eventName === "COMMAND",
    actorId = rule.ownerId,
  ): Promise<Evaluation> {
    let result: SandboxResult;
    let replied: string | null = null;
    let response: unknown;
    const images: CommandImage[] = [];
    const later: number[] = [];
    try {
      const source = reader ?? this.ownerReader(rule.guildId, actorId);
      // Images for a command's reply or the run's posts (`files: ["img1"]`):
      // drawn, formulas, or converted from this run's images or a message's
      // attachments the reader may open.
      const keep = (data: Buffer, name: string) => (images.push({ data, name }), `img${images.length}`);
      const load = async (raw: unknown): Promise<Buffer> => {
        if (typeof raw === "string") {
          const found = /^img(\d+)$/.exec(raw) && images[Number(raw.slice(3)) - 1];
          if (!found) throw new Error(`画像 ${raw} はありません。この実行で作った画像のIDを指定してください`);
          return found.data;
        }
        const ref = raw as { message_id?: unknown; channel_id?: unknown; index?: unknown } | null;
        if (typeof ref?.message_id !== "string" || typeof ref.channel_id !== "string") throw new Error('画像は "img1" のようなIDか { message_id, channel_id, index } で指定してください');
        const message = (await source.get(`/channels/${ref.channel_id}/messages/${ref.message_id}`, {})) as APIMessage | null;
        const index = typeof ref.index === "number" ? ref.index : 0;
        const found = message && imageRefs(message).at(index);
        if (!found) throw new Error(`メッセージ ${ref.message_id} に${index ? ` ${index + 1}枚目の` : ""}画像がありません`);
        const image = await fetchImage(found);
        if (!image) throw new Error("画像を取得できませんでした(20MBまでの PNG・JPEG・GIF・WebP だけ扱えます)");
        return image.data;
      };
      const decider = this.deps.decide?.(actorId);
      const bindings: SandboxBindings = {
          guildId: rule.guildId,
          actor: { kind: "user", userId: actorId, via: "rule" },
          event,
          eventName,
          batch,
          state,
          params: rule.params ?? null,
          get: (route, query) => source.get(route, query as Record<string, string>),
          ...(command ? { reply: (text: string) => void (replied = (replied ? `${replied}\n${text}` : text).slice(0, MAX_REPLY)) } : {}),
          // A command is an interaction too: its respond() adds to the reply.
          ...(eventName === "INTERACTION_CREATE" || command ? { respond: (r: unknown) => void (response = r) } : {}),
          attach: (png: Buffer, name: string) => keep(png, `${name || "image"}.png`),
          later: (when: number | string) => void later.push(checkLater(when, later.length, rule.trigger?.timezone ?? DEFAULT_TIMEZONE, this.deps.now())),
          ...(decider ? { decide: decider } : {}),
          // The modules the code names are its author's, as for a rule's own wasm; they run with this run's bindings.
          ...(this.deps.wasm ? { wasm: (ref: string) => this.deps.wasm!.compiled(this.deps.wasm!.resolve(rule.ownerId, this.deps.caches.get(rule.guildId)?.guild, ref).sha256) } : {}),
          media: {
            math: async (tex: string, raw: unknown, name: string) => keep(await renderMath(tex, parseOptions(MathOptionsSchema, raw)), `${name || "math"}.svg`),
            convert: async (source: unknown, raw: unknown, name: string) => {
              const { data, format } = await convertImage(await load(source), parseOptions(ConvertOptionsSchema, raw));
              return keep(data, `${name || "image"}.${format === "jpeg" ? "jpg" : format}`);
            },
          },
      };
      let program: Program;
      if (rule.program.kind === "wasm") {
        if (!this.deps.wasm) throw new Error("Wasmのルールはここでは動かせません");
        program = { module: await this.deps.wasm.compiled(rule.program.sha256) };
      } else {
        program = await jsProgram(rule.program.code);
      }
      // A module draws with its own libraries and hands over the image; it is re-encoded so only real images go out.
      const image = async (data: Buffer, name: string) => {
        const { data: out, format } = await convertImage(data, {});
        return keep(out, `${name || "image"}.${format === "jpeg" ? "jpg" : format}`);
      };
      result = await (this.deps.run ?? runModule)(program, { ...bindings, image }, SANDBOX_LIMITS);
    } catch (e) {
      return { kind: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR), logs: [] };
    }
    if (!result.ok) return { kind: "error", error: (result.error ?? "不明なエラー").slice(0, MAX_ERROR), logs: result.logs };
    if (result.state && JSON.stringify(result.state.value ?? null).length > MAX_STATE_JSON) {
      return { kind: "error", error: `setState の値はJSONで${MAX_STATE_JSON}文字までです`, logs: result.logs };
    }
    const saved = {
      ...(result.state ? { state: result.state } : {}),
      ...(replied !== null ? { reply: replied } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(images.length ? { images } : {}),
      ...(later.length ? { later } : {}),
    };
    const value = result.value as { steps?: unknown } | null | undefined;
    if (value === undefined || value === null) return { kind: "none", logs: result.logs, ...saved };
    if (!Array.isArray(value.steps)) return { kind: "error", error: "コードは plan([...]) を return してください", logs: result.logs };
    if (value.steps.length === 0) return { kind: "none", logs: result.logs, ...saved };
    return { kind: "steps", drafts: value.steps as StepDraft[], logs: result.logs, ...saved };
  }

  /** What a rule reads with: everything its owner and the bot can both read. */
  ownerReader(guildId: string, ownerId: string, channelId = ""): Reader {
    return this.deps.makeReader({ guildId, channelId, speakerId: ownerId, audience: "owner" });
  }

  /** The owner left the server: their rules stop, since nobody's permissions back them any more. */
  ownerLeft(guildId: string, userId: string): void {
    let changed = false;
    for (const rule of this.deps.store.listRules(guildId, userId)) {
      if (!rule.enabled) continue;
      const reason = "作成者がサーバーを抜けたため自動で止めました";
      this.deps.store.setRuleEnabled(rule.id, false, reason);
      this.deps.store.audit({ kind: "system" }, "rule.auto_disable", { reason }, undefined, rule.id);
      changed = true;
    }
    if (changed) this.deps.onRulesChanged?.(guildId);
  }

  /** Forgets old bookkeeping. Called every minute. */
  sweep(): void {
    const now = this.deps.now();
    for (const [key, write] of this.#recent) if (now - write.at >= RECENT_WRITE_MS) this.#recent.delete(key);
    for (const [key, answer] of this.#answers) if (now - answer.at >= ANSWER_TTL_MS) this.#answers.delete(key);
    for (const [key, until] of this.#limitedNoted) if (until <= now) this.#limitedNoted.delete(key);
    for (const [key, times] of this.#runs) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length === 0) this.#runs.delete(key);
      else this.#runs.set(key, recent);
    }
  }
}

/**
 * The queue a run waits in, or null to start at once. A debounced rule's
 * batches and a rule that keeps state (the JS calls setState; a module may
 * always write it) go one at a time, so no update is lost; serial_by asks for
 * the whole rule or for runs whose events share a value.
 */
export function serialKey(rule: Pick<Rule, "id" | "trigger" | "program">, event: Data): string | null {
  const keepsState = rule.program.kind === "wasm" || /\bsetState\s*\(/.test(rule.program.code);
  const by = rule.trigger.serialBy;
  if (rule.trigger.debounceSeconds || keepsState || by === "rule") return rule.id;
  if (!by) return null;
  let value: unknown = event;
  for (const part of by.split(".")) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  // Without a value to tell runs apart, the whole rule waits.
  if (value === undefined || value === null) return rule.id;
  return `${rule.id}\u0000${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: unknown): void {
  if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * When a later() request is due, run once: `when` seconds from now, the next
 * time an ISO 8601 value names (see isoNext), or the next match of a cron
 * expression. Times without an offset and cron are read in the rule's time zone. `asked` is how many the run asked for before.
 */
function checkLater(when: number | string, asked: number, timezone: string, now: number): number {
  if (asked >= MAX_LATER_PER_RUN) throw new Error(`later() は1回の実行で${MAX_LATER_PER_RUN}回までです`);
  const max = now + LATER_MAX_SECONDS * 1000;
  if (typeof when === "number") {
    if (!Number.isFinite(when) || when < LATER_MIN_SECONDS || when > LATER_MAX_SECONDS) {
      throw new Error(`later() の秒数は${LATER_MIN_SECONDS}〜${LATER_MAX_SECONDS}(7日)にしてください`);
    }
    return now + Math.round(when) * 1000;
  }
  const text = when.trim();
  // A cron expression has fields apart (or is an @ alias); anything else is ISO 8601.
  if (!/\s/.test(text) && !text.startsWith("@")) {
    const due = isoNext(text, timezone, now);
    if (due === null) throw new Error(`later() の「${text}」は今より後の日時を指していません`);
    if (due < now + LATER_MIN_SECONDS * 1000 || due > max) throw new Error(`later() の「${text}」は今から1分〜7日の日時にしてください`);
    return due;
  }
  const next = parseCron(text, timezone).nextRun(new Date(now))?.getTime();
  if (next === undefined) throw new Error(`later() の cron「${text}」に当てはまる日時がありません`);
  if (next > max) throw new Error(`later() の cron「${text}」の次の日時が7日より先です`);
  return next;
}

/**
 * `state` is set when the code called setState: what to keep if the run goes through, as are the `later` requests.
 * `reply` is what a command's code passed to reply(), `response` what an INTERACTION_CREATE run's code passed to respond().
 */
export type Evaluation =
  | { kind: "steps"; drafts: StepDraft[]; logs: string[]; state?: { value: unknown }; reply?: string; response?: unknown; images?: CommandImage[]; later?: number[] }
  | { kind: "none"; logs: string[]; state?: { value: unknown }; reply?: string; response?: unknown; images?: CommandImage[]; later?: number[] }
  | { kind: "error"; error: string; logs: string[]; state?: undefined; reply?: string; response?: undefined; images?: undefined; later?: undefined };

/** A stable id for the event: its own id when it has one, otherwise a hash of the payload. */
export function eventIdOf(event: string, data: Data): string {
  const own = data.id ?? data.message_id ?? data.user?.id ?? data.user_id ?? data.role?.id ?? data.role_id;
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 10);
  return `${event}:${own ?? "-"}:${hash}`;
}
