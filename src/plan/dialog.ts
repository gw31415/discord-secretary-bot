import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIMediaGalleryComponent,
  APITextDisplayComponent,
  APIMessageTopLevelComponent,
  APIModalInteractionResponseCallbackData,
  APIStringSelectComponent,
} from "discord-api-types/v10";
import type { StepRow } from "../db.ts";
import { allowLines, allowRisk } from "../rules/allow.ts";
import { fenceLanguage, limitsLabel, paramsText, triggerLabel } from "../rules/panel.ts";
import { VISIBILITY_CHOICES } from "../rules/command.ts";
import type { Body } from "./catalog.ts";
import { dialogFileName, dialogImageIds } from "./files.ts";
import { RISK_LABEL } from "./types.ts";
import type { Plan, PlanRuleDraft, PlanStatus, Risk, Step } from "./types.ts";
import { irreversibleSteps, specOf, stepRisk } from "./validate.ts";

// The approval dialog, drawn only from the Plan and its step states. Nothing
// the conversing model wrote as explanation appears here; a plan made from code
// shows the code and an explanation written by a model that read only the code.

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
  | "keep"
  | "code"
  | "result"
  | "details"
  | "visibility";
const ACTIONS = new Set<PlanAction>(["run", "cancel", "json", "confirm", "revise", "revisetext", "redo", "resume", "restore", "keep", "code", "result", "details", "visibility"]);

/** `rule` names which of the plan's rules a control is for ("visibility.r1"). */
export function customId(action: PlanAction, plan: Pick<Plan, "id" | "hash">, rule?: string): string {
  return `plan:${action}${rule ? `.${rule}` : ""}:${plan.id}:${plan.hash.slice(0, 8)}`;
}

export function parsePlanCustomId(id: string): { action: PlanAction; planId: string; hash8: string; rule?: string } | null {
  const m = /^plan:(\w+)(?:\.(r\d+))?:([A-Za-z0-9_-]+):([0-9a-f]{8})$/.exec(id);
  if (!m || !ACTIONS.has(m[1] as PlanAction)) return null;
  return { action: m[1] as PlanAction, planId: m[3]!, hash8: m[4]!, ...(m[2] ? { rule: m[2] } : {}) };
}


/** While the plan waits, who sees each command's replies is picked here; the pick is part of what is approved. */
function visibilityRows(plan: Plan, state: DialogState): APIActionRowComponent<APIStringSelectComponent>[] {
  if (state.status !== "pending_approval" || state.actions === false) return [];
  const commands = (plan.rules ?? []).filter((r) => r.trigger.command);
  return commands.map((r) => ({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: customId("visibility", plan, r.key),
        options: VISIBILITY_CHOICES.map((o) => ({
          value: o.value,
          label: commands.length > 1 ? `/${r.trigger.command!.name}: ${o.label}` : o.label,
          default: (r.trigger.command!.visibility ?? "auto") === o.value,
        })),
      },
    ],
  }));
}

const MAX_LISTED = 15;
const MAX_TEXT = 3900;
const MAX_CODE = 2500;
const MAX_STEPS_JSON = 1500;
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

/** Single messages deleted up to this many, and DMs up to this many, take one click. */
const LIGHT_MESSAGE_DELETES = 3;
const LIGHT_DMS = 10;

/**
 * Irreversible steps that are worth typing a name for. Lighter losses take one click:
 * moving someone in voice, deleting a channel that never had a message, a few
 * single messages, and a handful of DMs (their text is in the dialog).
 */
export function typedConfirmSteps(plan: Plan): Step[] {
  const empty = new Set(plan.emptyChannels ?? []);
  const lossy = irreversibleSteps(plan.steps).filter((s) => {
    if (s.op === "PATCH /guilds/{guild}/members/{user}") return false;
    if (s.op === "DELETE /channels/{channel}") return !empty.has(String(s.pathParams.channel));
    return true;
  });
  const messages = lossy.filter((s) => s.op === "DELETE /channels/{channel}/messages/{message}");
  const dms = lossy.filter((s) => s.op === "POST /users/{user}/dm");
  return lossy.filter(
    (s) =>
      !(messages.length <= LIGHT_MESSAGE_DELETES && messages.includes(s)) &&
      !(dms.length <= LIGHT_DMS && dms.includes(s)),
  );
}

