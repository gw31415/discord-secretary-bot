import { ButtonStyle, ComponentType } from "discord-api-types/v10";
import type { APIButtonComponent, APIComponentInContainer } from "discord-api-types/v10";
import { visibilitySelect, VISIBILITY_CHOICES } from "./command.ts";
import type { CommandVisibility } from "./command.ts";
import type { AuditEntry, PlanRow, WasmSource } from "../db.ts";
import { CATALOG } from "../plan/catalog.ts";
import { RISK_LABEL } from "../plan/types.ts";
import type { RuleDryRun } from "../plan/types.ts";
import { allowLines, allowRisk, valueText } from "./allow.ts";
import type { Halt } from "./engine.ts";
import { DEFAULT_TIMEZONE } from "./schedule.ts";
import { ACTOR_EVENTS, TRIGGERS, triggerEvents } from "./triggers.ts";
import type { Rule, RuleLimits, RuleRun, RunOutcome } from "./types.ts";
import { truncate } from "../text.ts";
import { auditActionLabel, permissionList, PLAN_STATUS_LABEL } from "../discord/labels.ts";
import { NS } from "../discord/custom-id.ts";
import { actionRow, button, discordTime, fence, panelTexts, settingsHomeButton, v2Message } from "../discord/ui.ts";
import type { Rendered } from "../discord/ui.ts";

/** The line above a command's reply-audience select; the plan dialog's details say the same. */
const VISIBILITY_HEADING = "返事を見せる相手:";

/** The audience as a clause, for a screen that has no select for it. */
function visibilityClause(visibility: CommandVisibility | undefined): string {
  const current = visibility ?? "auto";
  return `(返事を見せる相手: ${VISIBILITY_CHOICES.find((o) => o.value === current)!.label})`;
}

// The rules section of /settings: the management panel. Everything is drawn from the rule
// definition and the database; the model's own words appear only as the
// summary, which another model wrote from the code alone. All of it is
// ephemeral. New rules are confirmed in a plan's dialog (plan/dialog.ts).

export type RuleAction =
  | "home" | "open" | "enable" | "disable" | "dry" | "delete" | "delete2" | "code"
  | "plans" | "audit" | "halt" | "resume" | "clearstate" | "visibility"
  | "allow" | "source" | "runs" | "view"
  | "commands" | "cmd" | "cmdvis" | "cmddel" | "cmddel2";

const ACTIONS = new Set<RuleAction>([
  "home", "open", "enable", "disable", "dry", "delete", "delete2", "code",
  "plans", "audit", "halt", "resume", "clearstate", "visibility",
  "allow", "source", "runs", "view",
  "commands", "cmd", "cmdvis", "cmddel", "cmddel2",
]);

/** A rule's panel opens on its summary; what it may do, its code and its runs are a button away. */
export type RulePage = "summary" | "allow" | "source" | "runs";

const PAGE_LABEL: Record<RulePage, string> = { summary: "概要", allow: "許す操作", source: "コード", runs: "実行履歴" };
export const RULE_PAGES = Object.keys(PAGE_LABEL) as RulePage[];
/** The page menu's extra entry, which asks before deleting. */
export const DELETE_CHOICE = "delete";

// The rules are one of the settings panel's sections.
export { SETTINGS_HOME_ID } from "../discord/custom-id.ts";

export function ruleCustomId(action: RuleAction, arg = ""): string {
  return `${NS.rule}:${action}:${arg}`;
}

export function parseRuleCustomId(id: string): { action: RuleAction; arg: string } | null {
  const m = /^rule:(\w+):([A-Za-z0-9_-]*)$/.exec(id);
  if (!m || !ACTIONS.has(m[1] as RuleAction)) return null;
  return { action: m[1] as RuleAction, arg: m[2]! };
}

const MAX_CODE = 1500;

export type { Rendered };

/** The code fence's language for a compiled module's source. */
export function fenceLanguage(language: string): string {
  return language === "c" ? "c" : language === "rust" ? "rust" : language === "go" ? "go" : "";
}

