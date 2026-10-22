import { ButtonStyle, ComponentType, MessageFlags } from "discord-api-types/v10";
import type { APIButtonComponent, APIComponentInContainer, APIMessageTopLevelComponent } from "discord-api-types/v10";
import type { AuditEntry, PlanRow } from "../db.ts";
import { RISK_LABEL } from "../plan/types.ts";
import type { RuleDryRun } from "../plan/types.ts";
import { allowLines, allowRisk, valueText } from "./allow.ts";
import type { Halt } from "./engine.ts";
import { DEFAULT_TIMEZONE } from "./schedule.ts";
import { TRIGGERS, triggerEvents } from "./triggers.ts";
import type { Rule, RuleLimits, RuleRun, RunOutcome } from "./types.ts";

// What /rules shows: the management panel. Everything is drawn from the rule
// definition and the database; the model's own words appear only as the
// summary, which another model wrote from the code alone. All of it is
// ephemeral. New rules are confirmed in a plan's dialog (plan/dialog.ts).

export type RuleAction =
  | "home" | "open" | "enable" | "disable" | "dry" | "delete" | "delete2" | "code"
  | "plans" | "audit" | "halt" | "resume" | "clearstate";

const ACTIONS = new Set<RuleAction>([
  "home", "open", "enable", "disable", "dry", "delete", "delete2", "code",
  "plans", "audit", "halt", "resume", "clearstate",
]);

export function ruleCustomId(action: RuleAction, arg = ""): string {
  return `rule:${action}:${arg}`;
}

export function parseRuleCustomId(id: string): { action: RuleAction; arg: string } | null {
  const m = /^rule:(\w+):([A-Za-z0-9_-]*)$/.exec(id);
  if (!m || !ACTIONS.has(m[1] as RuleAction)) return null;
  return { action: m[1] as RuleAction, arg: m[2]! };
}

const MAX_CODE = 1500;
const MAX_TOTAL = 3900;

export type Rendered = { flags: number; components: APIMessageTopLevelComponent[] };

function fenced(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body.replaceAll("```", "`​``")}\n\`\`\``;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function button(id: string, label: string, style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger = ButtonStyle.Secondary, disabled = false): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: id, label, style, disabled };
}

function row(buttons: APIButtonComponent[]): APIComponentInContainer {
  return { type: ComponentType.ActionRow, components: buttons.slice(0, 5) };
}

function container(texts: string[], rows: APIComponentInContainer[], accent?: number): Rendered {
  let budget = MAX_TOTAL;
  const parts: APIComponentInContainer[] = [];
  for (const t of texts) {
    if (!t || budget <= 50) continue;
    const content = clip(t, budget);
    budget -= content.length;
    parts.push({ type: ComponentType.TextDisplay, content });
  }
  return {
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.Container, ...(accent !== undefined ? { accent_color: accent } : {}), components: [...parts, ...rows] }],
  };
}

export function triggerLabel(trigger: Rule["trigger"]): string {
  const label = triggerEvents(trigger)
    .map((e) => {
      const base = `${TRIGGERS[e]?.label ?? e}(\`${e}\`)`;
      return e === "SCHEDULE" && trigger.schedule ? `${base} \`${trigger.schedule}\`(${trigger.timezone ?? DEFAULT_TIMEZONE})` : base;
    })
    .join("、または");
  const origin =
    trigger.includeBotOrigin === "other_rules"
      ? " ⚠️ ほかのルールや会話でBotが起こしたイベントでも動きます"
      : trigger.includeBotOrigin
        ? " ⚠️ Bot自身が起こしたイベントでも動きます"
        : "";
  const debounce = trigger.debounceSeconds ? ` · イベントが${trigger.debounceSeconds}秒途切れたらまとめて1回動きます` : "";
  return `${label}${origin}${debounce}`;
}

export function limitsLabel(limits: RuleLimits): string {
  return `1分に${limits.perMinute}回まで · ${limits.maxConsecutiveFailures}回続けて失敗したら自動で止まります`;
}

export function dryRunText(dry: RuleDryRun): string {
  const head = `**ドライラン**${dry.source ? `(${dry.source}で実行。実際の変更はしていません)` : ""}`;
  const body: string[] = [];
  switch (dry.outcome) {
    case "no_event":
      body.push("試せるイベントがありませんでした。");
      break;
    case "pending":
      body.push("この変更で作るものの値を使うため、登録まで試せません(コードがエラーにならないことだけ確かめました)。");
      break;
    case "none":
      body.push("このイベントでは何も変更しません。");
      break;
    case "error":
      body.push("コードがエラーになりました。");
      break;
    case "steps":
      body.push(`次の変更をします(${dry.lines.length}種類):`, ...dry.lines.slice(0, 8));
      if (dry.lines.length > 8) body.push(`…ほか${dry.lines.length - 8}種類`);
  }
  if (dry.problems.length > 0) body.push(`⚠️ ${dry.problems.slice(0, 5).join("\n⚠️ ")}`);
  if (dry.state !== undefined) body.push(`次に持ち越す状態(実際には保存していません): \`${clip(dry.state, 300)}\``);
  if (dry.logs.length > 0) body.push(`-# log: ${clip(dry.logs.slice(0, 5).join(" / "), 300)}`);
  return [head, ...body].join("\n");
}

