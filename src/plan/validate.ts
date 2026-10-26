import { Value } from "typebox/value";
import { POST_OPS } from "./files.ts";
import type { GuildState, MemberState } from "../discord/permissions.ts";
import { basePermissions, channelPermissions } from "../discord/permissions.ts";
import { CATALOG, MAX_DMS_PER_PLAN, pathParamNames, permissionNames } from "./catalog.ts";
import type { Body, OpSpec, Params } from "./catalog.ts";
import { isRef, maxRisk, REF_PATTERN } from "./types.ts";
import type { Risk, Step, StepDraft } from "./types.ts";

// Deterministic checks between a proposal and Discord: shape (schema), then
// permissions of both the actor and the bot. The same checks run again on fresh
// REST data right before execution.

export const MAX_STEPS = 100;
/** Stands in for a value from an earlier step while that step has not run. */
const PLACEHOLDER_ID = "0";

export class PlanRejected extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.reasons = reasons;
  }
}

function replaceRefs(value: unknown, onRef: (ref: string) => unknown): unknown {
  if (isRef(value)) return onRef(value.$ref);
  if (Array.isArray(value)) return value.map((v) => replaceRefs(v, onRef));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceRefs(v, onRef)]));
  }
  return value;
}

/** Refs inside `value` that do not point to an earlier step. */
export function badRefs(value: unknown, earlier: Set<string>): string[] {
  const bad: string[] = [];
  replaceRefs(value, (ref) => {
    const m = REF_PATTERN.exec(ref);
    if (!m || !earlier.has(m[1]!)) bad.push(ref);
    return null;
  });
  return bad;
}