/** A compiled module's source files, cut to `max` characters in all. */
export function sourceText(source: WasmSource, max: number): string[] {
  let room = max;
  const out: string[] = [];
  for (const f of source.files) {
    if (room <= 0) {
      out.push(`-# ほか ${f.path} など(続きは「ファイルで受け取る」)`);
      break;
    }
    const shown = f.content.length > room ? `${f.content.slice(0, room)}\n// …(続きは「ファイルで受け取る」)` : f.content;
    room -= shown.length;
    out.push(`\`${f.path}\`\n${fence(fenceLanguage(source.language), shown)}`);
  }
  return out;
}

function row(buttons: APIButtonComponent[]): APIComponentInContainer {
  return actionRow(buttons, 5);
}

const MAX_TEXT = 3900;
const SEPARATOR: APIComponentInContainer = { type: ComponentType.Separator };

/** A screen's parts in order: texts share the message's text budget, components stand as they are. */
function container(parts: Array<string | APIComponentInContainer>, accent?: number): Rendered {
  let room = MAX_TEXT;
  const children: APIComponentInContainer[] = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      children.push(part);
      continue;
    }
    const [text] = panelTexts([part], room);
    if (!text) continue;
    room -= text.content.length;
    children.push(text);
  }
  return v2Message(children, { ephemeral: true, ...(accent !== undefined ? { accent } : {}) });
}

/** The status line under a divider: empty when there is nothing to say. */
function noticeLine(notice: string | undefined): string {
  return notice ? `-# ${notice}` : "";
}

/** Whose permissions a rule's runs use: the one who caused the event, the owner, or the owner because the rule says so. */
export function triggerRunsAs(trigger: Rule["trigger"]): "actor" | "owner" | "owner_by_choice" {
  const byActor = triggerEvents(trigger).some((e) => ACTOR_EVENTS.has(e) || e === "COMMAND");
  if (!byActor) return "owner";
  return trigger.runAs === "owner" ? "owner_by_choice" : "actor";
}