function definitionTexts(d: Pick<Rule, "ownerId" | "trigger" | "allow" | "code" | "params" | "summary" | "limits">, label: (id: string) => string): string[] {
  const risk = allowRisk(d.allow);
  return [
    `きっかけ: ${triggerLabel(d.trigger)}\n作成者: <@${d.ownerId}> の権限で動きます · 危険度: ${RISK_LABEL[risk]} · ${limitsLabel(d.limits)}`,
    `**許す操作**(これ以外の変更は実行されません)\n${allowLines(d.allow, label).join("\n")}`,
    d.params ? `**params**(コードが読む値)\n${paramsText(d.params, label)}` : "",
    `**コードの説明**\n${d.summary ?? "説明を作れませんでした。コードを読んで確かめてください。"}`,
    fenced("js", d.code.length > MAX_CODE ? `${d.code.slice(0, MAX_CODE)}\n// …(続きは「コードをファイルで」)` : d.code),
  ];
}

/** A rule's params, with ids named where the cache knows them. */
export function paramsText(params: Record<string, unknown>, label: (id: string) => string): string {
  return Object.entries(params)
    .slice(0, 10)
    .map(([k, v]) => {
      const text = typeof v === "string" && label(v) !== v ? `${label(v)}(${v})` : valueText(v, (id) => JSON.stringify(id));
      return `- ${k}: ${clip(text ?? "null", 120)}`;
    })
    .join("\n");
}

const OUTCOME_LABEL: Record<RunOutcome, string> = {
  no_change: "変更なし",
  executed: "実行",
  rejected: "拒否",
  failed: "失敗",
  rate_limited: "回数制限",
};

function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function ruleStatus(rule: Rule): string {
  if (rule.enabled) return "🟢 有効";
  return `⏸️ 停止中${rule.disabledReason ? `(${rule.disabledReason})` : ""}`;
}

export interface HomeInput {
  rules: Rule[];
  userId: string;
  canSeeAll: boolean;
  canHalt: boolean;
  halted: Halt | null;
  notice?: string;
  lastRuns: Map<string, RuleRun | undefined>;
}

export function homeView(input: HomeInput): Rendered {
  const texts = [
    `## ルール\n${input.canSeeAll ? "このサーバーのすべてのルールです。" : "あなたのルールです。"}新しいルールや変更は、会話でBotに頼むと作れます(例: 「#自己紹介 に投稿した人に @メンバー を付けるルールを作って」)。この画面はあなたにだけ見えています。`,
  ];
  if (input.halted) texts.push(`🛑 **全ルールを停止中**(<@${input.halted.by}> が <t:${unix(input.halted.at)}:f> に停止)`);
  if (input.rules.length === 0) texts.push("ルールはまだありません。");
  else {
    texts.push(
      input.rules
        .slice(0, 25)
        .map((r) => {
          const last = input.lastRuns.get(r.id);
          const run = last ? ` · 最後: ${OUTCOME_LABEL[last.outcome]} <t:${unix(last.startedAt)}:R>` : "";
          const owner = r.ownerId === input.userId ? "" : ` · <@${r.ownerId}>`;
          return `${ruleStatus(r)} **${r.name}** v${r.version} — ${triggerEvents(r.trigger).map((e) => TRIGGERS[e]?.label ?? e).join("/")}${owner}${run}`;
        })
        .join("\n"),
    );
  }
  if (input.notice) texts.push(`-# ${input.notice}`);
  const rows: APIComponentInContainer[] = [];
  if (input.rules.length > 0) {
    rows.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: ruleCustomId("open"),
        placeholder: "ルールを開く",
        options: input.rules.slice(0, 25).map((r) => ({ label: clip(r.name, 100), value: r.id, description: clip(`${r.enabled ? "有効" : "停止中"} · ${triggerEvents(r.trigger).join(",")}`, 100) })),
      }],
    });
  }
  const buttons = [button(ruleCustomId("plans"), "変更の履歴"), button(ruleCustomId("audit"), "監査ログ")];
  if (input.canHalt) {
    buttons.push(input.halted ? button(ruleCustomId("resume"), "全ルールを再開", ButtonStyle.Primary) : button(ruleCustomId("halt"), "全ルールを緊急停止", ButtonStyle.Danger));
  }
  rows.push(row(buttons));
  return container(texts, rows);
}

export interface DetailInput {
  rule: Rule;
  runs: RuleRun[];
  can: { enable: boolean; disable: boolean; remove: boolean; owner: boolean };
  dry?: RuleDryRun;
  notice?: string;
  confirmDelete?: boolean;
  /** What the rule keeps between runs; null when nothing. */
  state?: unknown;
}

const MAX_STATE_SHOWN = 600;

