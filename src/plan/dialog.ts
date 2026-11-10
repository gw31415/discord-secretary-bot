import { ButtonStyle, ComponentType, TextInputStyle } from "discord-api-types/v10";
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
import { visibilitySelect } from "../rules/command.ts";
import { DEFAULT_LIMITS } from "../rules/types.ts";
import { messageRef } from "./catalog.ts";
import type { Body } from "./catalog.ts";
import { lineDiff } from "./diff.ts";
import { dialogFileName, dialogImageIds } from "./files.ts";
import { draftOf, RISK_LABEL } from "./types.ts";
import type { Plan, PlanRuleDraft, PlanStatus, Risk, Step } from "./types.ts";
import { irreversibleSteps, specOf, stepRisk } from "./validate.ts";
import { NS } from "../discord/custom-id.ts";
import { actionRow, button, discordTime, fence, textDisplay, v2Message } from "../discord/ui.ts";
import type { Rendered } from "../discord/ui.ts";
import { discordErrorText, settingsCommand } from "../discord/labels.ts";
import { sentence, truncate } from "../text.ts";

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
  | "visibility"
  | "files"
  | "view";
const ACTIONS = new Set<PlanAction>(["run", "cancel", "json", "confirm", "revise", "revisetext", "redo", "resume", "restore", "keep", "code", "result", "details", "visibility", "files", "view"]);

/** `rule` names which of the plan's rules a control is for ("visibility.r1"). */
export function customId(action: PlanAction, plan: Pick<Plan, "id" | "hash">, rule?: string): string {
  return `${NS.plan}:${action}${rule ? `.${rule}` : ""}:${plan.id}:${plan.hash.slice(0, 8)}`;
}

export function parsePlanCustomId(id: string): { action: PlanAction; planId: string; hash8: string; rule?: string } | null {
  const m = /^plan:(\w+)(?:\.(r\d+))?:([A-Za-z0-9_-]+):([0-9a-f]{8})$/.exec(id);
  if (!m || !ACTIONS.has(m[1] as PlanAction)) return null;
  return { action: m[1] as PlanAction, planId: m[3]!, hash8: m[4]!, ...(m[2] ? { rule: m[2] } : {}) };
}