/** `visibility: false` leaves out the reply audience of a command, for a screen that has its select. */
export function triggerLabel(trigger: Rule["trigger"], { visibility = true }: { visibility?: boolean } = {}): string {
  const label = triggerEvents(trigger)
    .map((e) => {
      if (ACTOR_EVENTS.has(e)) return `${TRIGGERS[e]!.label}(\`${e}\`、${trigger.runAs === "owner" ? "⚠️ 作成者の権限で動きます" : e === "INTERACTION_CREATE" ? "押した人の権限で動きます" : "付けた人・外した人の権限で動きます"})`;
      if (e === "COMMAND" && trigger.command) return `\`/${trigger.command.name}\` が実行されたとき${visibility ? visibilityClause(trigger.command.visibility) : ""}${trigger.runAs === "owner" ? "(⚠️ 作成者の権限で動きます)" : ""}`;
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
  const serial = !trigger.serialBy ? "" : trigger.serialBy === "rule" ? " · 1回ずつ順番に動きます" : ` · 同じ \`${trigger.serialBy}\` のイベントは順番に動きます`;
  return `${label}${origin}${debounce}${serial}`;
}

export function limitsLabel(limits: RuleLimits): string {
  return `1分に${limits.perMinute}回まで · ${limits.maxConsecutiveFailures}回続けて失敗したら自動で止まります`;
}

export function dryRunText(dry: RuleDryRun): string {
  const head = `**ドライラン**${dry.source ? `(${dry.source}で)` : ""}`;
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
      body.push(`次の操作をします(${dry.lines.length}種類):`, ...dry.lines.slice(0, 8));
      if (dry.lines.length > 8) body.push(`…ほか${dry.lines.length - 8}種類`);
  }
  if (dry.problems.length > 0) body.push(`⚠️ ${dry.problems.slice(0, 5).join("\n⚠️ ")}`);
  if (dry.response !== undefined) body.push(`応答: ${truncate(dry.response, 300)}`);
  if (dry.reply !== undefined || dry.images) body.push(`返事: ${truncate(dry.reply ?? "", 300)}${dry.images ? `(画像${dry.images}枚)` : ""}`);
  if (dry.state !== undefined) body.push(`次に持ち越す状態(実際には保存していません): \`${truncate(dry.state, 300)}\``);
  if (dry.logs.length > 0) body.push(`-# ログ: ${truncate(dry.logs.slice(0, 5).join(" / "), 300)}`);
  return [head, ...body].join("\n");
}

/** A rule's params, with ids named where the cache knows them. */
export function paramsText(params: Record<string, unknown>, label: (id: string) => string): string {
  return Object.entries(params)
    .slice(0, 10)
    .map(([k, v]) => {
      const text = typeof v === "string" && label(v) !== v ? `${label(v)}(${v})` : valueText(v, (id) => JSON.stringify(id));
      return `- ${k}: ${truncate(text ?? "null", 120)}`;
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

/** The rule's status; while every rule in the server is halted, that is what stands for all of them. */
function ruleStatus(rule: Rule, halted = false): string {
  if (halted) return "🛑 全ルール停止中";
  if (rule.enabled) return "🟢 動作中";
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

/** What a select holds at most. */
const SELECT_MAX = 25;

/** "ルールを開く(30件中25件)": the count, and how many the select can show when it cannot show all. */
function openLabel(what: string, unit: string, count: number): string {
  return `${what}(${count > SELECT_MAX ? `${count}${unit}中${SELECT_MAX}${unit}` : `${count}${unit}`})`;
}

/** Whether a rule runs, as the first word of a select option's description. */
function runningLabel(enabled: boolean): string {
  return enabled ? "動作中" : "停止中";
}

export function homeView(input: HomeInput): Rendered {
  const texts = ["## ルール"];
  if (input.halted) texts.push(`🛑 全ルールを停止中(<@${input.halted.by}>、${discordTime(input.halted.at)})`);
  if (input.rules.length === 0) texts.push("まだありません。会話でBotに頼むと作れます。");
  const parts: Array<string | APIComponentInContainer> = [...texts];
  if (input.rules.length > 0) {
    parts.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: ruleCustomId("open"),
        placeholder: openLabel("ルールを開く", "件", input.rules.length),
        options: input.rules.slice(0, SELECT_MAX).map((r) => {
          const last = input.lastRuns.get(r.id);
          const owner = r.ownerId === input.userId ? "" : " · ほかの人のルール";
          return {
            label: truncate(`${r.enabled ? "🟢" : "⏸️"} ${r.name}`, 100),
            value: r.id,
            description: truncate(`${runningLabel(r.enabled)} · ${triggerEvents(r.trigger).map((e) => (e === "COMMAND" && r.trigger.command ? `/${r.trigger.command.name}` : TRIGGERS[e]?.label ?? e)).join("/")}${last ? ` · 最後: ${OUTCOME_LABEL[last.outcome]}` : ""}${owner}`, 100),
          };
        }),
      }],
    });
  }
  parts.push(row([button(ruleCustomId("plans"), "変更案の履歴"), button(ruleCustomId("audit"), "監査ログ")]), SEPARATOR, noticeLine(input.notice));
  if (input.canHalt) {
    parts.push(row([input.halted ? button(ruleCustomId("resume"), "全ルールを再開", ButtonStyle.Primary) : button(ruleCustomId("halt"), "緊急停止", ButtonStyle.Danger)]));
  }
  parts.push(row([settingsHomeButton()]));
  return container(parts);
}

export interface DetailInput {
  rule: Rule;
  userId: string;
  page?: RulePage;
  runs: RuleRun[];
  can: { enable: boolean; disable: boolean; remove: boolean; owner: boolean };
  dry?: RuleDryRun;
  notice?: string;
  confirmDelete?: boolean;
  /** Every rule in the server is halted. */
  halted?: boolean;
  /** A press is being worked on: the buttons that act on the rule are left out. */
  busy?: boolean;
  /** What the rule keeps between runs; null when nothing. */
  state?: unknown;
  /** The source of a Wasm rule's module, when the bot compiled it. */
  wasmSource?: WasmSource;
}

const MAX_STATE_SHOWN = 600;

export function stateText(state: unknown, max = MAX_STATE_SHOWN): string {
  return truncate(JSON.stringify(state, null, 1), max);
}

function runLine(run: RuleRun): string {
  const error = run.error ? ` — ${truncate(run.error.replaceAll("\n", " "), 120)}` : "";
  const plan = run.planId ? ` 変更案 \`${run.planId}\`` : "";
  return `${discordTime(run.startedAt)} v${run.ruleVersion} ${OUTCOME_LABEL[run.outcome]}${plan}${error}`;
}

/** Pages, and deleting, sit in one menu so the buttons stay few. */
function pageMenu(rule: Rule, page: RulePage, canRemove: boolean): APIComponentInContainer {
  return {
    type: ComponentType.ActionRow,
    components: [{
      type: ComponentType.StringSelect,
      custom_id: ruleCustomId("view", rule.id),
      placeholder: "詳しく見る",
      options: [
        ...RULE_PAGES.map((p) => ({ label: PAGE_LABEL[p], value: p, default: p === page })),
        ...(canRemove ? [{ label: "このルールを削除…", value: DELETE_CHOICE }] : []),
      ],
    }],
  };
}

/** Whose permissions the rule runs with, in a sentence. */
function runsAsText(rule: Rule): string {
  switch (triggerRunsAs(rule.trigger)) {
    case "actor":
      return "動かした人の権限と判定モデルで動きます(許す操作が上限)";
    case "owner_by_choice":
      return `⚠️ <@${rule.ownerId}> の権限で動きます`;
    case "owner":
      return `<@${rule.ownerId}> の権限で動きます`;
  }
}

/** From the parts to the whole: the shown page, the menu that switches pages, then under a divider the status line and the buttons. */
export function detailView(input: DetailInput, label: (id: string) => string): Rendered {
  const { rule } = input;
  const page = input.page ?? "summary";
  const heading = `### ${rule.name}\n${ruleStatus(rule, input.halted)} · v${rule.version}${rule.ownerId === input.userId ? "" : ` · <@${rule.ownerId}>`}`;
  if (input.confirmDelete) {
    return container([
      heading,
      `⚠️ 「${rule.name}」を削除します。実行履歴と監査ログは残ります。`,
      row([button(ruleCustomId("delete2", rule.id), "削除する", ButtonStyle.Danger), button(ruleCustomId("open", rule.id), "やめる")]),
    ]);
  }
  const parts: Array<string | APIComponentInContainer> = [heading];
  const actions: APIButtonComponent[] = [];
  if (page === "summary") {
    const last = input.runs[0];
    // The owner picks who sees a command's replies here, without a new version, so the line above says it once.
    const selector = input.can.owner && rule.trigger.command;
    parts.push(triggerLabel(rule.trigger, { visibility: !selector }));
    if (selector) parts.push(VISIBILITY_HEADING, visibilitySelect(ruleCustomId("visibility", rule.id), rule.trigger.command?.visibility));
    parts.push(
      rule.summary ?? "説明を作れませんでした。「コード」で確かめてください。",
      last ? `-# 最後の実行: ${runLine(last)}` : "-# まだ実行されていません",
    );
    if (input.dry) parts.push(dryRunText(input.dry));
    if (!input.busy) {
      if (rule.enabled && input.can.disable) actions.push(button(ruleCustomId("disable", rule.id), "止める", ButtonStyle.Danger));
      if (!rule.enabled && input.can.enable) actions.push(button(ruleCustomId("enable", rule.id), "再開する", ButtonStyle.Primary));
      if (input.can.owner) actions.push(button(ruleCustomId("dry", rule.id), "ドライラン"));
    }
  } else if (page === "allow") {
    parts.push(
      `**許す操作**(これ以外の変更は実行されません)\n${allowLines(rule.allow, label).join("\n") || "なし(返事だけします)"}`,
      `${runsAsText(rule)} · 危険度: ${RISK_LABEL[allowRisk(rule.allow)]}\n${limitsLabel(rule.limits)}`,
      rule.params ? `**使う値**\n${paramsText(rule.params, label)}` : "",
    );
  } else if (page === "source") {
    parts.push(
      `**元の依頼**\n${truncate(rule.sourcePrompt, 300)}`,
      ...(rule.program.kind === "js"
        ? [fence("js", rule.program.code.length > MAX_CODE ? `${rule.program.code.slice(0, MAX_CODE)}\n// …(続きは「ファイルで受け取る」)` : rule.program.code)]
        : input.wasmSource
          ? [`**Wasmモジュール**(${input.wasmSource.language} のソースからBotがコンパイル、sha256 \`${rule.program.sha256.slice(0, 12)}\`)`, ...sourceText(input.wasmSource, MAX_CODE)]
          : [`**Wasmモジュール**を動かします\n${fence("", `sha256 ${rule.program.sha256}`)}\n-# アップロードされたモジュールなので、ソースはありません。`]),
    );
    if (rule.program.kind === "js" || input.wasmSource) parts.push(row([button(ruleCustomId("code", rule.id), "ファイルで受け取る")]));
    if (input.can.owner) parts.push(`-# 直すときは会話でBotに「ルール \`${rule.id}\`(${rule.name})を〜に直して」と頼みます。`);
  } else {
    parts.push(`**最近の実行**${input.runs.length > 0 ? `(${input.runs.length}件)` : ""}\n${input.runs.length > 0 ? input.runs.map(runLine).join("\n") : "まだありません"}`);
    const hasState = input.state !== undefined && input.state !== null;
    if (hasState) parts.push(`**状態**(次の実行に持ち越す値)\n${fence("json", stateText(input.state))}`);
    if (input.can.owner && hasState && !input.busy) parts.push(row([button(ruleCustomId("clearstate", rule.id), "状態を消す")]));
  }
  parts.push(pageMenu(rule, page, input.can.remove), SEPARATOR, noticeLine(input.notice));
  if (actions.length > 0) parts.push(row(actions));
  parts.push(row([button(ruleCustomId("home"), "← 一覧へ")]));
  return container(parts);
}

/** Up to three operation names of a plan, each once. */
function opNames(plan: PlanRow["plan"]): string {
  return [...new Set(plan.steps.map((s) => CATALOG.get(s.op)?.label ?? s.op))].slice(0, 3).join("・");
}

export function plansView(plans: Array<PlanRow & { updatedAt?: string }>, all: boolean): Rendered {
  const lines = plans.map(({ plan, status, reason }) => {
    const who = plan.rule ? `ルール「${plan.rule.name}」` : `<@${plan.actor.userId}>`;
    return `${discordTime(plan.createdAt)} \`${plan.id}\` ${PLAN_STATUS_LABEL[status]} · ${who} · ${plan.steps.length}件 ${opNames(plan)}${reason ? ` — ${truncate(reason.replaceAll("\n", " "), 80)}` : ""}`;
  });
  return container([
    `### 変更案の履歴(${plans.length}件)${all ? "" : "\n-# あなたの分だけです(ルールによるものを含む)"}`,
    lines.join("\n") || "ありません",
    row([button(ruleCustomId("home"), "← 一覧へ")]),
  ]);
}

function actorText(entry: AuditEntry): string {
  const a = entry.actor;
  if (a.kind === "system") return "Bot";
  return a.via === "rule" ? `<@${a.userId}> のルール` : `<@${a.userId}>`;
}

export function auditView(entries: AuditEntry[], all: boolean): Rendered {
  const lines = entries.map((e) => {
    const ref = e.planId ? ` 変更案 \`${e.planId}\`` : e.ruleId ? ` ルール \`${e.ruleId}\`` : "";
    return `${discordTime(e.at)} ${actorText(e)} ${auditActionLabel(e.action)}${ref}`;
  });
  return container([
    `### 監査ログ(${entries.length}件)${all ? "" : "\n-# あなたの分だけです。全件は「監査ログを表示」の権限で見られます。"}`,
    lines.join("\n") || "ありません",
    row([button(ruleCustomId("home"), "← 一覧へ")]),
  ]);
}

// --- Commands -------------------------------------------------------------
// The commands section of /settings: the server's guild commands (each one a
// rule's), every one the presser may run as a link that runs it, and for their
// own commands a page to manage them.

export interface CommandsInput {
  /** Enabled commands the presser may run, and their own commands, enabled or not. */
  rules: Rule[];
  userId: string;
  /** Registered ids by command name, for </name:id> links. */
  ids: Record<string, string>;
  /** Every rule in the server is halted. */
  halted?: boolean;
  notice?: string;
}

function commandLink(name: string, ids: Record<string, string>): string {
  return ids[name] ? `</${name}:${ids[name]}>` : `\`/${name}\``;
}

export function commandsView(input: CommandsInput): Rendered {
  const lines = input.rules.map((r) => {
    const c = r.trigger.command!;
    const status = r.enabled ? commandLink(c.name, input.ids) : `\`/${c.name}\` ⏸️ 停止中`;
    const owner = r.ownerId === input.userId ? "あなた" : `<@${r.ownerId}>`;
    return `${status} ${c.description}\n-# 作成: ${owner}${c.permissions?.length ? ` · 必要な権限: ${permissionList(c.permissions)}` : ""}`;
  });
  const parts: Array<string | APIComponentInContainer> = [
    "## コマンド",
    input.halted ? "🛑 全ルール停止中" : "",
    lines.length ? lines.join("\n") : "使えるコマンドはまだありません。会話でBotに頼むと作れます。",
    noticeLine(input.notice),
  ];
  const own = input.rules.filter((r) => r.ownerId === input.userId);
  if (own.length > 0) {
    parts.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: ruleCustomId("cmd"),
        placeholder: openLabel("自分のコマンドを開く", "件", own.length),
        options: own.slice(0, SELECT_MAX).map((r) => ({
          label: truncate(`${r.enabled ? "🟢" : "⏸️"} /${r.trigger.command!.name}`, 100),
          value: r.id,
          description: truncate(`${runningLabel(r.enabled)} · ${r.trigger.command!.description}`, 100),
        })),
      }],
    });
  }
  parts.push(row([settingsHomeButton()]));
  return container(parts);
}

