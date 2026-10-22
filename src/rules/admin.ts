import { randomBytes } from "node:crypto";
import { PermissionFlagsBits as P } from "discord-api-types/v10";
import type { AuditEntry, PlanRow, Store } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import { basePermissions, has } from "../discord/permissions.ts";
import type { GuildState, MemberState } from "../discord/permissions.ts";
import { allowShapeProblems, missingPermissions } from "./allow.ts";
import { haltKey } from "./engine.ts";
import type { Halt } from "./engine.ts";
import { isTrigger, MAX_TRIGGER_EVENTS, triggerEvents } from "./triggers.ts";
import type { Rule, RuleDefinition, RuleRun } from "./types.ts";

// The rule management functions. The /rule panel is a view over these; a web
// UI could call them the same way. Who may do what follows only from Discord
// permissions:
//   own rules and plans ............ the owner
//   others' rules, the full log .... View Audit Log (otherwise only your own)
//   switch off someone's rule ...... Manage Server and every permission the rule's allow list needs
//   delete a rule .................. its owner
//   stop / restart every rule ...... Manage Server, effective at once
// Switching off and deleting are the bot's own state, so they go to the audit
// log rather than through a Plan.

export class AdminDenied extends Error {}

export interface AdminDeps {
  store: Store;
  caches: Pick<GuildCaches, "get">;
  selfId: () => string;
  now: () => number;
}

interface Viewer {
  guild: GuildState;
  member: MemberState;
  userId: string;
  perms: bigint;
}

export class RuleAdmin {
  readonly deps: AdminDeps;

  constructor(deps: AdminDeps) {
    this.deps = deps;
  }

