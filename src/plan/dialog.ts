import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIMessageTopLevelComponent,
  APIModalInteractionResponseCallbackData,
} from "discord-api-types/v10";
import type { StepRow } from "../db.ts";
import type { Body } from "./catalog.ts";
import { RISK_LABEL } from "./types.ts";
import type { Plan, PlanStatus, Risk } from "./types.ts";
import { irreversibleSteps, specOf, stepRisk } from "./validate.ts";

// The approval dialog, drawn only from the Plan and its step states. Nothing
// the model wrote as explanation appears here.

export type PlanAction =
  | "run"
  | "cancel"
  | "json"
  | "confirm"
  | "revise"
  | "revisetext"
  | "redo"
  | "resume"
  | "restore"
  | "keep";
const ACTIONS = new Set<PlanAction>(["run", "cancel", "json", "confirm", "revise", "revisetext", "redo", "resume", "restore", "keep"]);

export function customId(action: PlanAction, plan: Pick<Plan, "id" | "hash">): string {
  return `plan:${action}:${plan.id}:${plan.hash.slice(0, 8)}`;
}

export function parsePlanCustomId(id: string): { action: PlanAction; planId: string; hash8: string } | null {
  const m = /^plan:(\w+):([A-Za-z0-9_-]+):([0-9a-f]{8})$/.exec(id);
  if (!m || !ACTIONS.has(m[1] as PlanAction)) return null;
  return { action: m[1] as PlanAction, planId: m[2]!, hash8: m[3]! };
}

const MAX_LISTED = 15;
const MAX_TARGETS_SHOWN = 5;

const COLORS = {
  write: 0x5865f2,
  destructive: 0xed4245,
  read: 0x5865f2,
  succeeded: 0x57f287,
  failed: 0xfaa61a,
  closed: 0x80848e,
} as const;

export function label(plan: Plan, id: unknown): string {
  return plan.labels[String(id)] ?? String(id);
}

function beforeOf(plan: Plan, resource: string | undefined): Record<string, unknown> | null {
  if (!resource) return null;
  return plan.preconditions.find((p) => p.resource === resource)?.values ?? null;
}

interface Group {
  label: string;
  change: string;
  risk: Risk;
  targets: string[];
  states: StepRow["state"][];
  errors: string[];
}

/**
 * Steps that do the same thing to different targets ("@Mod を付与" to 12
 * people) collapse into one line, so a large plan stays readable.
 */
function groups(plan: Plan, steps?: StepRow[]): Group[] {
  const states = new Map(steps?.map((s) => [s.stepId, s]));
  const out: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const step of plan.steps) {
    const spec = specOf(step);
    const resource = spec.target?.(step.pathParams, plan.guildId);
    const { target, change } = spec.describe(step.pathParams, step.body as Body, beforeOf(plan, resource), (id) => label(plan, id));
    const risk = stepRisk(step);
    const key = `${spec.op}\u0000${change}\u0000${risk}`;
    let group = byKey.get(key);
    if (!group) {
      group = { label: spec.label, change, risk, targets: [], states: [], errors: [] };
      byKey.set(key, group);
      out.push(group);
    }
    const state = states.get(step.id);
    group.targets.push(target);
    group.states.push(state?.state ?? "pending");
    if (state?.state === "failed" && state.error) group.errors.push(state.error);
  }
  return out;
}

function mark(g: Group, started: boolean, index: number): string {
  if (!started) return `${index + 1}.`;
  if (g.states.some((s) => s === "failed")) return "❌";
  if (g.states.every((s) => s === "done")) return "✅";
  return "・";
}

function groupLine(g: Group, started: boolean, index: number): string {
  const shown = g.targets.slice(0, MAX_TARGETS_SHOWN).join("、");
  const more = g.targets.length > MAX_TARGETS_SHOWN ? ` ほか${g.targets.length - MAX_TARGETS_SHOWN}件` : "";
  const count = g.targets.length > 1 ? `(${g.targets.length}件${started ? `、完了 ${g.states.filter((s) => s === "done").length}` : ""}) ` : "";
  const error = g.errors.length > 0 ? `\n　→ ${g.errors[0]!.slice(0, 200)}` : "";
  return `${mark(g, started, index)} **${g.label}** ${count}${shown}${more} — ${g.change}  \`${RISK_LABEL[g.risk]}\`${error}`;
}

/** One line per kind of change: operation, targets, before → after, risk. */
export function stepLines(plan: Plan, steps?: StepRow[]): string[] {
  const started = !!steps && steps.some((s) => s.state !== "pending");
  return groups(plan, steps).map((g, i) => groupLine(g, started, i));
}

