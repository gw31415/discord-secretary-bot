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
import type { Plan, PlanStatus } from "./types.ts";
import { specOf, stepRisk } from "./validate.ts";

// The approval dialog, drawn only from the Plan and its step states. Nothing
// the model wrote as explanation appears here.

export type PlanAction = "run" | "cancel" | "json" | "confirm" | "resume" | "restore" | "keep";
const ACTIONS = new Set<PlanAction>(["run", "cancel", "json", "confirm", "resume", "restore", "keep"]);

export function customId(action: PlanAction, plan: Pick<Plan, "id" | "hash">): string {
  return `plan:${action}:${plan.id}:${plan.hash.slice(0, 8)}`;
}

export function parsePlanCustomId(id: string): { action: PlanAction; planId: string; hash8: string } | null {
  const m = /^plan:(\w+):([A-Za-z0-9_-]+):([0-9a-f]{8})$/.exec(id);
  if (!m || !ACTIONS.has(m[1] as PlanAction)) return null;
  return { action: m[1] as PlanAction, planId: m[2]!, hash8: m[3]! };
}

const MAX_LISTED = 15;

export function label(plan: Plan, id: unknown): string {
  return plan.labels[String(id)] ?? String(id);
}

function beforeOf(plan: Plan, resource: string | undefined): Record<string, unknown> | null {
  if (!resource) return null;
  return plan.preconditions.find((p) => p.resource === resource)?.values ?? null;
}

/** One line per step: operation, target, before → after, risk. */
export function stepLines(plan: Plan, steps?: StepRow[]): string[] {
  const states = new Map(steps?.map((s) => [s.stepId, s]));
  return plan.steps.map((step, i) => {
    const spec = specOf(step);
    const body = step.body as Body;
    const resource = spec.target?.(step.pathParams, plan.guildId);
    const { target, change } = spec.describe(step.pathParams, body, beforeOf(plan, resource), (id) => label(plan, id));
    const state = states.get(step.id);
    const mark = !state || state.state === "pending" ? (steps ? "・" : `${i + 1}.`) : state.state === "done" ? "✅" : state.state === "failed" ? "❌" : "・";
    const error = state?.state === "failed" && state.error ? `\n　→ ${state.error.slice(0, 200)}` : "";
    return `${mark} **${spec.label}** ${target} — ${change}  \`${RISK_LABEL[stepRisk(step)]}\`${error}`;
  });
}

/** What the person must type to run a destructive plan: the target's name, or the count. */
export function confirmPhrase(plan: Plan): string {
  const destructive = plan.steps.filter((s) => stepRisk(s) === "destructive");
  if (destructive.length === 1) {
    // Name the thing itself (channel, role, member); a message has no name, so its count is asked.
    const p = destructive[0]!.pathParams;
    const id = destructive[0]!.op.includes("/messages") ? undefined : (p.overwrite ?? p.role ?? p.user ?? p.channel);
    const name = id === undefined ? undefined : plan.labels[String(id)];
    if (name) return name.replace(/^[#@]/, "");
  }
  return String(destructive.length);
}

export interface DialogState {
  status: PlanStatus;
  steps?: StepRow[];
  reason?: string | null;
  /** Show the buttons for the current status (false once someone chose to leave it). */
  actions?: boolean;
}

function statusLine(plan: Plan, state: DialogState): string {
  switch (state.status) {
    case "pending_approval": {
      const expires = Math.floor(Date.parse(plan.expiresAt) / 1000);
      const confirm = plan.risk === "destructive" ? "破壊的な操作を含むため、実行時に確認の入力があります。" : "";
      return `依頼者が「実行」を押すと実行します。${confirm}期限 <t:${expires}:R>`;
    }
    case "approved":
    case "executing":
      return "実行中…";
    case "succeeded":
      return "✅ 実行しました";
    case "failed":
      return `⚠️ 途中で失敗しました。${state.reason ?? ""}${state.actions === false ? "" : "\n「再開」で残りを実行、「復元」で済んだ変更を戻す変更を提案、「そのまま」で終了します。"}`;
    case "cancelled":
      return state.reason ?? "取り消しました";
    case "aborted":
      return `中止しました: ${state.reason ?? "前提が変わりました"}\nもう一度頼んでください。`;
  }
}

function button(id: string, text: string, style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: id, label: text, style };
}

export function renderDialog(plan: Plan, state: DialogState): { components: APIMessageTopLevelComponent[]; flags: MessageFlags } {
  const lines = stepLines(plan, state.status === "pending_approval" ? undefined : state.steps);
  const listed = lines.slice(0, MAX_LISTED);
  if (lines.length > MAX_LISTED) listed.push(`…ほか${lines.length - MAX_LISTED}件(全件は「JSONを見る」)`);
  const header = `### 変更の確認\n依頼: ${label(plan, plan.actor.userId)} · 危険度: ${RISK_LABEL[plan.risk]} · ${plan.steps.length}件 · \`${plan.id}\``;
  const text = [header, ...listed, "", statusLine(plan, state)].join("\n").slice(0, 3900);

  const buttons: APIButtonComponent[] = [];
  const actions = state.actions !== false;
  if (actions && state.status === "pending_approval") {
    buttons.push(button(customId("run", plan), "実行", plan.risk === "destructive" ? ButtonStyle.Danger : ButtonStyle.Primary));
    buttons.push(button(customId("cancel", plan), "取り消し", ButtonStyle.Secondary));
  }
  if (actions && state.status === "failed") {
    buttons.push(button(customId("resume", plan), "再開", ButtonStyle.Primary));
    buttons.push(button(customId("restore", plan), "復元", ButtonStyle.Secondary));
    buttons.push(button(customId("keep", plan), "そのまま", ButtonStyle.Secondary));
  }
  buttons.push(button(customId("json", plan), "JSONを見る", ButtonStyle.Secondary));

  const row: APIActionRowComponent<APIButtonComponent> = { type: ComponentType.ActionRow, components: buttons };
  return {
    components: [{ type: ComponentType.TextDisplay, content: text }, row],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function confirmModal(plan: Plan): APIModalInteractionResponseCallbackData {
  const phrase = confirmPhrase(plan);
  return {
    custom_id: customId("confirm", plan),
    title: "破壊的な操作の確認",
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "confirm",
            label: /^\d+$/.test(phrase) ? "確認のため破壊的な操作の件数を入力" : "確認のため対象の名前を入力",
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