/** What the person must type to run a plan with serious irreversible steps: the target's name, or the count. */
export function confirmPhrase(plan: Plan): string {
  const irreversible = typedConfirmSteps(plan);
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
  return typedConfirmSteps(plan).length > 0;
}

/**
 * "result": the summary every dialog opens on (what changes, what each rule does);
 * "code": the code with its explanation; "details": the exact calls and each rule's allow, params and limits.
 */
export type DialogView = "code" | "result" | "details";

export interface DialogState {
  status: PlanStatus;
  /** Which page is shown; every dialog opens on the summary. */
  view?: DialogView;
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
      const rules = plan.rules?.length ? `${plan.steps.length > 0 ? "変更のあとに" : ""}ルールを登録し、以後はイベントのたびに人の確認なしで動きます。` : "";
      return `依頼者が「実行」を押すと実行します。${rules}${how}違うところがあれば「修正」から直せます。期限 <t:${unix(plan.expiresAt)}:R>`;
    }
    case "approved":
    case "executing":
      return plan.steps.length > 1 ? `実行中… ${done}/${plan.steps.length}` : "実行中…";
    case "succeeded":
      return plan.rules?.length ? `✅ 実行し、ルール${plan.rules.length}件を登録しました。\`/settings\` の「ルール」で止めたり実行履歴を見たりできます。` : "✅ 実行しました";
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
  if (state.actions === false) return out;
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
  return out;
}

const VIEW_LABEL: Record<DialogView, string> = { result: "概要", code: "コード", details: "詳細" };

/** The pages this plan has: code only when it was made from code or registers rules, details only when there is more to show. */
function views(plan: Plan): DialogView[] {
  const out: DialogView[] = ["result"];
  if (hasCode(plan)) out.push("code");
  if (plan.rules?.length || (plan.source && plan.steps.length > 0)) out.push("details");
  return out;
}

function navButtons(plan: Plan, state: DialogState): APIButtonComponent[] {
  const current = viewOf(plan, state);
  const pages = views(plan);
  const out: APIButtonComponent[] = pages.length > 1
    ? pages.map((v) => ({ ...button(customId(v, plan), VIEW_LABEL[v], v === current ? ButtonStyle.Primary : ButtonStyle.Secondary), disabled: v === current }))
    : [];
  out.push(button(customId("json", plan), "JSONを見る", ButtonStyle.Secondary));
  return out;
}

function hasCode(plan: Plan): boolean {
  return !!plan.source || !!plan.rules?.length;
}

function viewOf(plan: Plan, state: DialogState): DialogView {
  const view = state.view ?? "result";
  return views(plan).includes(view) ? view : "result";
}