/** Turns drafts into steps, or throws with every shape problem found. */
export function normalizeSteps(drafts: StepDraft[], guildId: string, planId: string, allowEmpty = false): Step[] {
  const errors: string[] = [];
  if (drafts.length === 0 && !allowEmpty) errors.push("ステップがありません");
  if (drafts.length > MAX_STEPS) errors.push(`ステップは${MAX_STEPS}個までです(${drafts.length}個)`);
  const ids = new Set<string>();
  const steps: Step[] = [];
  let dms = 0;

  drafts.forEach((draft, i) => {
    const id = draft.id ?? `s${i + 1}`;
    const where = `${id}(${draft.op})`;
    if (ids.has(id)) errors.push(`${where}: ステップIDが重複しています`);
    const spec = CATALOG.get(draft.op);
    if (!spec) {
      errors.push(`${where}: 対応していない操作です`);
      ids.add(id);
      return;
    }
    if (spec.op === "POST /users/{user}/dm") dms++;

    const names = pathParamNames(spec.op);
    const path: Params = { ...(draft.path ?? {}) };
    if (path.guild === undefined && names.includes("guild")) path.guild = guildId;
    for (const key of Object.keys(path)) if (!names.includes(key)) errors.push(`${where}: 不明なパスパラメータ ${key}`);
    for (const name of names) {
      const value = path[name];
      if (value === undefined) errors.push(`${where}: パスパラメータ ${name} がありません`);
      else if (name === "guild" && value !== guildId) errors.push(`${where}: 別のサーバーは操作できません`);
      else if (spec.pathFormats?.[name]) {
        const format = spec.pathFormats[name];
        if (!(typeof value === "string" && format.pattern.test(value))) errors.push(`${where}: ${name} は${format.hint}にしてください`);
      } else if (!isRef(value) && !(typeof value === "string" && /^\d{1,20}$/.test(value))) errors.push(`${where}: ${name} はIDの文字列にしてください`);
    }
    for (const ref of badRefs(path, ids)) errors.push(`${where}: 参照 ${ref} は前のステップの結果を指していません`);
    if (draft.query && Object.keys(draft.query).length > 0) errors.push(`${where}: クエリは使えません`);

    const hasBody = draft.body !== undefined && !(typeof draft.body === "object" && draft.body !== null && Object.keys(draft.body).length === 0 && !spec.body);
    if (!spec.body && hasBody) errors.push(`${where}: この操作は本文を取りません`);
    if (spec.body) {
      const body = draft.body ?? {};
      for (const ref of badRefs(body, ids)) errors.push(`${where}: 参照 ${ref} は前のステップの結果を指していません`);
      const candidate = replaceRefs(body, () => PLACEHOLDER_ID);
      if (!Value.Check(spec.body, candidate)) {
        const problems = [...Value.Errors(spec.body, candidate)].slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`);
        // Posts take images and mentions their own way; say so instead of leaving the schema error alone.
        const hints = POST_OPS.has(spec.op) && typeof body === "object" && body !== null
          ? [
              ..."attachments" in body ? ["画像は attachments ではなく files に画像のID(\"img1\" など)を並べます"] : [],
              ..."allowed_mentions" in body ? ["allowed_mentions は付けません(本文で名指ししたユーザーだけに通知されます)"] : [],
            ]
          : [];
        errors.push(`${where}: 本文が仕様に合いません: ${problems.join("; ")}${hints.length ? `(${hints.join("。")})` : ""}`);
      }
    }

    ids.add(id);
    steps.push({
      id,
      kind: "call",
      op: spec.op,
      pathParams: path,
      ...(spec.body ? { body: draft.body ?? {} } : {}),
      idempotencyKey: `${planId}:${id}`,
    });
  });

  if (dms > MAX_DMS_PER_PLAN) errors.push(`DMは1つの変更につき${MAX_DMS_PER_PLAN}件までです(${dms}件)`);
  if (errors.length > 0) throw new PlanRejected(errors);
  return steps;
}

export function stepRisk(step: Step): Risk {
  const spec = CATALOG.get(step.op)!;
  const fieldRisks = Object.keys((step.body as Body) ?? {}).map((k) => spec.byField?.[k]?.risk ?? "read");
  return maxRisk([spec.risk, ...fieldRisks]);
}

export function planRisk(steps: Step[]): Risk {
  return maxRisk(steps.map(stepRisk));
}

function highest(guild: GuildState, member: MemberState): number {
  if (member.userId === guild.ownerId) return Infinity;
  return Math.max(0, ...member.roleIds.map((id) => guild.roles.get(id)?.position ?? 0));
}

export interface CheckContext {
  guild: GuildState;
  actorId: string;
  selfId: string;
}

/**
 * Permission and hierarchy problems of one step. Values that come from earlier
 * steps may still be refs; a channel that does not exist yet is judged by
 * server-wide permissions until it does.
 */
export function permissionProblems(step: Step, ctx: CheckContext): string[] {
  const spec = CATALOG.get(step.op)!;
  const { guild } = ctx;
  const where = `${step.id}(${spec.label})`;
  const actor = guild.members.get(ctx.actorId);
  const bot = guild.members.get(ctx.selfId);
  if (!actor) return [`${where}: 依頼者がサーバーのメンバーとして見つかりません`];
  if (!bot) return [`${where}: Bot自身の情報がまだ読み込まれていません`];
  const body = step.body as Body;
  const problems: string[] = [];

  let channelId: string | undefined;
  if (spec.channel) {
    const value = step.pathParams[spec.channel];
    if (!isRef(value)) {
      channelId = String(value);
      if (!guild.channels.has(channelId)) return [`${where}: チャンネル ${channelId} がこのサーバーに見つかりません`];
    }
  }

  let required = spec.always | (spec.extraPerms?.(body) ?? 0n);
  for (const key of Object.keys(body ?? {})) required |= spec.byField?.[key]?.perms ?? 0n;
  const grants = spec.grants?.(body) ?? 0n;

  const people: Array<[string, MemberState]> = [["依頼者", actor], ["Bot", bot]];
  for (const [who, member] of people) {
    const perms = channelId ? channelPermissions(guild, member, channelId) : basePermissions(guild, member);
    const missing = required & ~perms;
    if (missing) problems.push(`${where}: ${who}に権限 ${permissionNames(missing).join(", ")} がありません`);
    const ungrantable = grants & ~perms;
    if (ungrantable) problems.push(`${where}: ${who}が持っていない権限は付与・設定できません(${permissionNames(ungrantable).join(", ")})`);
  }

  const roleParam = spec.hierarchy?.role;
  if (roleParam && !isRef(step.pathParams[roleParam])) {
    const roleId = String(step.pathParams[roleParam]);
    const role = guild.roles.get(roleId);
    if (!role) problems.push(`${where}: ロール ${roleId} が見つかりません`);
    else {
      for (const [who, member] of people) {
        if (role.position >= highest(guild, member)) problems.push(`${where}: ロール ${roleId} は${who}の最上位ロールと同じか上にあるため操作できません`);
      }
    }
  }
  const memberParam = spec.hierarchy?.member;
  const memberHierarchy = !spec.hierarchyFields || Object.keys(body ?? {}).some((k) => spec.hierarchyFields!.includes(k));
  if (memberParam && memberHierarchy && !isRef(step.pathParams[memberParam])) {
    const target = guild.members.get(String(step.pathParams[memberParam]));
    // Someone who is not in the server (e.g. a ban by id) has no roles to compare.
    if (target) {
      if (target.userId === guild.ownerId) problems.push(`${where}: サーバーのオーナーは操作できません`);
      else {
        for (const [who, member] of people) {
          if (member.userId !== target.userId && highest(guild, target) >= highest(guild, member)) {
            problems.push(`${where}: 対象の最上位ロールが${who}と同じか上にあるため操作できません`);
          }
        }
      }
    }
  }
  return problems;
}

/** Channels the preview would reveal must be ones this conversation may show. */
export function visibilityProblems(step: Step, shareable: Set<string>): string[] {
  const spec = CATALOG.get(step.op)!;
  const ids = spec.channels?.(step.pathParams, step.body as Body) ?? [];
  return ids
    .filter((id): id is string => typeof id === "string" && !shareable.has(id))
    .map((id) => `${step.id}(${spec.label}): チャンネル ${id} はこの場所では扱えません。そのチャンネルを見られる人だけがいる場所で頼んでください`);
}

/**
 * Visibility first: a step on a channel this conversation may not show gets
 * only that answer. Whether the channel exists, or who may do what there,
 * would otherwise come back in the reasons and tell one hidden channel from another.
 */
export function stepProblems(step: Step, ctx: CheckContext, shareable: Set<string>): string[] {
  const hidden = visibilityProblems(step, shareable);
  return hidden.length > 0 ? hidden : permissionProblems(step, ctx);
}

/** Replaces refs with values from earlier steps' responses. */
export function resolveRefs<T>(value: T, results: Map<string, unknown>): T {
  return replaceRefs(value, (ref) => {
    const m = REF_PATTERN.exec(ref)!;
    let current: unknown = results.get(m[1]!);
    for (const key of m[2]!.split(".").filter(Boolean)) current = (current as Record<string, unknown> | null)?.[key];
    if (current === undefined || current === null) throw new Error(`参照 ${ref} の値がありません`);
    return current;
  }) as T;
}

/** The step's inverse restores everything it changes. */
export function isUndoable(step: Step): boolean {
  const spec = specOf(step);
  if (!spec.inverse) return false;
  return spec.undoable?.(step.body as Body) ?? true;
}

/** Steps that cannot be taken back; a plan with any of them asks for typed confirmation. */
export function irreversibleSteps(steps: Step[]): Step[] {
  return steps.filter((s) => !isUndoable(s));
}

export function specOf(step: Step): OpSpec {
  return CATALOG.get(step.op)!;
}