export interface CommandInput {
  rule: Rule;
  ids: Record<string, string>;
  notice?: string;
  confirmDelete?: boolean;
}

/** One of the presser's own commands: who sees its replies, its rule, and deleting it with the rule. */
export function commandView(input: CommandInput): Rendered {
  const { rule } = input;
  const c = rule.trigger.command!;
  const options = (c.options ?? []).map((o) => `- \`${o.name}\`${o.required ? "(必須)" : ""}: ${o.description}`);
  const parts: Array<string | APIComponentInContainer> = [
    `## ${rule.enabled ? commandLink(c.name, input.ids) : `/${c.name}`}`,
    [c.description, rule.enabled ? "" : "⏸️ 停止中(ルールを再開すると使えます)", c.permissions?.length ? `必要な権限: ${permissionList(c.permissions)}` : ""].filter(Boolean).join("\n"),
    options.length ? `**オプション**\n${options.join("\n")}` : "",
    `関連ルール: 「${rule.name}」`,
  ];
  if (input.confirmDelete) {
    parts.push(noticeLine(input.notice), `⚠️ 「/${c.name}」とルール「${rule.name}」を削除します。実行履歴と監査ログは残ります。`);
    parts.push(row([button(ruleCustomId("cmddel2", rule.id), "削除する", ButtonStyle.Danger), button(ruleCustomId("cmd", rule.id), "やめる")]));
    return container(parts);
  }
  parts.push(
    VISIBILITY_HEADING,
    visibilitySelect(ruleCustomId("cmdvis", rule.id), c.visibility),
    SEPARATOR,
    noticeLine(input.notice),
    row([button(ruleCustomId("cmddel", rule.id), "コマンドを削除", ButtonStyle.Danger)]),
    row([button(ruleCustomId("open", rule.id), "関連ルールを見る"), button(ruleCustomId("commands"), "← 一覧へ")]),
  );
  return container(parts);
}