/** While the plan waits, who sees a command's replies is picked under its rule; the pick is part of what is approved. */
function visibilityRow(plan: Plan, state: DialogState, r: PlanRuleDraft): APIActionRowComponent<APIStringSelectComponent>[] {
  if (state.status !== "pending_approval" || state.actions === false || state.busy || !r.trigger.command) return [];
  return [visibilitySelect(customId("visibility", plan, r.key), r.trigger.command.visibility)];
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

/**
 * A resource key ("role:123", "message:1/2") as people know the thing: by the
 * name the plan labelled it with, else as the key itself.
 */
export function resourceName(plan: Plan, resource: string): string {
  const sep = resource.indexOf(":");
  const kind = resource.slice(0, sep);
  const [a, b] = resource.slice(sep + 1).split("/") as [string, string | undefined];
  const named = (id: string | undefined) => (id === undefined ? undefined : plan.labels[id]);
  const name = beforeOf(plan, resource)?.name;
  switch (kind) {
    case "role":
    case "channel":
      return named(a) ?? resource;
    case "member":
      return named(a) ? `@${named(a)}` : resource;
    case "message":
      return named(a) && b ? messageRef({ channel: a, message: b }, (id) => label(plan, id), plan.guildId) : resource;
    case "emoji":
      return typeof name === "string" ? `:${name}:` : resource;
    case "sticker":
      return typeof name === "string" ? `スタンプ「${name}」` : resource;
    case "ban":
      return named(b) ? `@${named(b)} のBAN` : resource;
    default:
      return resource;
  }
}

interface Group {
  label: string;
  change: string;
  risk: Risk;
  targets: string[];
  states: StepRow["state"][];
  errors: string[];
  stepIds: string[];
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
    const { target, change } = spec.describe(step.pathParams, step.body as Body, beforeOf(plan, resource), (id) => label(plan, id), plan.guildId);
    const risk = stepRisk(step);
    const key = `${spec.op}\u0000${change}\u0000${risk}`;
    let group = byKey.get(key);
    if (!group) {
      group = { label: spec.label, change, risk, targets: [], states: [], errors: [], stepIds: [] };
      byKey.set(key, group);
      out.push(group);
    }
    const state = states.get(step.id);
    group.targets.push(target);
    group.stepIds.push(step.id);
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
  const error = g.errors.length > 0 ? `\n　→ ${truncate(discordErrorText(g.errors[0]!), 200)}` : "";
  return `${mark(g, started, index)} **${g.label}** ${count}${shown}${more} — ${g.change}  \`${RISK_LABEL[g.risk]}\`${error}`;
}

/** One line per kind of change: operation, targets, before → after, risk. */
export function stepLines(plan: Plan, steps?: StepRow[]): string[] {
  const started = !!steps && steps.some((s) => s.state !== "pending");
  return groups(plan, steps).map((g, i) => groupLine(g, started, i));
}

/** How the dialog names each step to people: its line's number and operation ("2. ロール付与"), by step id. */
export function stepNames(plan: Plan): Map<string, string> {
  return new Map(groups(plan).flatMap((g, i) => g.stepIds.map((id) => [id, `${i + 1}. ${g.label}`] as const)));
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
 * The section the dialog shows. "result": the summary every dialog opens on (what
 * changes, what each rule does); "code": the code with its explanation;
 * "details": the exact calls and each rule's allow, params and limits.
 */
export type DialogView = "result" | "code" | "details";

export interface DialogState {
  status: PlanStatus;
  /** Which section is shown; every dialog opens on the summary. */
  view?: DialogView;
  steps?: StepRow[];
  reason?: string | null;
  /** Show the buttons for the current status (false once someone chose to leave it). */
  actions?: boolean;
  /** Shown in place of the status line while a press is being worked on ("修正中…"); the buttons are hidden meanwhile. */
  busy?: string;
  /** /settings's id, so the line after registering rules links to it. */
  settingsCommandId?: string;
}

function statusLine(plan: Plan, state: DialogState): string {
  if (state.busy) return state.busy;
  const done = state.steps?.filter((s) => s.state === "done").length ?? 0;
  switch (state.status) {
    case "pending_approval":
      return `${needsTypedConfirm(plan) ? "⚠️ 戻せない操作を含みます\n" : ""}-# 期限 ${discordTime(plan.expiresAt)} · \`${plan.id}\``;
    case "approved":
    case "executing":
      return plan.steps.length > 1 ? `実行中… ${done}/${plan.steps.length}` : "実行中…";
    case "succeeded": {
      if (!plan.rules?.length) return "✅ 実行しました";
      const registered = `ルール${plan.rules.length}件を登録しました。止めるときは ${settingsCommand(state.settingsCommandId)} の「ルール」から。`;
      return plan.steps.length > 0 ? `✅ 実行しました。${registered}` : `✅ ${registered}`;
    }
    case "failed":
      return `⚠️ 途中で失敗しました(${done}/${plan.steps.length}件完了)。${state.reason ?? ""}`;
    case "cancelled":
      return state.reason ?? "取り消しました";
    case "aborted":
      return `⚠️ 中止しました。${sentence(state.reason ?? "前提が変わりました")}`;
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

function buttons(plan: Plan, state: DialogState): APIButtonComponent[] {
  const out: APIButtonComponent[] = [];
  if (state.actions === false || state.busy) return out;
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

/** The sections this plan has: code only when it was made from code or registers rules, details only when there is more to show. */
function views(plan: Plan): DialogView[] {
  const out: DialogView[] = ["result"];
  if (plan.source || plan.rules?.length) out.push("code");
  if (plan.rules?.length || (plan.source && plan.steps.length > 0)) out.push("details");
  return out;
}

function viewOf(plan: Plan, state: DialogState): DialogView {
  const view = state.view ?? "result";
  return views(plan).includes(view) ? view : "result";
}

/** The menu's choice that sends the plan as JSON, with its code, to whoever picked it. */
export const FILES_CHOICE = "files";

/** One menu switches the section and hands out files, so the only buttons left are the ones that act on the plan. */
function viewMenu(plan: Plan, current: DialogView): APIActionRowComponent<APIStringSelectComponent> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: customId("view", plan),
        options: [
          ...views(plan).map((v) => ({ label: VIEW_LABEL[v], value: v, default: v === current })),
          { label: "ファイルで受け取る", value: FILES_CHOICE },
        ],
      },
    ],
  };
}

/**
 * Only the code: whoever opens this section came to read it, and the summary
 * already explains it. A new version of a rule shows its diff.
 */
function codeBody(plan: Plan, room: number): string[] {
  const parts: Array<{ title: string; code: string; lang: string }> = [
    ...(plan.source ? [{ title: "変更を作るコード", code: plan.source.code, lang: "js" }] : []),
    ...(plan.rules ?? []).map((r) => {
      if (diffable(r)) return { title: `ルール「${r.name}」(v${r.replaces!.version} からの差分)`, code: lineDiff(r.replaces!.before!.code!, programCode(r)), lang: "diff" };
      if (r.program.kind === "wasm" && !r.program.module.source) {
        const m = r.program.module;
        return { title: `ルール「${r.name}」が動かすWasm`, code: `sha256 ${m.sha256}${m.producers.length ? `\nビルド: ${m.producers.join("、")}` : ""}`, lang: "" };
      }
      return { title: `ルール「${r.name}」`, code: programCode(r), lang: r.program.kind === "wasm" ? fenceLanguage(r.program.module.source!.language) : "js" };
    }),
  ];
  const share = Math.floor(room / Math.max(1, parts.length));
  return parts.flatMap(({ title, code, lang }) => {
    if (lang === "diff" && !code) return [`**${title}**\nコードは変わりません。`];
    const limit = Math.max(200, Math.min(MAX_CODE, share - title.length - 100));
    const cut = code.lastIndexOf("\n", limit);
    const shown = code.length > limit ? `${code.slice(0, cut > 0 ? cut : limit)}\n${lang === "diff" ? "…" : "// …"}(続きは「ファイルで受け取る」)` : code;
    return [`**${title}**`, fence(lang, shown)];
  });
}

function programCode(r: PlanRuleDraft): string {
  return r.program.kind === "js" ? r.program.code : r.program.module.source ? r.program.module.source.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n") : "";
}

function diffable(r: PlanRuleDraft): boolean {
  return r.replaces?.before?.code !== undefined && (r.program.kind === "js" || !!r.program.module.source);
}

/** The code in full, as files: the plan's code, each rule's code, and for a new version its diff and the old code. */
export function codeFiles(plan: Plan): Array<{ name: string; data: Buffer }> {
  const file = (name: string, text: string) => ({ name, data: Buffer.from(text) });
  const ext = (r: PlanRuleDraft) => (r.program.kind === "js" ? "js" : "txt");
  return [
    ...(plan.source ? [file("plan.js", plan.source.code)] : []),
    ...(plan.rules ?? []).flatMap((r) => {
      const code = programCode(r);
      if (!code) return [];
      const base = `rule-${r.key}`;
      if (!diffable(r)) return [file(`${base}.${ext(r)}`, code)];
      const diff = lineDiff(r.replaces!.before!.code!, code, 3);
      return [...(diff ? [file(`${base}.diff`, diff)] : []), file(`${base}-v${r.replaces!.version}.${ext(r)}`, r.replaces!.before!.code!), file(`${base}.${ext(r)}`, code)];
    }),
  ].slice(0, 9); // a message carries ten files at most, one of them the JSON
}

/** The code block language for a compiler language id. */
function replyLine(r: PlanRuleDraft): string {
  const images = r.dry.images ? `(画像${r.dry.images}枚)` : "";
  const response = r.dry.response ? `\n　応答: ${truncate(r.dry.response, 200)}` : "";
  return `${r.dry.reply || images ? `\n　返事: ${truncate(r.dry.reply ?? "", 200)}${images}` : ""}${response}`;
}

function dryLine(r: PlanRuleDraft): string {
  const head = r.dry.source ? `ドライラン(${r.dry.source}で)` : "ドライラン";
  switch (r.dry.outcome) {
    case "steps": {
      const n = r.dry.lines.length;
      const lines = [...r.dry.lines.slice(0, 3), ...(n > 3 ? [`…ほか${n - 3}種類`] : [])];
      return `${head}: ${n}種類の操作をします\n${lines.map((l) => `　${l}`).join("\n")}${replyLine(r)}`;
    }
    case "none":
      return `${head}: 何も変更しません${replyLine(r)}`;
    case "pending":
      return "ドライラン: この変更で作るものを使うため、登録後に動きます(コードがエラーにならないことは確かめました)";
    case "no_event":
      return "ドライラン: 試せるイベントがありませんでした";
    case "error":
      return `ドライラン: エラー ${r.dry.problems[0] ?? ""}`;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * For a new version of a rule: how it differs from the one it replaces, one
 * bullet per change. The code's changes come from a model that read only the
 * two versions' code; without them, what each version does is shown instead.
 */
function changeLines(r: PlanRuleDraft): string[] {
  const before = r.replaces?.before;
  if (!before) return ["前の版の内容はこの場所では表示できません", r.summary ?? "説明を作れませんでした。「コード」で確かめてください。"];
  const settings = [
    !same(before.trigger, r.trigger) ? `きっかけ: ${triggerLabel(before.trigger)} → ${triggerLabel(r.trigger)}` : null,
    !same(before.allow, r.allow) ? "ルールにできる変更の範囲が変わります(「詳細」で確かめられます)" : null,
    !same(before.params ?? null, r.params ?? null) ? "ルールが使う値(チャンネルなど)が変わります" : null,
    before.limits && !same(before.limits, r.limits ?? DEFAULT_LIMITS) ? `上限: ${limitsLabel(r.limits ?? DEFAULT_LIMITS)}` : null,
  ].filter((c): c is string => c !== null);
  const changes = r.replaces!.changes;
  const code = changes === undefined
    ? [`変更前: ${before.summary ?? "説明はありません"}`, `変更後: ${r.summary ?? "説明はありません"}`]
    : changes.length === 0 ? (settings.length === 0 ? ["- 変わるところはありません"] : []) : changes.map((c) => `- ${c}`);
  return [...code, ...settings.map((c) => `- ${c}`)];
}

/** A rule the plan registers, in short: when it runs, what it does or what changes, and how its dry run went. */
function ruleSummary(r: PlanRuleDraft): string {
  const triggerChanged = r.replaces?.before && !same(r.replaces.before.trigger, r.trigger);
  return [
    `**${r.name}**${r.replaces ? `(v${r.replaces.version} からの変更${r.replaces.name !== r.name ? `、元の名前「${r.replaces.name}」` : ""})` : ""} · 危険度: ${RISK_LABEL[allowRisk(r.allow)]}`,
    ...(triggerChanged ? [] : [`きっかけ: ${triggerLabel(r.trigger)}`]),
    ...(r.replaces ? changeLines(r) : [r.summary ?? "説明を作れませんでした。「コード」で確かめてください。"]),
    dryLine(r),
  ].join("\n");
}

/** A rule's full definition, drawn only from it. */
function ruleDetail(plan: Plan, r: PlanRuleDraft): string {
  const lookup = (id: string) => label(plan, id);
  return [
    `**${r.name}**`,
    ...(r.limits ? [limitsLabel(r.limits)] : []),
    `許す操作(これ以外の変更は実行されません):\n${allowLines(r.allow, lookup).join("\n") || "なし(返事だけします)"}`,
    ...(r.params ? [`使う値:\n${paramsText(r.params, lookup)}`] : []),
    ...(r.trigger.command ? ["返事を見せる相手:"] : []),
  ].join("\n");
}

function resultBody(plan: Plan, state: DialogState): string[] {
  const lines = stepLines(plan, state.status === "pending_approval" ? undefined : state.steps);
  const listed = lines.slice(0, MAX_LISTED);
  if (lines.length > MAX_LISTED) listed.push(`…ほか${lines.length - MAX_LISTED}種類(続きは「ファイルで受け取る」)`);
  const explained = plan.source ? [`**コードの説明**\n${plan.source.summary ?? "説明を作れませんでした。「コード」で確かめてください。"}`] : [];
  // Whose permissions each rule runs with is said once, on its trigger's line.
  const rules = plan.rules?.length ? ["**登録するルール**(確認なしに動きます)"] : [];
  return [...explained, ...listed, ...rules];
}

function detailsBody(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.source && plan.steps.length > 0) {
    // The exact calls the code produced, when they fit.
    const json = JSON.stringify(plan.steps.map(draftOf));
    out.push(`**コードが作った変更**\n${fence("json", json.length <= MAX_STEPS_JSON ? json : `${json.slice(0, MAX_STEPS_JSON)}\n…(続きは「ファイルで受け取る」)`)}`);
  }
  return out;
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

function header(plan: Plan): string {
  const counts = [...(plan.steps.length > 0 || !plan.rules?.length ? [`${plan.steps.length}件`] : []), ...(plan.rules?.length ? [`ルール${plan.rules.length}件`] : [])].join(" · ");
  return `### 変更の確認\n依頼: ${label(plan, plan.actor.userId)} · 危険度: ${RISK_LABEL[plan.risk]} · ${counts}`;
}

/**
 * Laid out from the parts to the whole: the shown section (on the summary, each
 * rule with the pick that belongs to it), the menu that switches sections, and
 * last, under a divider, the dialog's own status and the buttons that act on it.
 */
export function renderDialog(plan: Plan, state: DialogState): Rendered {
  let room = MAX_TEXT;
  const text = (content: string): APITextDisplayComponent => {
    // Whatever is cut ends with "…", which takes one of the characters left.
    const shown = content.length <= room ? content : room > 1 ? truncate(content, room - 1) : "";
    room -= shown.length;
    return textDisplay(shown || "…");
  };
  const row = (components: APIButtonComponent[]): APIActionRowComponent<APIButtonComponent>[] => (components.length > 0 ? [actionRow(components)] : []);
  const status = statusLine(plan, state);
  room -= status.length;
  const view = viewOf(plan, state);
  const section = view === "result"
    ? [
        text([header(plan), ...resultBody(plan, state)].join("\n")),
        ...gallery(plan),
        ...(plan.rules ?? []).map((r) => text(ruleSummary(r))),
      ]
    : view === "code"
      ? [text([header(plan), ...codeBody(plan, room - header(plan).length)].join("\n"))]
      : [
          text([header(plan), ...detailsBody(plan)].join("\n")),
          // Who sees a command's replies starts on the judge model's pick (the summary says which); it is changed here.
          ...(plan.rules ?? []).flatMap((r) => [text(ruleDetail(plan, r)), ...visibilityRow(plan, state, r)]),
        ];
  // Not ephemeral: the dialog stays in the channel.
  return v2Message(
    [...section, viewMenu(plan, view), { type: ComponentType.Separator }, textDisplay(status), ...row(buttons(plan, state))],
    { ephemeral: false, accent: color(plan, state.status) },
  );
}

/** The dialog's text, for tests and logs. */
export function dialogText(rendered: { components: APIMessageTopLevelComponent[] }): string {
  const container = rendered.components[0] as { components: Array<{ type: number; content?: string }> };
  return container.components.filter((c) => c.type === ComponentType.TextDisplay).map((c) => c.content ?? "").join("\n");
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
