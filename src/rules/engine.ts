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
import { RULE_SANDBOX_LIMITS, runSandboxed } from "../sandbox.ts";
import type { SandboxResult } from "../sandbox.ts";
import { createdKindOf, TRIGGERS } from "./triggers.ts";
import type { Rule, RunOutcome } from "./types.ts";

// Fires event rules. Each matching event runs the rule's code in the sandbox
// with its owner's read scope; the steps it returns go to the Planner, which
// checks them against the allow list and the owner's current permissions and
// runs them without a dialog. Safety: the bot's own changes are ignored unless
// the rule opts in, each rule is rate limited, repeated failures switch it off,
// and anyone with Manage Server can stop every rule in the server at once.

/** How long after the bot changes something an event about it counts as the bot's own. */
export const RECENT_WRITE_MS = 15_000;
const MAX_ERROR = 500;

export interface RuleEngineDeps {
  store: Store;
  caches: Pick<GuildCaches, "get">;
  planner: Pick<Planner, "runForRule">;
  selfId: () => string;
  now: () => number;
  makeReader: (scope: ReadScope) => Reader;
  /** Tells the owner their rule switched itself off. Failures are ignored. */
  notifyOwner?: (userId: string, content: string) => Promise<void>;
  log: (message: string, error?: unknown) => void;
  run?: typeof runSandboxed;
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
  /** `${guildId}\u0000${resource}` -> when the bot last wrote it. */
  readonly #recent = new Map<string, number>();
  /** Start times of recent runs per rule, for the per-minute limit. */
  readonly #runs = new Map<string, number[]>();
  /** Rules whose rate-limit skip was already recorded this minute, so a flood leaves one row. */
  readonly #limitedNoted = new Map<string, number>();
  /** Runs one after another per server, in the order events arrived. */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(deps: RuleEngineDeps) {
    this.deps = deps;
  }

  halted(guildId: string): Halt | null {
    const raw = this.deps.store.getMeta(haltKey(guildId));
    return raw ? (JSON.parse(raw) as Halt) : null;
  }

  /** The Planner reports each write, so events it causes are recognised. */
  noteWrite(plan: Plan, step: Step, response: unknown): void {
    const now = this.deps.now();
    const spec = CATALOG.get(step.op);
    const target = spec?.target?.(step.pathParams, plan.guildId);
    if (target) this.#recent.set(`${plan.guildId}\u0000${target}`, now);
    const created = createdKindOf(step.op);
    if (created) {
      this.#recent.set(`${plan.guildId}\u0000create:${created}`, now);
      const id = (response as { id?: string } | null)?.id;
      if (id) this.#recent.set(`${plan.guildId}\u0000${created}:${id}`, now);
    }
    if (step.op === "POST /channels/{channel}/messages") {
      const id = (response as { id?: string } | null)?.id;
      if (id) this.#recent.set(`${plan.guildId}\u0000message:${step.pathParams.channel}/${id}`, now);
    }
  }

