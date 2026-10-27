import { ButtonStyle, ComponentType, MessageFlags } from "discord-api-types/v10";
import type { APIButtonComponent, APIComponentInContainer, APIMessageTopLevelComponent } from "discord-api-types/v10";
import { VISIBILITY_CHOICES } from "./command.ts";
import type { AuditEntry, PlanRow, WasmSource } from "../db.ts";
import { RISK_LABEL } from "../plan/types.ts";
import type { RuleDryRun } from "../plan/types.ts";
import { allowLines, allowRisk, valueText } from "./allow.ts";
import type { Halt } from "./engine.ts";
import { DEFAULT_TIMEZONE } from "./schedule.ts";
import { ACTOR_EVENTS, TRIGGERS, triggerEvents } from "./triggers.ts";
import type { Rule, RuleLimits, RuleRun, RunOutcome } from "./types.ts";

const VISIBILITY_LABEL = { auto: "(返事を全員に見せるかは判定用のモデルが決めます)", private: "(返事は実行した人だけに見えます)", public: "(返事は全員に見えます)" } as const;

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

/** The settings panel's home (CUSTOM_ID.page("home") in llm/panel.ts); the rules are one of its sections. */
export const SETTINGS_HOME_ID = "llm:page:home";

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
      out.push(`-# ほか ${f.path} など(続きは「ファイルで」)`);
      break;
    }
    const shown = f.content.length > room ? `${f.content.slice(0, room)}\n// …(続きは「ファイルで」)` : f.content;
    room -= shown.length;
    out.push(`\`${f.path}\`\n${fenced(fenceLanguage(source.language), shown)}`);
  }
  return out;
}

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
      if (ACTOR_EVENTS.has(e)) return `${TRIGGERS[e]!.label}(\`${e}\`、${trigger.runAs === "owner" ? "⚠️ 作成者の権限で動きます" : e === "INTERACTION_CREATE" ? "押した人の権限で動きます" : "付けた人・外した人の権限で動きます"})`;
      if (e === "COMMAND" && trigger.command) return `\`/${trigger.command.name}\` が実行されたとき${VISIBILITY_LABEL[trigger.command.visibility ?? "auto"]}${trigger.runAs === "owner" ? "(⚠️ 作成者の権限で動きます)" : ""}`;
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
  const serial = !trigger.serialBy ? "" : trigger.serialBy === "rule" ? " · 1回ずつ順番に動きます" : ` · ${trigger.serialBy} が同じイベントは順番に動きます`;
  return `${label}${origin}${debounce}${serial}`;
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
  if (dry.response !== undefined) body.push(`応答: ${clip(dry.response, 300)}`);
  if (dry.reply !== undefined || dry.images) body.push(`返事: ${clip(dry.reply ?? "", 300)}${dry.images ? `(画像${dry.images}枚)` : ""}`);
  if (dry.state !== undefined) body.push(`次に持ち越す状態(実際には保存していません): \`${clip(dry.state, 300)}\``);
  if (dry.logs.length > 0) body.push(`-# log: ${clip(dry.logs.slice(0, 5).join(" / "), 300)}`);
  return [head, ...body].join("\n");
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
  const texts = ["## ルール"];
  if (input.halted) texts.push(`🛑 全ルールを停止中(<@${input.halted.by}>、<t:${unix(input.halted.at)}:R>)`);
  if (input.rules.length === 0) texts.push("まだありません。会話でBotに頼むと作れます。");
  if (input.notice) texts.push(`-# ${input.notice}`);
  const rows: APIComponentInContainer[] = [];
  if (input.rules.length > 0) {
    rows.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: ruleCustomId("open"),
        placeholder: `ルールを開く(${input.rules.length}件)`,
        options: input.rules.slice(0, 25).map((r) => {
          const last = input.lastRuns.get(r.id);
          const owner = r.ownerId === input.userId ? "" : " · ほかの人のルール";
          return {
            label: clip(`${r.enabled ? "🟢" : "⏸️"} ${r.name}`, 100),
            value: r.id,
            description: clip(`${triggerEvents(r.trigger).map((e) => (e === "COMMAND" && r.trigger.command ? `/${r.trigger.command.name}` : TRIGGERS[e]?.label ?? e)).join("/")}${last ? ` · 最後: ${OUTCOME_LABEL[last.outcome]}` : ""}${owner}`, 100),
          };
        }),
      }],
    });
  }
  const buttons = [button(ruleCustomId("plans"), "変更の履歴"), button(ruleCustomId("audit"), "監査ログ")];
  if (input.canHalt) {
    buttons.push(input.halted ? button(ruleCustomId("resume"), "全ルールを再開", ButtonStyle.Primary) : button(ruleCustomId("halt"), "緊急停止", ButtonStyle.Danger));
  }
  rows.push(row(buttons), row([button(SETTINGS_HOME_ID, "← 設定のトップへ")]));
  return container(texts, rows);
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
  /** What the rule keeps between runs; null when nothing. */
  state?: unknown;
  /** The source of a Wasm rule's module, when the bot compiled it. */
  wasmSource?: WasmSource;
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