  #viewer(guildId: string, userId: string): Viewer {
    const guild = this.deps.caches.get(guildId)?.guild;
    const member = guild?.members.get(userId);
    if (!guild || !member) throw new AdminDenied("サーバーの情報を読み込めていません");
    return { guild, member, userId, perms: basePermissions(guild, member) };
  }

  #rule(guildId: string, ruleId: string): Rule {
    const rule = this.deps.store.getRule(ruleId);
    if (!rule || rule.guildId !== guildId) throw new AdminDenied("ルールが見つかりません");
    return rule;
  }

  canSeeAll(guildId: string, userId: string): boolean {
    return has(this.#viewer(guildId, userId).perms, P.ViewAuditLog);
  }

  canHalt(guildId: string, userId: string): boolean {
    return has(this.#viewer(guildId, userId).perms, P.ManageGuild);
  }

  /** Own rules, or every rule of the server for someone with View Audit Log. */
  list(guildId: string, userId: string): Rule[] {
    return this.deps.store.listRules(guildId, this.canSeeAll(guildId, userId) ? undefined : userId);
  }

  get(guildId: string, userId: string, ruleId: string): Rule {
    const rule = this.#rule(guildId, ruleId);
    if (rule.ownerId !== userId && !this.canSeeAll(guildId, userId)) throw new AdminDenied("このルールを見る権限がありません");
    return rule;
  }

  runs(guildId: string, userId: string, ruleId: string, limit = 5): RuleRun[] {
    this.get(guildId, userId, ruleId);
    return this.deps.store.recentRuleRuns(ruleId, limit);
  }

  /** What the viewer may do with a rule, for drawing buttons. */
  abilities(guildId: string, userId: string, rule: Rule): { enable: boolean; disable: boolean; remove: boolean; owner: boolean } {
    const owner = rule.ownerId === userId;
    return { enable: owner, disable: owner || this.#mayDisableOthers(guildId, userId, rule), remove: owner, owner };
  }

  #mayDisableOthers(guildId: string, userId: string, rule: Rule): boolean {
    const viewer = this.#viewer(guildId, userId);
    return has(viewer.perms, P.ManageGuild) && missingPermissions(viewer.guild, viewer.member, rule.allow).length === 0;
  }

  /** Problems with owning a rule like this: its shape and the permissions its allow list needs. */
  ownershipProblems(guildId: string, ownerId: string, definition: RuleDefinition): string[] {
    const viewer = this.#viewer(guildId, ownerId);
    const problems = [...allowShapeProblems(definition.allow)];
    const events = triggerEvents(definition.trigger);
    for (const event of events) if (!isTrigger(event)) problems.push(`きっかけ ${event} には対応していません`);
    if (events.length > MAX_TRIGGER_EVENTS) problems.push(`きっかけは${MAX_TRIGGER_EVENTS}種類までです`);
    const missing = missingPermissions(viewer.guild, viewer.member, definition.allow);
    if (missing.length > 0) problems.push(`許す操作に必要な権限をあなたが持っていません: ${missing.join(", ")}`);
    const bot = viewer.guild.members.get(this.deps.selfId());
    const botMissing = bot ? missingPermissions(viewer.guild, bot, definition.allow) : ["(Botの情報がありません)"];
    if (botMissing.length > 0) problems.push(`許す操作に必要な権限をBotが持っていません: ${botMissing.join(", ")}`);
    return problems;
  }

  /** Registers an approved rule, or a new version of one the owner already has. */
  save(guildId: string, ownerId: string, definition: RuleDefinition, replaces?: string): Rule {
    const problems = this.ownershipProblems(guildId, ownerId, definition);
    if (problems.length > 0) throw new AdminDenied(problems.join("\n"));
    const { store } = this.deps;
    const actor = { kind: "user" as const, userId: ownerId, via: "panel" as const };
    if (replaces) {
      const old = this.#rule(guildId, replaces);
      if (old.ownerId !== ownerId) throw new AdminDenied("ルールを直せるのは作成者だけです");
      store.updateRuleDefinition(old.id, definition, old.version + 1);
      store.audit(actor, "rule.approve", { guildId, version: old.version + 1, trigger: definition.trigger, allow: definition.allow }, undefined, old.id);
      return store.getRule(old.id)!;
    }
    const now = new Date(this.deps.now()).toISOString();
    const rule: Rule = {
      ...definition,
      id: randomBytes(6).toString("hex"),
      guildId,
      ownerId,
      version: 1,
      enabled: true,
      consecutiveFailures: 0,
      disabledReason: null,
      createdAt: now,
      updatedAt: now,
    };
    store.insertRule(rule);
    store.audit(actor, "rule.approve", { guildId, version: 1, trigger: definition.trigger, allow: definition.allow }, undefined, rule.id);
    return rule;
  }

  setEnabled(guildId: string, userId: string, ruleId: string, enabled: boolean): Rule {
    const rule = this.#rule(guildId, ruleId);
    const actor = { kind: "user" as const, userId, via: "panel" as const };
    if (enabled) {
      if (rule.ownerId !== userId) throw new AdminDenied("ルールを有効にできるのは作成者だけです");
      const missing = missingPermissions(this.#viewer(guildId, userId).guild, this.#viewer(guildId, userId).member, rule.allow);
      if (missing.length > 0) throw new AdminDenied(`許す操作に必要な権限をあなたが持っていません: ${missing.join(", ")}`);
      this.deps.store.setRuleEnabled(rule.id, true, null);
      this.deps.store.audit(actor, "rule.enable", { guildId }, undefined, rule.id);
    } else {
      if (rule.ownerId !== userId && !this.#mayDisableOthers(guildId, userId, rule)) {
        throw new AdminDenied("他の人のルールを止めるには、サーバー管理の権限と、そのルールが使う権限がすべて必要です");
      }
      const reason = rule.ownerId === userId ? null : `<@${userId}> が止めました`;
      this.deps.store.setRuleEnabled(rule.id, false, reason);
      this.deps.store.audit(actor, "rule.disable", { guildId, owner: rule.ownerId }, undefined, rule.id);
    }
    return this.deps.store.getRule(rule.id)!;
  }

  remove(guildId: string, userId: string, ruleId: string): void {
    const rule = this.#rule(guildId, ruleId);
    if (rule.ownerId !== userId) throw new AdminDenied("ルールを削除できるのは作成者だけです");
    this.deps.store.deleteRule(rule.id);
    this.deps.store.audit({ kind: "user", userId, via: "panel" }, "rule.delete", { guildId, name: rule.name, version: rule.version }, undefined, rule.id);
  }

  halted(guildId: string): Halt | null {
    const raw = this.deps.store.getMeta(haltKey(guildId));
    return raw ? (JSON.parse(raw) as Halt) : null;
  }

  /** Stops every rule in the server at once, without confirmation. */
  halt(guildId: string, userId: string): void {
    if (!this.canHalt(guildId, userId)) throw new AdminDenied("全ルールを止めるにはサーバー管理の権限が必要です");
    const halt: Halt = { by: userId, at: new Date(this.deps.now()).toISOString() };
    this.deps.store.setMeta(haltKey(guildId), JSON.stringify(halt));
    this.deps.store.audit({ kind: "user", userId, via: "panel" }, "rules.halt", { guildId });
  }

  resume(guildId: string, userId: string): void {
    if (!this.canHalt(guildId, userId)) throw new AdminDenied("ルールを再開するにはサーバー管理の権限が必要です");
    this.deps.store.deleteMeta(haltKey(guildId));
    this.deps.store.audit({ kind: "user", userId, via: "panel" }, "rules.resume", { guildId });
  }

  plans(guildId: string, userId: string, limit = 10): PlanRow[] {
    return this.deps.store.recentPlans({ guildId, ...(this.canSeeAll(guildId, userId) ? {} : { userId }), limit });
  }

  audit(guildId: string, userId: string, limit = 15): AuditEntry[] {
    return this.deps.store.auditEntries({ guildId, ...(this.canSeeAll(guildId, userId) ? {} : { userId }), limit });
  }
}
