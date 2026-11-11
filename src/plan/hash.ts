import { sha256Hex } from "../crypto.ts";
import type { Plan } from "./types.ts";

export type Resource = Record<string, unknown> | null;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fingerprint(resource: Resource, fields: string[]): string {
  if (!resource) return "absent";
  return sha256Hex(stable(fields.map((f) => [f, resource[f] ?? null])));
}

export function planHash(plan: Omit<Plan, "hash">): string {
  const { id, guildId, actor, preconditions, steps, labels, risk, revises, source, rule, rules, createdAt, expiresAt } = plan;
  // The rules are approved too, so a change to them (such as who sees a command's replies) changes the hash.
  return sha256Hex(stable({ id, guildId, actor, preconditions, steps, labels, risk, revises, source, rule, ...(rules ? { rules } : {}), createdAt, expiresAt }));
}