export function detailView(input: DetailInput, label: (id: string) => string): Rendered {
  const { rule } = input;
  const page = input.page ?? "summary";
  const texts = [`### ${rule.name}\n${ruleStatus(rule)} · v${rule.version}${rule.ownerId === input.userId ? "" : ` · <@${rule.ownerId}>`}`];
  if (input.confirmDelete) {
    texts.push("⚠️ 本当に削除しますか? 実行履歴と監査ログは残ります。");
    return container(texts, [row([button(ruleCustomId("delete2", rule.id), "削除する", ButtonStyle.Danger), button(ruleCustomId("open", rule.id), "やめる")])]);
  }
  const rows: APIComponentInContainer[] = [];
  const back = button(ruleCustomId("home"), "一覧へ");
  const buttons: APIButtonComponent[] = [back];
  if (page === "summary") {
    const last = input.runs[0];
    texts.push(
      triggerLabel(rule.trigger),
      rule.summary ?? "説明を作れませんでした。「コード」で確かめてください。",
      last ? `-# 最後の実行: ${runLine(last)}` : "-# まだ実行されていません",
    );
    if (input.dry) texts.push(dryRunText(input.dry));
    // The owner picks who sees a command's replies here, without a new version.
    if (input.can.owner && rule.trigger.command) {
      rows.push({
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.StringSelect,
          custom_id: ruleCustomId("visibility", rule.id),
          options: VISIBILITY_CHOICES.map((o) => ({ value: o.value, label: o.label, default: (rule.trigger.command!.visibility ?? "auto") === o.value })),
        }],
      });
    }
    if (rule.enabled && input.can.disable) buttons.push(button(ruleCustomId("disable", rule.id), "止める", ButtonStyle.Danger));
    if (!rule.enabled && input.can.enable) buttons.push(button(ruleCustomId("enable", rule.id), "有効にする", ButtonStyle.Primary));
    if (input.can.owner) buttons.push(button(ruleCustomId("dry", rule.id), "ドライラン"));
  } else if (page === "allow") {
    texts.push(
      `**許す操作**(これ以外の変更は実行されません)\n${allowLines(rule.allow, label).join("\n") || "なし(返事だけします)"}`,
      `${rule.trigger.command ? "実行した人の権限と判定モデルで動きます(許す操作が上限)" : `<@${rule.ownerId}> の権限で動きます`} · 危険度: ${RISK_LABEL[allowRisk(rule.allow)]}\n${limitsLabel(rule.limits)}`,
      rule.params ? `**params**(コードが読む値)\n${paramsText(rule.params, label)}` : "",
    );
  } else if (page === "source") {
    texts.push(
      `**元の依頼**\n${clip(rule.sourcePrompt, 300)}`,
      ...(rule.program.kind === "js"
        ? [fenced("js", rule.program.code.length > MAX_CODE ? `${rule.program.code.slice(0, MAX_CODE)}\n// …(続きは「ファイルで」)` : rule.program.code)]
        : input.wasmSource
          ? [`**Wasmモジュール**(${input.wasmSource.language} のソースからBotがコンパイル、sha256 \`${rule.program.sha256.slice(0, 12)}\`)`, ...sourceText(input.wasmSource, MAX_CODE)]
          : [`**Wasmモジュール**を動かします\n${fenced("", `sha256 ${rule.program.sha256}`)}\n-# アップロードされたモジュールなので、ソースはありません。`]),
    );
    if (input.can.owner) texts.push(`-# 直すときは会話でBotに「ルール \`${rule.id}\`(${rule.name})を〜に直して」と頼みます。`);
    if (rule.program.kind === "js" || input.wasmSource) buttons.push(button(ruleCustomId("code", rule.id), "ファイルで"));
  } else {
    texts.push(`**最近の実行**\n${input.runs.length > 0 ? input.runs.map(runLine).join("\n") : "まだありません"}`);
    const hasState = input.state !== undefined && input.state !== null;
    if (hasState) texts.push(`**状態**(次の実行に持ち越す値)\n${fenced("json", stateText(input.state))}`);
    if (input.can.owner && hasState) buttons.push(button(ruleCustomId("clearstate", rule.id), "状態を消す"));
  }
  if (input.notice) texts.push(`-# ${input.notice}`);
  return container(texts, [pageMenu(rule, page, input.can.remove), ...rows, row(buttons)]);
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
    return `${status} ${c.description}\n-# 作成: ${owner}${c.permissions?.length ? ` · 必要な権限: ${c.permissions.join(", ")}` : ""}`;
  });
  const texts = ["## コマンド", lines.length ? lines.join("\n") : "使えるコマンドはまだありません。会話でBotに頼むと作れます。"];
  if (input.notice) texts.push(`-# ${input.notice}`);
  const own = input.rules.filter((r) => r.ownerId === input.userId);
  const rows: APIComponentInContainer[] = [];
  if (own.length > 0) {
    rows.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: ruleCustomId("cmd"),
        placeholder: `自分のコマンドを開く(${own.length}件)`,
        options: own.slice(0, 25).map((r) => ({
          label: clip(`${r.enabled ? "🟢" : "⏸️"} /${r.trigger.command!.name}`, 100),
          value: r.id,
          description: clip(r.trigger.command!.description, 100),
        })),
      }],
    });
  }
  rows.push(row([button(SETTINGS_HOME_ID, "← 設定のトップへ")]));
  return container(texts, rows);
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
  const texts = [
    `## ${rule.enabled ? commandLink(c.name, input.ids) : `/${c.name}`}`,
    [c.description, rule.enabled ? "" : "⏸️ 停止中(ルールを有効にすると使えます)", c.permissions?.length ? `必要な権限: ${c.permissions.join(", ")}` : ""].filter(Boolean).join("\n"),
    options.length ? `**オプション**\n${options.join("\n")}` : "",
    `関連ルール: 「${rule.name}」`,
  ];
  if (input.notice) texts.push(`-# ${input.notice}`);
  if (input.confirmDelete) {
    texts.push(`⚠️ コマンド /${c.name} と関連ルール「${rule.name}」を削除します。実行履歴と監査ログは残ります。`);
    return container(texts, [row([button(ruleCustomId("cmddel2", rule.id), "削除する", ButtonStyle.Danger), button(ruleCustomId("cmd", rule.id), "やめる")])]);
  }
  return container(texts, [
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: ruleCustomId("cmdvis", rule.id),
        options: VISIBILITY_CHOICES.map((o) => ({ value: o.value, label: o.label, default: (c.visibility ?? "auto") === o.value })),
      }],
    },
    row([button(ruleCustomId("open", rule.id), "関連ルールを見る"), button(ruleCustomId("cmddel", rule.id), "コマンドを削除", ButtonStyle.Danger), button(ruleCustomId("commands"), "← コマンド一覧")]),
  ]);
}