/** Keeps a code block from being closed by its own content. */
function fenced(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body.replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function codeBody(plan: Plan, room: number): string[] {
  const parts: Array<{ title: string; code: string; summary: string | null; wasm?: string; lang?: string }> = [
    ...(plan.source ? [{ title: "コードの説明", ...plan.source }] : []),
    ...(plan.rules ?? []).map((r) => ({
      title: r.program.kind === "wasm" ? `ルール「${r.name}」が動かすWasm${r.program.module.source ? `(${r.program.module.source.language} からBotがコンパイル)` : ""}` : `ルール「${r.name}」のコードの説明`,
      code: r.program.kind === "js" ? r.program.code : r.program.module.source ? r.program.module.source.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n") : "",
      ...(r.program.kind === "wasm" && !r.program.module.source ? { wasm: `sha256 ${r.program.module.sha256}${r.program.module.producers.length ? `\nビルド: ${r.program.module.producers.join("、")}` : ""}` } : {}),
      ...(r.program.kind === "wasm" && r.program.module.source ? { lang: fenceLanguage(r.program.module.source.language) } : {}),
      summary: r.replaces?.before && r.summary ? `変更前: ${r.replaces.before.summary ?? "説明はありません"}\n変更後: ${r.summary}` : r.summary,
    })),
  ];
  const share = Math.floor(room / Math.max(1, parts.length));
  return parts.flatMap(({ title, code, summary, wasm, lang }) => {
    if (wasm) return [`**${title}**\n${summary ?? ""}`, fenced("", wasm)];
    const explained = summary ?? "説明を作れませんでした。コードを読んで確かめてください。";
    const limit = Math.max(200, Math.min(MAX_CODE, share - explained.length - 200));
    const shown = code.length > limit ? `${code.slice(0, limit)}\n// …(続きは「JSONを見る」)` : code;
    return [`**${title}**\n${explained}`, fenced(lang ?? "js", shown)];
  });
}

/** The code block language for a compiler language id. */
function replyLine(r: PlanRuleDraft): string {
  const images = r.dry.images ? `(画像${r.dry.images}枚)` : "";
  const response = r.dry.response ? `\n　応答: ${r.dry.response.slice(0, 200)}` : "";
  return `${r.dry.reply || images ? `\n　返事: ${(r.dry.reply ?? "").slice(0, 200)}${images}` : ""}${response}`;
}

function dryLine(r: PlanRuleDraft): string {
  const where = r.dry.source ? `${r.dry.source}で` : "";
  switch (r.dry.outcome) {
    case "steps":
      return `ドライラン(${where}試行): ${r.dry.lines.length}種類の変更をします\n${r.dry.lines.slice(0, 3).map((l) => `　${l}`).join("\n")}${replyLine(r)}`;
    case "none":
      return `ドライラン(${where}試行): 何も変更しません${replyLine(r)}`;
    case "pending":
      return "ドライラン: この変更で作るものを使うため、登録後に動きます(コードがエラーにならないことは確かめました)";
    case "no_event":
      return "ドライラン: 試せるイベントがありませんでした";
    case "error":
      return `ドライラン: エラー ${r.dry.problems[0] ?? ""}`;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** For a new version of a rule: what it did before and what it will do, then which settings changed. */
function beforeAfter(r: PlanRuleDraft): string[] {
  if (!r.replaces) return [];
  const before = r.replaces.before;
  if (!before) return ["変更前: この場所では前の版の内容を表示できません"];
  const unexplained = "説明はありません";
  const changed = [
    !same(before.trigger, r.trigger) ? `きっかけ(${triggerLabel(before.trigger)} → ${triggerLabel(r.trigger)})` : null,
    !same(before.allow, r.allow) ? "許す操作" : null,
    !same(before.params ?? null, r.params ?? null) ? "params" : null,
  ].filter((c): c is string => c !== null);
  return [
    `変更前: ${before.summary ?? unexplained}`,
    `変更後: ${r.summary ?? unexplained}`,
    changed.length > 0 ? `変わる設定: ${changed.join("、")}` : "コード以外の設定は変わりません",
  ];
}

/** The rules a plan registers, in short: when each runs, what it does, and how its dry run went. */
function ruleSummaries(plan: Plan): string[] {
  if (!plan.rules?.length) return [];
  const owner = label(plan, plan.actor.userId);
  return [
    `**登録するルール**(${owner} の権限で、人の確認なしに動きます。許す操作などは「詳細」)`,
    ...plan.rules.map((r) =>
      [
        `**${r.name}**${r.replaces ? `(「${r.replaces.name}」v${r.replaces.version} を置き換え)` : ""} · 危険度: ${RISK_LABEL[allowRisk(r.allow)]}`,
        `きっかけ: ${triggerLabel(r.trigger)}`,
        ...(r.replaces ? beforeAfter(r) : [r.summary ?? "説明を作れませんでした。「コード」で確かめてください。"]),
        dryLine(r),
      ].join("\n"),
    ),
  ];
}

/** Each rule's full definition, drawn only from it. */
function ruleDetails(plan: Plan): string[] {
  if (!plan.rules?.length) return [];
  const lookup = (id: string) => label(plan, id);
  return plan.rules.map((r) =>
    [
      `**${r.name}**`,
      ...(r.limits ? [limitsLabel(r.limits)] : []),
      `許す操作(これ以外の変更は実行されません):\n${allowLines(r.allow, lookup).join("\n") || "なし(返事だけします)"}`,
      ...(r.params ? [`params:\n${paramsText(r.params, lookup)}`] : []),
    ].join("\n"),
  );
}

function resultBody(plan: Plan, state: DialogState): string[] {
  const lines = stepLines(plan, state.status === "pending_approval" ? undefined : state.steps);
  const listed = lines.slice(0, MAX_LISTED);
  if (lines.length > MAX_LISTED) listed.push(`…ほか${lines.length - MAX_LISTED}種類(全件は「JSONを見る」)`);
  const explained = plan.source ? [`**コードの説明**\n${plan.source.summary ?? "説明を作れませんでした。「コード」で確かめてください。"}`] : [];
  return [...explained, ...listed, ...ruleSummaries(plan)];
}

function detailsBody(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.source && plan.steps.length > 0) {
    // The exact calls the code produced, when they fit.
    const json = JSON.stringify(plan.steps.map((s) => ({ id: s.id, op: s.op, path: s.pathParams, ...(s.body !== undefined ? { body: s.body } : {}) })));
    out.push(`**コードが作った変更**\n${json.length <= MAX_STEPS_JSON ? fenced("json", json) : "長いため「JSONを見る」で確かめてください"}`);
  }
  return [...out, ...ruleDetails(plan)];
}

/** The images the plan posts, uploaded with the dialog so the approver sees them. */
function gallery(plan: Plan): Array<APIMediaGalleryComponent | APITextDisplayComponent> {
  const ids = dialogImageIds(plan);
  if (ids.length === 0) return [];
  const rest = Object.keys(plan.attachments ?? {}).length - ids.length;
  return [
    { type: ComponentType.MediaGallery, items: ids.map((id) => ({ media: { url: `attachment://${dialogFileName(id, plan.attachments![id]!)}` }, description: plan.attachments![id]!.name })) },
    ...(rest > 0 ? [{ type: ComponentType.TextDisplay as const, content: `-# ほかに画像${rest}枚(ここには最初の${ids.length}枚を表示しています)` }] : []),
  ];
}

export function renderDialog(plan: Plan, state: DialogState): { components: APIMessageTopLevelComponent[]; flags: MessageFlags } {
  const title = "### 変更の確認";
  const counts = [`${plan.steps.length}件`, ...(plan.rules?.length ? [`ルール${plan.rules.length}件`] : [])].join(" · ");
  const header = `${title}\n依頼: ${label(plan, plan.actor.userId)} · 危険度: ${RISK_LABEL[plan.risk]} · ${counts} · \`${plan.id}\``;
  const status = statusLine(plan, state);
  const view = viewOf(plan, state);
  const body = view === "code" ? codeBody(plan, MAX_TEXT - header.length - status.length) : view === "details" ? detailsBody(plan) : resultBody(plan, state);
  const text = [header, ...body, "", status].join("\n").slice(0, MAX_TEXT);
  const rows: APIActionRowComponent<APIButtonComponent>[] = [buttons(plan, state), navButtons(plan, state)]
    .filter((b) => b.length > 0)
    .map((components) => ({ type: ComponentType.ActionRow, components }));
  return {
    components: [
      {
        type: ComponentType.Container,
        accent_color: color(plan, state.status),
        components: [{ type: ComponentType.TextDisplay, content: text }, ...gallery(plan), ...visibilityRows(plan, state), ...rows],
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
  const rows = container.components.filter((c) => c.type === ComponentType.ActionRow);
  return rows.flatMap((r) => r.components ?? []).filter((b) => (b as { type?: number }).type === ComponentType.Button).map((b) => b.label ?? "");
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
