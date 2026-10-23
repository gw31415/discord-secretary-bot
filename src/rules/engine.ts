import { createHash } from "node:crypto";
import type { Store } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import { toChannel } from "../discord/cache.ts";
import { canView } from "../discord/permissions.ts";
import type { GuildState } from "../discord/permissions.ts";
import type { Reader, ReadScope } from "../discord/reader.ts";
import { CATALOG } from "../plan/catalog.ts";
import type { Planner } from "../plan/service.ts";
import type { Plan, Step, StepDraft } from "../plan/types.ts";
import { PlanRejected } from "../plan/validate.ts";
import { jsProgram, SANDBOX_LIMITS } from "../sandbox.ts";
import type { Decide } from "../agent/decide.ts";
import type { SandboxBindings, SandboxResult } from "../sandbox.ts";
import { cronMatches, DEFAULT_TIMEZONE, parseCron } from "./schedule.ts";
import { createdKindOf, MAX_BATCH, reactionKey, syntheticEvent, TRIGGERS, voiceMoveKey, voiceMuteKey } from "./triggers.ts";
import { MAX_STATE_JSON } from "./types.ts";
import { MAX_REPLY } from "./command.ts";
import { fetchImage, imageRefs } from "../agent/images.ts";
import { convertImage, ConvertOptionsSchema, MathOptionsSchema, parseOptions, renderMath } from "../media.ts";
import type { APIMessage } from "discord-api-types/v10";
import type { Rule, RunOutcome } from "./types.ts";
import { runModule } from "../wasm/run.ts";
import type { Program } from "../wasm/run.ts";
import type { WasmRegistry } from "../wasm/registry.ts";

// Fires event rules. Each matching event runs the rule's code in the sandbox
// with its owner's read scope; the steps it returns go to the Planner, which
// checks them against the allow list and the owner's current permissions and
// runs them without a dialog. Safety: the bot's own changes are ignored unless
// the rule opts in, each rule is rate limited, repeated failures switch it off,
// and anyone with Manage Server can stop every rule in the server at once.
// SCHEDULE rules fire from tick() once a minute; rules with a debounce wait for
// a quiet moment and run once on the batch of events. COMMAND rules run when
// someone uses their slash command, and the outcome goes back to that person.