/** What the person must type to run a plan with irreversible steps: the target's name, or the count. */
export function confirmPhrase(plan: Plan): string {
  const irreversible = irreversibleSteps(plan.steps);
  if (irreversible.length === 1) {
    // Name the thing itself (channel, role, member); a message has no name, so its count is asked.
    const p = irreversible[0]!.pathParams;
    const id = irreversible[0]!.op.includes("/messages") ? undefined : (p.overwrite ?? p.role ?? p.user ?? p.channel);
    const name = id === undefined ? undefined : plan.labels[String(id)];
    if (name) return name.replace(/^[#@]/, "");
  }
  return String(irreversible.length);
}

export function needsTypedConfirm(plan: Plan): boolean {
  return irreversibleSteps(plan.steps).length > 0;
}

export interface DialogState {
  status: PlanStatus;
  steps?: StepRow[];
  reason?: string | null;
  /** Show the buttons for the current status (false once someone chose to leave it). */
  actions?: boolean;
}

function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function statusLine(plan: Plan, state: DialogState): string {
  const done = state.steps?.filter((s) => s.state === "done").length ?? 0;
  switch (state.status) {
    case "pending_approval": {
      const how = needsTypedConfirm(plan) ? "戻せない操作を含むため、実行時に確認の入力があります。" : "";
      return `依頼者が「実行」を押すと実行します。${how}違うところがあれば「修正」から直せます。期限 <t:${unix(plan.expiresAt)}:R>`;
    }
    case "approved":
    case "executing":
      return plan.steps.length > 1 ? `実行中… ${done}/${plan.steps.length}` : "実行中…";
    case "succeeded":
      return "✅ 実行しました";
    case "failed":
      return `⚠️ 途中で失敗しました(${done}/${plan.steps.length}件完了)。${state.reason ?? ""}${state.actions === false ? "" : "\n「再開」で残りを実行、「復元」で済んだ変更を戻す変更を提案、「そのまま」で終了します。"}`;
    case "cancelled":
      return `${state.reason ?? "取り消しました"}${state.actions === false ? "" : "\n「出し直す」で今の状態から確かめ直した案を出せます。"}`;
    case "aborted":
      return `中止しました: ${state.reason ?? "前提が変わりました"}${state.actions === false ? "" : "\n「出し直す」で今の状態から確かめ直した案を出せます。"}`;
  }
}

function color(plan: Plan, status: PlanStatus): number {
  switch (status) {
    case "succeeded":
      return COLORS.succeeded;
    case "failed":
    case "aborted":
      return COLORS.failed;
    case "cancelled":
      return COLORS.closed;
    default:
      return COLORS[plan.risk];
  }
}

function button(id: string, text: string, style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: id, label: text, style };
}

function buttons(plan: Plan, state: DialogState): APIButtonComponent[] {
  const out: APIButtonComponent[] = [];
  if (state.actions !== false) {
    switch (state.status) {
      case "pending_approval":
        out.push(button(customId("run", plan), "実行", plan.risk === "destructive" ? ButtonStyle.Danger : ButtonStyle.Primary));
        out.push(button(customId("revise", plan), "修正", ButtonStyle.Secondary));
        out.push(button(customId("cancel", plan), "取り消し", ButtonStyle.Secondary));
        break;
      case "failed":
        out.push(button(customId("resume", plan), "再開", ButtonStyle.Primary));
        out.push(button(customId("restore", plan), "復元", ButtonStyle.Secondary));
        out.push(button(customId("keep", plan), "そのまま", ButtonStyle.Secondary));
        break;
      case "cancelled":
      case "aborted":
        out.push(button(customId("redo", plan), "出し直す", ButtonStyle.Secondary));
        break;
    }
  }
  out.push(button(customId("json", plan), "JSONを見る", ButtonStyle.Secondary));
  return out;
}

export function renderDialog(plan: Plan, state: DialogState): { components: APIMessageTopLevelComponent[]; flags: MessageFlags } {
  const lines = stepLines(plan, state.status === "pending_approval" ? undefined : state.steps);
  const listed = lines.slice(0, MAX_LISTED);
  if (lines.length > MAX_LISTED) listed.push(`…ほか${lines.length - MAX_LISTED}種類(全件は「JSONを見る」)`);
  const title = "### 変更の確認";
  const header = `${title}\n依頼: ${label(plan, plan.actor.userId)} · 危険度: ${RISK_LABEL[plan.risk]} · ${plan.steps.length}件 · \`${plan.id}\``;
  const text = [header, ...listed, "", statusLine(plan, state)].join("\n").slice(0, 3900);
  const row: APIActionRowComponent<APIButtonComponent> = { type: ComponentType.ActionRow, components: buttons(plan, state) };
  return {
    components: [
      {
        type: ComponentType.Container,
        accent_color: color(plan, state.status),
        components: [{ type: ComponentType.TextDisplay, content: text }, row],
      },
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

/** The dialog's text, for tests and logs. */
export function dialogText(rendered: { components: APIMessageTopLevelComponent[] }): string {
  const container = rendered.components[0] as { components: Array<{ type: number; content?: string }> };
  return container.components.find((c) => c.type === ComponentType.TextDisplay)?.content ?? "";
}

export function dialogButtons(rendered: { components: APIMessageTopLevelComponent[] }): string[] {
  const container = rendered.components[0] as { components: Array<{ type: number; components?: Array<{ label?: string }> }> };
  return container.components.find((c) => c.type === ComponentType.ActionRow)?.components?.map((b) => b.label ?? "") ?? [];
}

export function confirmModal(plan: Plan): APIModalInteractionResponseCallbackData {
  const phrase = confirmPhrase(plan);
  return {
    custom_id: customId("confirm", plan),
    title: "戻せない操作の確認",
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "confirm",
            label: /^\d+$/.test(phrase) ? "確認のため戻せない操作の件数を入力" : "確認のため対象の名前を入力",
            style: TextInputStyle.Short,
            placeholder: phrase.slice(0, 100),
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

export function reviseModal(plan: Plan): APIModalInteractionResponseCallbackData {
  return {
    custom_id: customId("revisetext", plan),
    title: "変更案の修正",
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "instruction",
            label: "どう直しますか",
            style: TextInputStyle.Paragraph,
            placeholder: "例: 対象はAさんとBさんだけにして / チャンネル名を announcements に",
            required: true,
            max_length: 1000,
          },
        ],
      },
    ],
  };
}