  #recentlyWritten(guildId: string, key: string): boolean {
    const at = this.#recent.get(`${guildId}\u0000${key}`);
    return at !== undefined && this.deps.now() - at < RECENT_WRITE_MS;
  }

  /** Whether the bot caused the event, as far as the payload and its own recent writes tell. */
  byBot(event: string, guildId: string, data: Data): boolean {
    const spec = TRIGGERS[event]!;
    if (spec.actorId?.(data) === this.deps.selfId()) return true;
    if (spec.resources?.(data).some((key) => this.#recentlyWritten(guildId, key))) return true;
    if (spec.createdKind && this.#recentlyWritten(guildId, `create:${spec.createdKind}`)) return true;
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
   * event; the runs themselves are queued per server.
   */
  dispatch(event: string, guildId: string | undefined, data: Data): void {
    if (!guildId || !TRIGGERS[event]) return;
    const cache = this.deps.caches.get(guildId);
    if (!cache?.guild) return;
    const rules = this.deps.store.enabledRules(guildId, event);
    if (rules.length === 0 || this.halted(guildId)) return;
    const guild = cache.guild;
    const bot = this.byBot(event, guildId, data);
    const eventId = eventIdOf(event, data);
    for (const rule of rules) {
      if (bot && !rule.trigger.includeBotOrigin) continue;
      if (!this.#visible(rule, guild, event, data)) continue;
      if (!this.#allowRun(rule)) continue;
      this.#enqueue(guildId, () => this.#run(rule.id, rule.version, eventId, data));
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

  #enqueue(guildId: string, task: () => Promise<void>): void {
    const next = (this.#queues.get(guildId) ?? Promise.resolve()).then(task).catch((e) => this.deps.log("ルールの実行に失敗", e));
    this.#queues.set(guildId, next);
    void next.finally(() => {
      if (this.#queues.get(guildId) === next) this.#queues.delete(guildId);
    });
  }

  /** Waits for queued runs (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all(this.#queues.values());
  }

  async #run(ruleId: string, version: number, eventId: string, data: Data): Promise<void> {
    const { store } = this.deps;
    // The rule may have been switched off, changed or stopped while queued.
    const rule = store.getRule(ruleId);
    if (!rule?.enabled || rule.version !== version || this.halted(rule.guildId)) return;
    const runId = store.startRuleRun({ ruleId, ruleVersion: version, eventId });
    const result = await this.evaluate(rule, data);
    if (result.kind !== "steps") {
      store.finishRuleRun(runId, { outcome: result.kind === "none" ? "no_change" : "failed", error: result.kind === "error" ? result.error : null, logs: result.logs });
      this.#settle(rule, result.kind === "error", result.kind === "error" ? result.error : null);
      return;
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
      });
      planId = done.plan.id;
      outcome = done.status === "succeeded" ? "executed" : "failed";
      if (outcome === "failed") error = done.reason ?? done.status;
    } catch (e) {
      outcome = e instanceof PlanRejected ? "rejected" : "failed";
      error = e instanceof PlanRejected ? e.reasons.join("\n") : e instanceof Error ? e.message : String(e);
    }
    store.finishRuleRun(runId, { outcome, planId, error: error?.slice(0, MAX_ERROR) ?? null, logs: result.logs });
    store.audit({ kind: "user", userId: rule.ownerId, via: "rule" }, "rule.run", { outcome, event: eventId, version }, planId ?? undefined, rule.id);
    this.#settle(rule, outcome === "failed" || outcome === "rejected", error);
  }

  /** Counts the outcome; too many failures in a row switch the rule off and tell its owner. */
  #settle(rule: Rule, failed: boolean, error: string | null): void {
    const { store } = this.deps;
    const count = store.recordRuleResult(rule.id, failed);
    if (!failed || count < rule.limits.maxConsecutiveFailures) return;
    const reason = `${count}回続けて失敗したため自動で止めました`;
    store.setRuleEnabled(rule.id, false, reason);
    store.audit({ kind: "system" }, "rule.auto_disable", { reason, lastError: error?.slice(0, MAX_ERROR) ?? null }, undefined, rule.id);
    void this.deps.notifyOwner?.(
      rule.ownerId,
      `ルール「${rule.name}」は${count}回続けて失敗したため止めました。最後のエラー: ${(error ?? "").slice(0, 300)}\n直したら \`/rules\` の管理パネルから有効にできます。`,
    ).catch(() => undefined);
  }

  /**
   * Runs the rule's code on one event and returns the steps it asks for.
   * Used for real runs and for dry runs, which stop here.
   */
  async evaluate(rule: Pick<Rule, "guildId" | "ownerId" | "code" | "params">, event: unknown, reader?: Pick<Reader, "get">): Promise<Evaluation> {
    let result: SandboxResult;
    try {
      const source = reader ?? this.ownerReader(rule.guildId, rule.ownerId);
      result = await (this.deps.run ?? runSandboxed)(
        rule.code,
        {
          guildId: rule.guildId,
          actor: { kind: "user", userId: rule.ownerId, via: "rule" },
          event,
          params: rule.params ?? null,
          get: (route, query) => source.get(route, query as Record<string, string>),
        },
        RULE_SANDBOX_LIMITS,
      );
    } catch (e) {
      return { kind: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR), logs: [] };
    }
    if (!result.ok) return { kind: "error", error: (result.error ?? "不明なエラー").slice(0, MAX_ERROR), logs: result.logs };
    const value = result.value as { steps?: unknown; rules?: unknown[] } | null | undefined;
    if (value === undefined || value === null) return { kind: "none", logs: result.logs };
    if (Array.isArray(value.rules) && value.rules.length > 0) return { kind: "error", error: "ルールの中からルールは作れません", logs: result.logs };
    if (!Array.isArray(value.steps)) return { kind: "error", error: "コードは plan([...]) を return してください", logs: result.logs };
    if (value.steps.length === 0) return { kind: "none", logs: result.logs };
    return { kind: "steps", drafts: value.steps as StepDraft[], logs: result.logs };
  }

  /** What a rule reads with: everything its owner and the bot can both read. */
  ownerReader(guildId: string, ownerId: string, channelId = ""): Reader {
    return this.deps.makeReader({ guildId, channelId, speakerId: ownerId, audience: "owner" });
  }

  /** The owner left the server: their rules stop, since nobody's permissions back them any more. */
  ownerLeft(guildId: string, userId: string): void {
    for (const rule of this.deps.store.listRules(guildId, userId)) {
      if (!rule.enabled) continue;
      const reason = "作成者がサーバーを抜けたため自動で止めました";
      this.deps.store.setRuleEnabled(rule.id, false, reason);
      this.deps.store.audit({ kind: "system" }, "rule.auto_disable", { reason }, undefined, rule.id);
    }
  }

  /** Forgets old bookkeeping. Called every minute. */
  sweep(): void {
    const now = this.deps.now();
    for (const [key, at] of this.#recent) if (now - at >= RECENT_WRITE_MS) this.#recent.delete(key);
    for (const [key, until] of this.#limitedNoted) if (until <= now) this.#limitedNoted.delete(key);
    for (const [key, times] of this.#runs) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length === 0) this.#runs.delete(key);
      else this.#runs.set(key, recent);
    }
  }
}

export type Evaluation =
  | { kind: "steps"; drafts: StepDraft[]; logs: string[] }
  | { kind: "none"; logs: string[] }
  | { kind: "error"; error: string; logs: string[] };

/** A stable id for the event: its own id when it has one, otherwise a hash of the payload. */
export function eventIdOf(event: string, data: Data): string {
  const own = data.id ?? data.message_id ?? data.user?.id ?? data.user_id ?? data.role?.id ?? data.role_id;
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 10);
  return `${event}:${own ?? "-"}:${hash}`;
}