export function stateText(state: unknown, max = MAX_STATE_SHOWN): string {
  const json = JSON.stringify(state, null, 1);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

function runLine(run: RuleRun): string {
  const error = run.error ? ` — ${clip(run.error.replaceAll("\n", " "), 120)}` : "";
  const plan = run.planId ? ` 変更 \`${run.planId}\`` : "";
  return `<t:${unix(run.startedAt)}:R> v${run.ruleVersion} ${OUTCOME_LABEL[run.outcome]}${plan}${error}`;
}

export function detailView(input: DetailInput, label: (id: string) => string): Rendered {
  const { rule } = input;
  const texts = [
    `### ${rule.name}\n${ruleStatus(rule)} · v${rule.version} · \`${rule.id}\``,
    ...definitionTexts(rule, label),
    `**元の依頼**\n${clip(rule.sourcePrompt, 300)}`,
    `**最近の実行**\n${input.runs.length > 0 ? input.runs.map(runLine).join("\n") : "まだありません"}`,
  ];
  if (input.state !== undefined && input.state !== null) texts.push(`**状態**(次の実行に持ち越す値)\n${fenced("json", stateText(input.state))}`);
  if (input.dry) texts.push(dryRunText(input.dry));
  if (input.can.owner) texts.push(`-# 直すときは、会話でBotに「ルール \`${rule.id}\`(${rule.name})を〜に直して」と頼んでください。確認のあと新しい版になります。`);
  if (input.confirmDelete) texts.push("⚠️ 本当に削除しますか? 実行履歴と監査ログは残ります。");
  if (input.notice) texts.push(`-# ${input.notice}`);
  const buttons: APIButtonComponent[] = [];
  if (input.confirmDelete) {
    buttons.push(button(ruleCustomId("delete2", rule.id), "削除する", ButtonStyle.Danger), button(ruleCustomId("open", rule.id), "やめる"));
    return container(texts, [row(buttons)]);
  }
  if (rule.enabled && input.can.disable) buttons.push(button(ruleCustomId("disable", rule.id), "止める", ButtonStyle.Danger));
  if (!rule.enabled && input.can.enable) buttons.push(button(ruleCustomId("enable", rule.id), "有効にする", ButtonStyle.Primary));
  if (input.can.owner) buttons.push(button(ruleCustomId("dry", rule.id), "ドライラン"));
  if (input.can.owner && input.state !== undefined && input.state !== null) buttons.push(button(ruleCustomId("clearstate", rule.id), "状態を消す"));
  buttons.push(button(ruleCustomId("code", rule.id), "コードをファイルで"));
  const second: APIButtonComponent[] = [button(ruleCustomId("home"), "戻る")];
  if (input.can.remove) second.push(button(ruleCustomId("delete", rule.id), "削除", ButtonStyle.Danger));
  return container(texts, [row(buttons), row(second)]);
}

const STATUS_LABEL: Record<PlanRow["status"], string> = {
  pending_approval: "承認待ち",
  approved: "承認済み",
  executing: "実行中",
  succeeded: "成功",
  cancelled: "取り消し",
  aborted: "中止",
  failed: "失敗",
};

export function plansView(plans: Array<PlanRow & { updatedAt?: string }>, all: boolean): Rendered {
  const lines = plans.map(({ plan, status, reason }) => {
    const who = plan.rule ? `ルール「${plan.rule.name}」` : `<@${plan.actor.userId}>`;
    const ops = [...new Set(plan.steps.map((s) => s.op))].slice(0, 3).join(", ");
    return `<t:${unix(plan.createdAt)}:R> \`${plan.id}\` ${STATUS_LABEL[status]} · ${who} · ${plan.steps.length}件 ${ops}${reason ? ` — ${clip(reason.replaceAll("\n", " "), 80)}` : ""}`;
  });
  return container(
    [`### 変更の履歴\n${all ? "このサーバーの最近の変更です。" : "あなたの最近の変更です(ルールによるものを含む)。"}`, lines.join("\n") || "ありません"],
    [row([button(ruleCustomId("home"), "戻る")])],
  );
}

function actorText(entry: AuditEntry): string {
  const a = entry.actor;
  if (a.kind === "system") return "Bot";
  return a.via === "rule" ? `<@${a.userId}> のルール` : `<@${a.userId}>`;
}

export function auditView(entries: AuditEntry[], all: boolean): Rendered {
  const lines = entries.map((e) => {
    const ref = e.planId ? ` 変更 \`${e.planId}\`` : e.ruleId ? ` ルール \`${e.ruleId}\`` : "";
    return `<t:${unix(e.at)}:R> ${actorText(e)} \`${e.action}\`${ref}`;
  });
  return container(
    [`### 監査ログ\n${all ? "このサーバーの最近の記録です。" : "あなたの操作の記録です。全件を見るには監査ログ表示の権限が必要です。"}`, lines.join("\n") || "ありません"],
    [row([button(ruleCustomId("home"), "戻る")])],
  );
}