/** How long after the bot changes something an event about it counts as the bot's own. */
export const RECENT_WRITE_MS = 15_000;
const MAX_ERROR = 500;
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
  wasm?: Pick<WasmRegistry, "compiled">;
  /** The owner's judge model, for judge() and rank() in rule code. */
  decide?: (ownerId: string) => Decide | undefined;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
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
  steps: number;
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
  /** Rules whose rate-limit skip was already recorded this minute, so a flood leaves one row. */
  readonly #limitedNoted = new Map<string, number>();
  /** Runs that must not overlap, one after another in the order events arrived (see serialKey). */
  readonly #queues = new Map<string, Promise<void>>();
  #unqueued = 0;

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

  /** The owner must be able to view where the event happened. Events with no channel are server-wide. */
  #visible(rule: Rule, guild: GuildState, event: string, data: Data): boolean {
    const spec = TRIGGERS[event]!;
    const owner = guild.members.get(rule.ownerId);
    if (!owner) return false;
    const channelId = spec.channel?.(data);
    if (!channelId) return true;
    let view = guild;
    // A created or deleted channel may not be in the cache; its own overwrites decide.
    if (spec.isChannel && data.id) view = { ...guild, channels: new Map(guild.channels).set(data.id, toChannel(data as never)) };
    return canView(view, owner, channelId);
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
      if (!this.#visible(rule, guild, event, data)) continue;
      this.#fire(rule, event, data);
    }
  }

  /**
   * Fires SCHEDULE rules whose cron matches the minute of `now`, in the given
   * servers. Called once a minute; a minute is never fired twice.
   */
  tick(guildIds: Iterable<string>, now = this.deps.now()): void {
    const minute = Math.floor(now / 60_000) * 60_000;
    if (minute <= this.#lastTick) return;
    this.#lastTick = minute;
    for (const guildId of guildIds) {
      if (this.halted(guildId) || !this.deps.caches.get(guildId)?.guild) continue;
      for (const rule of this.deps.store.enabledRules(guildId, "SCHEDULE")) {
        try {
          if (!cronMatches(parseCron(rule.trigger.schedule ?? ""), minute, rule.trigger.timezone ?? DEFAULT_TIMEZONE)) continue;
        } catch {
          continue; // Checked at approval; a schedule that no longer parses just never fires.
        }
        this.#fire(rule, "SCHEDULE", syntheticEvent("SCHEDULE", guildId, rule.trigger, minute)!);
      }
    }
  }

  #lastTick = 0;

  /** Runs now, or after the rule's debounce. */
  #fire(rule: Rule, event: string, data: Data): void {
    if (rule.trigger.debounceSeconds) {
      this.#debounce(rule, { eventName: event, event: data });
      return;
    }
    if (!this.#allowRun(rule)) return;
    this.#enqueue(serialKey(rule, data), () => this.#run(rule.id, rule.version, eventIdOf(event, data), [{ eventName: event, event: data }]));
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
    if (pending.batch.length > MAX_BATCH) pending.batch.shift();
    clearTimer(pending.timer);
    const period = rule.trigger.debounceSeconds! * 1000;
    const wait = Math.max(0, Math.min(period, pending.first + period * MAX_WAIT_PERIODS - now));
    pending.timer = setTimer(() => this.#flush(rule.id), wait);
    this.#pending.set(rule.id, pending);
  }

  /** A debounced rule's quiet moment came: one run on its batch, the latest event as `event`. */
  #flush(ruleId: string): void {
    const pending = this.#pending.get(ruleId);
    if (!pending) return;
    this.#pending.delete(ruleId);
    const rule = this.deps.store.getRule(ruleId);
    const last = pending.batch.at(-1);
    if (!rule?.enabled || rule.version !== pending.version || !last) return;
    if (!this.#allowRun(rule)) return;
    this.#enqueue(serialKey(rule, last.event), () => this.#run(rule.id, rule.version, eventIdOf(last.eventName, last.event), pending.batch));
  }

  /** Runs every debounced rule now instead of after its wait (tests and shutdown). */
  flushDebounced(): void {
    for (const [id, pending] of this.#pending) {
      (this.deps.clearTimer ?? defaultClearTimer)(pending.timer);
      this.#flush(id);
    }
  }

  #allowRun(rule: Rule): boolean {
    const now = this.deps.now();
    const recent = (this.#runs.get(rule.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= rule.limits.perMinute) {
      this.#runs.set(rule.id, recent);
      if ((this.#limitedNoted.get(rule.id) ?? 0) <= now) {
        this.#limitedNoted.set(rule.id, now + 60_000);
        const id = this.deps.store.startRuleRun({ ruleId: rule.id, ruleVersion: rule.version, eventId: "-" });
        this.deps.store.finishRuleRun(id, { outcome: "rate_limited", error: `1分あたり${rule.limits.perMinute}回を超えたため、この1分の残りのイベントを飛ばしました` });
      }
      return false;
    }
    recent.push(now);
    this.#runs.set(rule.id, recent);
    return true;
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

  async #run(ruleId: string, version: number, eventId: string, batch: BatchItem[], reader?: Pick<Reader, "get">): Promise<CommandReport | null> {
    const { store } = this.deps;
    // The rule may have been switched off, changed or stopped while queued.
    const rule = store.getRule(ruleId);
    if (!rule?.enabled || rule.version !== version || this.halted(rule.guildId)) return null;
    const runId = store.startRuleRun({ ruleId, ruleVersion: version, eventId });
    const last = batch.at(-1)!;
    const result = await this.evaluate(rule, last.event, reader, last.eventName, batch, store.getRuleState(rule.id), last.eventName === "COMMAND");
    const reply = result.reply ?? null;
    const images = result.images ?? [];
    // Kept only when the run went through, so a failed run is retried from the same state.
    const keepState = () => {
      if (result.state) store.setRuleState(rule.id, result.state.value);
    };
    if (result.kind !== "steps") {
      if (result.kind === "none") keepState();
      const outcome = result.kind === "none" ? "no_change" : "failed";
      const error = result.kind === "error" ? result.error : null;
      store.finishRuleRun(runId, { outcome, error, logs: result.logs });
      this.#settle(rule, result.kind === "error", error);
      return { outcome, error, reply, images, steps: 0 };
    }
    let outcome: RunOutcome;
    let planId: string | null = null;
    let error: string | null = null;
    try {
      const done = await this.deps.planner.runForRule({
        guildId: rule.guildId,
        ownerId: rule.ownerId,
        rule: { id: rule.id, version: rule.version, name: rule.name, eventId, allow: rule.allow },
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
    if (outcome === "executed") keepState();
    store.finishRuleRun(runId, { outcome, planId, error: error?.slice(0, MAX_ERROR) ?? null, logs: result.logs });
    store.audit({ kind: "user", userId: rule.ownerId, via: "rule" }, "rule.run", { outcome, event: eventId, version }, planId ?? undefined, rule.id);
    this.#settle(rule, outcome === "failed" || outcome === "rejected", error);
    return { outcome, error: error?.slice(0, MAX_ERROR) ?? null, reply, images, steps: result.drafts.length };
  }

  /**
   * Someone ran a COMMAND rule's slash command. The run waits its turn like any
   * other in the server; what the code reads is limited to what everyone in the
   * channel (and the owner) may see, since the reply goes back there.
   */
  async runCommand(rule: Rule, event: Data): Promise<CommandReport> {
    const skipped = (error: string): CommandReport => ({ outcome: "skipped", error, reply: null, images: [], steps: 0 });
    if (!rule.enabled) return skipped("このコマンドのルールは止まっています");
    if (this.halted(rule.guildId)) return skipped("このサーバーの全ルールが止められています");
    const guild = this.deps.caches.get(rule.guildId)?.guild;
    const channelId = typeof event.channel_id === "string" ? event.channel_id : "";
    if (!guild || !channelId || !this.#visible(rule, guild, "COMMAND", event)) return skipped("ルールの作成者がこのチャンネルを見られないため、ここでは動きません");
    if (!this.#allowRun(rule)) return skipped(`1分に${rule.limits.perMinute}回までです。少し待ってからもう一度使ってください`);
    const reader = this.deps.makeReader({ guildId: rule.guildId, channelId, speakerId: rule.ownerId, audience: "channel" });
    return new Promise((resolve) => {
      this.#enqueue(serialKey(rule, event), async () => {
        try {
          resolve((await this.#run(rule.id, rule.version, eventIdOf("COMMAND", event), [{ eventName: "COMMAND", event }], reader)) ?? skipped("このコマンドのルールは止まっています"));
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
   * Used for real runs and for dry runs, which stop here.
   */
  async evaluate(
    rule: Pick<Rule, "guildId" | "ownerId" | "program" | "params">,
    event: unknown,
    reader?: Pick<Reader, "get">,
    eventName: string | null = null,
    batch: BatchItem[] = eventName ? [{ eventName, event: event as Data }] : [],
    state: unknown = null,
    command = eventName === "COMMAND",
  ): Promise<Evaluation> {
    let result: SandboxResult;
    let replied: string | null = null;
    const images: CommandImage[] = [];
    try {
      const source = reader ?? this.ownerReader(rule.guildId, rule.ownerId);
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
      const decider = this.deps.decide?.(rule.ownerId);
      const bindings: SandboxBindings = {
          guildId: rule.guildId,
          actor: { kind: "user", userId: rule.ownerId, via: "rule" },
          event,
          eventName,
          batch,
          state,
          params: rule.params ?? null,
          get: (route, query) => source.get(route, query as Record<string, string>),
          ...(command ? { reply: (text: string) => void (replied = (replied ? `${replied}\n${text}` : text).slice(0, MAX_REPLY)) } : {}),
          attach: (png: Buffer, name: string) => keep(png, `${name || "image"}.png`),
          ...(decider ? { decide: decider } : {}),
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
    const saved = { ...(result.state ? { state: result.state } : {}), ...(replied !== null ? { reply: replied } : {}), ...(images.length ? { images } : {}) };
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

/** `state` is set when the code called setState: what to keep if the run goes through. `reply` is what a command's code passed to reply(). */
export type Evaluation =
  | { kind: "steps"; drafts: StepDraft[]; logs: string[]; state?: { value: unknown }; reply?: string; images?: CommandImage[] }
  | { kind: "none"; logs: string[]; state?: { value: unknown }; reply?: string; images?: CommandImage[] }
  | { kind: "error"; error: string; logs: string[]; state?: undefined; reply?: string; images?: undefined };

/** A stable id for the event: its own id when it has one, otherwise a hash of the payload. */
export function eventIdOf(event: string, data: Data): string {
  const own = data.id ?? data.message_id ?? data.user?.id ?? data.user_id ?? data.role?.id ?? data.role_id;
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 10);
  return `${event}:${own ?? "-"}:${hash}`;
}
