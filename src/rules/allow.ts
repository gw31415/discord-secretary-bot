import { Value } from "typebox/value";
import type { GuildState, MemberState } from "../discord/permissions.ts";
import { basePermissions, channelPermissions } from "../discord/permissions.ts";
import { CATALOG, pathParamNames, permissionNames } from "../plan/catalog.ts";
import { isRef, maxRisk } from "../plan/types.ts";
import type { AllowEntry, Risk, Step } from "../plan/types.ts";
import { MAX_STEPS } from "../plan/validate.ts";

// The allow list a rule's owner approves: which operations the rule may make,
// with JSON Schemas on path parameters and the body. Every step a rule
// produces must fit one entry, checked deterministically before and during
// execution. Nothing the rule's code does can widen it.

const MAX_ALLOW_JSON = 6000;
export const MAX_ALLOW_ENTRIES = 10;

function schemaProblem(schema: unknown, where: string): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${where}: JSON Schemaのオブジェクトにしてください`;
  try {
    Value.Check(schema as never, null);
    return null;
  } catch (e) {
    return `${where}: JSON Schemaとして読めません(${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Shape problems of an allow list, before anyone is asked to approve it. */
export function allowShapeProblems(allow: AllowEntry[]): string[] {
  const problems: string[] = [];
  if (allow.length === 0) problems.push("許す操作が1つもありません");
  if (allow.length > MAX_ALLOW_ENTRIES) problems.push(`許す操作は${MAX_ALLOW_ENTRIES}個までです`);
  if (JSON.stringify(allow).length > MAX_ALLOW_JSON) problems.push("許す操作の定義が長すぎます");
  allow.forEach((entry, i) => {
    const where = `allow[${i}](${entry.op})`;
    const spec = CATALOG.get(entry.op);
    if (!spec) {
      problems.push(`${where}: 対応していない操作です`);
      return;
    }
    const names = pathParamNames(spec.op).filter((n) => n !== "guild");
    for (const [name, schema] of Object.entries(entry.path ?? {})) {
      if (!names.includes(name)) problems.push(`${where}: 不明なパスパラメータ ${name}`);
      const p = schemaProblem(schema, `${where}.path.${name}`);
      if (p) problems.push(p);
    }
    if (entry.body !== undefined) {
      if (!spec.body) problems.push(`${where}: この操作は本文を取りません`);
      const p = schemaProblem(entry.body, `${where}.body`);
      if (p) problems.push(p);
    }
    if (entry.target !== undefined) {
      if (!spec.target) problems.push(`${where}: この操作には対象の条件を付けられません`);
      const p = schemaProblem(entry.target, `${where}.target`);
      if (p) problems.push(p);
    }
    if (entry.maxStepsPerRun !== undefined && !(Number.isInteger(entry.maxStepsPerRun) && entry.maxStepsPerRun >= 1 && entry.maxStepsPerRun <= MAX_STEPS)) {
      problems.push(`${where}: maxStepsPerRun は1〜${MAX_STEPS}の整数にしてください`);
    }
  });
  return problems;
}

/**
 * The current state of each step's target, by step id; null when it does not
 * exist. A step missing from the map has its target conditions checked later
 * (at proposal, or while its target still waits on an earlier step).
 */
export type Targets = Map<string, Record<string, unknown> | null>;

/** Whether a step fits an entry. Values still waiting on an earlier step pass until they are known. */
export function fits(step: Step, entry: AllowEntry, targets?: Targets): boolean {
  if (step.op !== entry.op) return false;
  for (const [name, schema] of Object.entries(entry.path ?? {})) {
    const value = step.pathParams[name];
    if (isRef(value)) continue;
    if (!Value.Check(schema as never, value)) return false;
  }
  if (entry.body !== undefined && !Value.Check(entry.body as never, containsRef(step.body) ? withoutRefs(step.body) : step.body ?? {})) return false;
  if (entry.target !== undefined && targets?.has(step.id)) {
    const target = targets.get(step.id);
    if (!target || !Value.Check(entry.target as never, target)) return false;
  }
  return true;
}

/** Whether any entry for this step's operation has conditions on its target. */
export function needsTarget(step: Step, allow: AllowEntry[]): boolean {
  return allow.some((entry) => entry.op === step.op && entry.target !== undefined);
}

function containsRef(value: unknown): boolean {
  if (isRef(value)) return true;
  if (Array.isArray(value)) return value.some(containsRef);
  if (value && typeof value === "object") return Object.values(value).some(containsRef);
  return false;
}

/** Top-level body fields that wait on an earlier step are left out until they are known. */
function withoutRefs(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([, v]) => !containsRef(v)));
}

/** Steps outside the allow list, and entries used more often than they permit. */
export function allowProblems(steps: Step[], allow: AllowEntry[], targets?: Targets): string[] {
  const problems: string[] = [];
  const used = new Map<number, number>();
  for (const step of steps) {
    const index = allow.findIndex((entry) => fits(step, entry, targets));
    const label = CATALOG.get(step.op)?.label ?? step.op;
    if (index < 0) {
      problems.push(`${step.id}(${label}): 許可された操作の範囲外です`);
      continue;
    }
    used.set(index, (used.get(index) ?? 0) + 1);
  }
  for (const [index, count] of used) {
    const max = allow[index]!.maxStepsPerRun;
    if (max !== undefined && count > max) problems.push(`allow[${index}](${allow[index]!.op}): 1回に${max}件までのところ${count}件あります`);
  }
  return problems;
}

/** Body fields an entry can set: the schema's properties, or every field the operation has. */
function possibleFields(entry: AllowEntry): string[] {
  const spec = CATALOG.get(entry.op)!;
  const props = (entry.body as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props) return Object.keys(props);
  return Object.keys(spec.byField ?? {});
}

/** Channels the entry is pinned to by an enum or const on the channel parameter. */
function pinnedChannels(entry: AllowEntry): string[] | null {
  const spec = CATALOG.get(entry.op)!;
  if (!spec.channel) return null;
  const schema = entry.path?.[spec.channel] as { enum?: unknown[]; const?: unknown } | undefined;
  if (schema?.enum?.every((v) => typeof v === "string")) return schema.enum as string[];
  if (typeof schema?.const === "string") return [schema.const];
  return null;
}

/** Permissions an entry can need in the worst case its schema allows. */
export function entryPermissions(entry: AllowEntry): bigint {
  const spec = CATALOG.get(entry.op)!;
  let bits = spec.always | (spec.extraPerms?.(undefined) ?? 0n);
  for (const field of possibleFields(entry)) bits |= spec.byField?.[field]?.perms ?? 0n;
  return bits;
}

/**
 * What a person lacks to own (or switch off) a rule with this allow list,
 * evaluated in the channels an entry is pinned to, otherwise server-wide.
 * The executor checks again with real values on every run.
 */
export function missingPermissions(guild: GuildState, member: MemberState, allow: AllowEntry[]): string[] {
  const missing = new Set<string>();
  for (const entry of allow) {
    if (!CATALOG.has(entry.op)) continue;
    const bits = entryPermissions(entry);
    const channels = pinnedChannels(entry);
    const held = channels
      ? channels.map((id) => channelPermissions(guild, member, id)).reduce((a, b) => a & b, bits)
      : basePermissions(guild, member);
    for (const name of permissionNames(bits & ~held)) missing.add(name);
  }
  return [...missing];
}

export function allowRisk(allow: AllowEntry[]): Risk {
  return maxRisk(
    allow.map((entry) => {
      const spec = CATALOG.get(entry.op);
      if (!spec) return "read";
      return maxRisk([spec.risk, ...possibleFields(entry).map((f) => spec.byField?.[f]?.risk ?? "read")]);
    }),
  );
}

function compact(schema: unknown, max = 160): string {
  const text = JSON.stringify(schema);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A value of a schema or of params, with a ref to a step result shown as such. */
export function valueText(value: unknown, label: (id: string) => string = (id) => id): string {
  if (isRef(value)) {
    const m = /^steps\.([^.]+)\.result\.?(.*)$/.exec(value.$ref);
    return m ? `(${m[1]} で作るものの${m[2] || "結果"})` : value.$ref;
  }
  return typeof value === "string" ? label(value) : JSON.stringify(value);
}

/** One line per entry, drawn only from the entry itself. */
export function allowLines(allow: AllowEntry[], label: (id: string) => string = (id) => id): string[] {
  return allow.map((entry) => {
    const spec = CATALOG.get(entry.op);
    const parts = [`**${spec?.label ?? entry.op}** \`${entry.op}\``];
    for (const [name, schema] of Object.entries(entry.path ?? {})) {
      const s = schema as { enum?: unknown[]; const?: unknown };
      const values = s.enum ?? (s.const !== undefined ? [s.const] : null);
      parts.push(values ? `${name}: ${values.map((v) => valueText(v, label)).join("、")} のみ` : `${name}: ${compact(schema)}`);
    }
    if (spec?.channel && !entry.path?.[spec.channel]) parts.push(`${spec.channel}: どこでも`);
    if (entry.body !== undefined) parts.push(`本文: ${compact(entry.body)}`);
    if (entry.target !== undefined) parts.push(`対象の条件: ${compact(entry.target)}`);
    parts.push(entry.maxStepsPerRun !== undefined ? `1回に${entry.maxStepsPerRun}件まで` : `1回に${MAX_STEPS}件まで`);
    return `- ${parts.join(" / ")}`;
  });
}
