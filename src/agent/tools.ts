import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType, ComponentType } from "discord-api-types/v10";
import type { Reader } from "../discord/reader.ts";
import { downloadImages, imageRefs, MAX_IMAGES } from "./images.ts";
import { CodeFailed, syntaxError } from "./coder.ts";
import type { CodeEnv, Coder, CodeKind } from "./coder.ts";
import { AGENT_SANDBOX_LIMITS, RULE_SANDBOX_LIMITS, runSandboxed } from "../sandbox.ts";
import type { SandboxBindings } from "../sandbox.ts";
import { catalogSummary } from "../plan/catalog.ts";
import { RISK_LABEL, StepDraftSchema } from "../plan/types.ts";
import type { Plan, StepDraft } from "../plan/types.ts";
import { PlanRejected } from "../plan/validate.ts";
import { MAX_ALLOW_ENTRIES } from "../rules/allow.ts";
import { MAX_RULES_PER_PLAN } from "../rules/service.ts";
import { triggerSummary } from "../rules/triggers.ts";
import type { Rule, RuleProposal, RuleRun } from "../rules/types.ts";

// Phase 1 tools are read-only. Every one of them goes through Reader, which
// narrows results to what may be shown in the channel the reply goes to.

const MAX_TOOL_OUTPUT = 20_000;

function text(value: string) {
  const body = value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n…(長いため省略)` : value;
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

/** Text of Components V2 messages (the bot's own dialogs), which have no content. */
function componentText(components: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const c of components ?? []) {
    const comp = c as { type?: number; content?: string; components?: unknown[] };
    if (comp.type === ComponentType.TextDisplay && comp.content) out.push(comp.content);
    if (comp.components) out.push(...componentText(comp.components));
  }
  return out;
}

export function formatMessage(m: Omit<APIMessage, "reactions">): string {
  const name = m.author.global_name ?? m.author.username;
  const parts = [`[${m.id}] ${m.timestamp.slice(0, 16).replace("T", " ")} ${name}(${m.author.id})${m.author.bot ? "[bot]" : ""}`];
  if (m.message_reference?.message_id) parts.push(`返信先:${m.message_reference.message_id}`);
  const content = [m.content, ...componentText(m.components)].filter(Boolean).join("\n");
  let line = `${parts.join(" ")}: ${content}`;
  if (m.attachments.length > 0) {
    line += ` [添付: ${m.attachments.map((a) => `${a.filename}${a.content_type?.startsWith("image/") ? "(画像)" : ""}`).join(", ")}]`;
  }
  if (m.embeds.length > 0) line += ` [埋め込み${m.embeds.length}件${m.embeds.some((e) => e.image || e.thumbnail) ? "・画像あり" : ""}]`;
  return line;
}

function channelLabel(c: APIChannel): string {
  const kind = ChannelType[c.type] ?? String(c.type);
  const name = "name" in c ? c.name : "";
  const parent = "parent_id" in c && c.parent_id ? ` 親:${c.parent_id}` : "";
  return `${c.id} #${name} (${kind})${parent}`;
}

// Keeps each tool's params typed from its own schema while the list stays heterogeneous.
function tool<T extends TSchema>(definition: AgentTool<T>): AgentTool<any> {
  return definition;
}

/** The agent's code runs as the speaker, reading through the same reader as the tools. */
function bindingsOf(reader: Reader): SandboxBindings {
  return {
    guildId: reader.guild.id,
    actor: { kind: "user", userId: reader.scope.speakerId },
    get: (route, query) => reader.get(route, query as Record<string, string>),
  };
}

export interface ToolOptions {
  /** The model accepts images, so view_images is offered. */
  images: boolean;
  fetch?: typeof fetch;
  /** Posts an approval dialog for the steps (and rules). Present when writes are allowed. */
  propose?: Propose;
  /** Event rules: whether propose_plan may carry them, and reading the speaker's own. */
  rules?: RuleTools;
  /** The speaker's coding model. When set, the agent describes code and this writes it. */
  coder?: Coder;
}

export type Propose = (drafts: StepDraft[], code?: string, rules?: RuleProposal[]) => Promise<Plan>;

export interface RuleTools {
  /** The speaker's rules in this server; `shown` is false when its contents may not appear in this channel. */
  list: () => Array<{ rule: Rule; shown: boolean }>;
  /** Recent runs of one of the speaker's rules; null when it is not theirs or not shown here. */
  runs: (ruleId: string, limit: number) => RuleRun[] | null;
}

export function readTools(reader: Reader, options: ToolOptions = { images: false }): AgentTool<any>[] {
  const readMessages = tool({
    name: "read_messages",
    label: "履歴を読む",
    description:
      "チャンネルのメッセージ履歴を新しい順に最大100件取得します。before/after/aroundにメッセージIDを指定するとその前後を読めます。さらに遡るときは、返ってきた最も古いIDをbeforeに渡して繰り返します。",
    parameters: Type.Object({
      channel_id: Type.Optional(Type.String({ description: "省略時は今のチャンネル" })),
      before: Type.Optional(Type.String()),
      after: Type.Optional(Type.String()),
      around: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: async (_id, params) => {
      const channelId = params.channel_id ?? reader.scope.channelId;
      const query: Record<string, string | number> = { limit: params.limit ?? 50 };
      for (const key of ["before", "after", "around"] as const) if (params[key]) query[key] = params[key];
      const messages = await reader.messages(channelId, query);
      if (messages.length === 0) return text("メッセージはありません");
      return text(messages.map(formatMessage).reverse().join("\n"));
    },
  });

  const searchMessages = tool({
    name: "search_messages",
    label: "メッセージ検索",
    description:
      "サーバー内のメッセージを検索します。本文・投稿者・チャンネル・メンション・添付の有無で絞り込めます。検索対象は今のチャンネルで扱えるチャンネルに自動で限定されます。",
    parameters: Type.Object({
      content: Type.Optional(Type.String({ description: "本文に含む語" })),
      author_id: Type.Optional(Type.Array(Type.String())),
      channel_id: Type.Optional(Type.Array(Type.String())),
      mentions: Type.Optional(Type.Array(Type.String())),
      has: Type.Optional(Type.Array(Type.String({ description: "link, embed, file, image, video, sound, sticker, poll など。先頭に-で否定" }))),
      sort_by: Type.Optional(Type.Union([Type.Literal("timestamp"), Type.Literal("relevance")])),
      sort_order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 9975 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    }),
    execute: async (_id, params) => {
      const res = await reader.searchMessages(reader.guild.id, { ...params });
      if (!("messages" in res)) {
        return text(`サーバーの検索索引がまだできていません。${res.retry_after}秒ほど後にもう一度試してください。`);
      }
      const lines = res.messages.map((group) => group.map((m) => `#${m.channel_id} ${formatMessage(m)}`).join("\n"));
      return text(`該当 ${res.total_results}件(表示 ${lines.length}件)\n${lines.join("\n")}`);
    },
  });

  const listChannels = tool({
    name: "list_channels",
    label: "チャンネル一覧",
    description: "今のチャンネルで内容を扱えるチャンネルの一覧(ID・名前・種類・親カテゴリ)を返します。",
    parameters: Type.Object({}),
    execute: async () => {
      const channels = await reader.listChannels(reader.guild.id);
      return text(channels.map(channelLabel).join("\n") || "ありません");
    },
  });

  const findMembers = tool({
    name: "find_members",
    label: "メンバー検索",
    description: "ユーザー名またはニックネームの前方一致でメンバーを探し、ID・名前・ロールIDを返します。",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: async (_id, params) => {
      const members = (await reader.get(`/guilds/${reader.guild.id}/members/search`, {
        query: params.query,
        limit: params.limit ?? 20,
      })) as Array<{ nick?: string | null; roles: string[]; user: { id: string; username: string; global_name?: string | null; bot?: boolean } }>;
      const lines = members.map(
        (m) => `${m.user.id} ${m.user.global_name ?? m.user.username}(@${m.user.username})${m.nick ? ` ニックネーム:${m.nick}` : ""}${m.user.bot ? " [bot]" : ""} ロール:${m.roles.join(",") || "なし"}`,
      );
      return text(lines.join("\n") || "見つかりません");
    },
  });

  const sandboxBindings = bindingsOf(reader);

  const runCode = tool({
    name: "run_code",
    label: "コードで調べる",
    description: [
      "読み取り専用のJavaScriptを実行し、returnした値をJSONで返します。複数のAPIを組み合わせる集計に使います。",
      "使えるもの: guild(サーバーID), actor, discord.get(route, { query }) (同期関数。例: discord.get(`/guilds/${guild}/roles`)), log(...)。",
      "読めるのは許可された経路だけで、結果は今のチャンネルで扱える範囲に絞られます。ネットワーク・タイマー・ファイルはありません。",
    ].join("\n"),
    parameters: Type.Object({ code: Type.String({ description: "関数本体。最後に return で結果を返す" }) }),
    execute: async (_id, params) => {
      const result = await runSandboxed(params.code, sandboxBindings, AGENT_SANDBOX_LIMITS);
      const logs = result.logs.length > 0 ? `\nlog:\n${result.logs.join("\n")}` : "";
      if (!result.ok) throw new Error(`${result.error}${logs}`);
      return text(`${JSON.stringify(result.value, null, 1)}${logs}`);
    },
  });

  const coder = options.coder;
  // The coding agent reads the speaker's rules and runs too, so it can debug them.
  const coderTools = options.rules ? ruleReadTools(options.rules) : [];
  const runCodeTask = tool({
    name: "run_code",
    label: "コードで調べる",
    description: [
      "読み取り専用のJavaScriptで調べ、結果をJSONで返します。複数のAPIを組み合わせる集計に使います。",
      "コードはコード用のモデルが書きます。task には、何を調べて何を返すコードかを具体的に書きます。コード用のモデルは会話を見ていないので、使うID・名前・条件・返してほしい形を task に全部書いてください。",
      "コードは Discord REST API の GET を読めます(結果は今のチャンネルで扱える範囲に絞られます)。返ってきたコードと結果を確かめて使ってください。",
    ].join("\n"),
    parameters: Type.Object({ task: Type.String({ description: "何を調べて何を返すコードか" }) }),
    execute: async (_id, params) => {
      let result: Awaited<ReturnType<typeof runSandboxed>> | undefined;
      const { code } = await writeCode(coder!, "read", params.task, {
        check: async (code) => {
          result = await runSandboxed(code, sandboxBindings, AGENT_SANDBOX_LIMITS);
          return result.ok ? null : `${result.error}${result.logs.length > 0 ? `\nlog:\n${result.logs.join("\n")}` : ""}`;
        },
        run: (code) => runSandboxed(code, sandboxBindings, AGENT_SANDBOX_LIMITS),
        tools: coderTools,
      });
      const logs = result!.logs.length > 0 ? `\nlog:\n${result!.logs.join("\n")}` : "";
      return text(`コード:\n${code}\n\n結果:\n${JSON.stringify(result!.value, null, 1)}${logs}`);
    },
  });

  const viewImages = tool({
    name: "view_images",
    label: "画像を見る",
    description: `メッセージに添付された画像と埋め込みの画像を見ます(最大${MAX_IMAGES}枚)。履歴で「(画像)」や「画像あり」と出ているメッセージに使います。`,
    parameters: Type.Object({
      message_id: Type.String(),
      channel_id: Type.Optional(Type.String({ description: "省略時は今のチャンネル" })),
    }),
    execute: async (_id, params) => {
      const channelId = params.channel_id ?? reader.scope.channelId;
      // Goes through the reader, so only messages that may be shown here are opened.
      const message = (await reader.get(`/channels/${channelId}/messages/${params.message_id}`)) as APIMessage;
      const images = await downloadImages(imageRefs(message), options.fetch);
      if (images.length === 0) return text("このメッセージには見られる画像がありません");
      return { content: [{ type: "text" as const, text: `メッセージ ${message.id} の画像 ${images.length}枚` }, ...images], details: {} };
    },
  });

  const tools = [readMessages, searchMessages, listChannels, findMembers, coder ? runCodeTask : runCode];
  if (options.images) tools.push(viewImages);
  if (options.propose) tools.push(proposePlan(reader, options.propose, !!options.rules, coder, coderTools));
  if (options.rules) tools.push(...ruleReadTools(options.rules));
  return tools;
}

const AllowSchema = Type.Object({
  op: Type.String(),
  path: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), { description: "パスパラメータ名 → JSON Schema。例: { channel: { enum: [\"123\"] } }" })),
  body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "本文の JSON Schema" })),
  target: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "対象(チャンネル・ロール・メンバーなど)の実行直前の状態が満たすべき JSON Schema" })),
  max_steps_per_run: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const RULE_FIELDS = {
  name: Type.String({ minLength: 1, maxLength: 60, description: "ルールの短い名前" }),
  trigger_event: Type.String(),
  include_bot_origin: Type.Optional(Type.Boolean()),
  allow: Type.Array(AllowSchema, { minItems: 1, maxItems: MAX_ALLOW_ENTRIES }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sample_event: Type.Optional(Type.Unknown()),
  replaces_rule: Type.Optional(Type.String()),
};
const RuleSchema = Type.Object({ ...RULE_FIELDS, code: Type.String({ maxLength: 8000 }) });
type RuleInput = Static<typeof RuleSchema>;
/** With a coding model, the agent describes each rule's code and the coder writes it. */
const CodedRuleSchema = Type.Object({
  ...RULE_FIELDS,
  code_task: Type.String({ maxLength: 4000, description: "イベントごとに何を確かめて何をするコードか" }),
});
type CodedRuleInput = Static<typeof CodedRuleSchema>;

const CODER_LIMIT_NOTE = "コード用のモデルは会話を見ていないので、使うID・名前・条件・作るものの内容を全部書いてください。";

/** Has the coder write code, turning its failure into an error the agent can act on. */
async function writeCode(coder: Coder, kind: CodeKind, task: string, env: CodeEnv) {
  try {
    return await coder.write(kind, task, env);
  } catch (e) {
    if (e instanceof CodeFailed) {
      throw new Error(`${e.message}${e.code ? `\n最後に書いたコード:\n${e.code}` : ""}\n依頼の書き方(task)を具体的にして、もう一度試してください。`);
    }
    throw e;
  }
}

/** The rule's own settings go with its task, so the coder knows what it may do. */
function ruleTask(r: CodedRuleInput): string {
  return [
    r.code_task,
    "",
    `きっかけ: ${r.trigger_event}`,
    `params: ${JSON.stringify(r.params ?? null)}`,
    `許す操作: ${JSON.stringify(r.allow)}`,
    ...(r.replaces_rule ? [`直すルール: ${r.replaces_rule}(list_rules・rule_runs で今のコードと実行履歴を見られます)`] : []),
    ...(r.sample_event !== undefined ? [`イベントの例: ${JSON.stringify(r.sample_event).slice(0, 2000)}`] : []),
  ].join("\n");
}

/** One coding agent per rule, all at once. */
async function codeRules(coder: Coder, rules: CodedRuleInput[], bindings: SandboxBindings, tools: AgentTool<any>[]): Promise<RuleInput[]> {
  return Promise.all(
    rules.map(async (r, i) => {
      const { code_task: _task, ...rest } = r;
      try {
        const { code } = await writeCode(coder, "rule", ruleTask(r), {
          // Rule code only runs on events, so a submission is parsed rather than run.
          check: (code) => syntaxError(code),
          run: (code, event) => runSandboxed(code, { ...bindings, event: event ?? null, params: r.params ?? null }, RULE_SANDBOX_LIMITS),
          tools,
        });
        return { ...rest, code };
      } catch (e) {
        throw new Error(`rules[${i}](${r.name}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
}

function toProposal(r: RuleInput): RuleProposal {
  return {
    name: r.name.slice(0, 60),
    trigger: { event: r.trigger_event, ...(r.include_bot_origin ? { includeBotOrigin: true } : {}) },
    allow: r.allow.map((a) => ({
      op: a.op,
      ...(a.path ? { path: a.path } : {}),
      ...(a.body ? { body: a.body } : {}),
      ...(a.target ? { target: a.target } : {}),
      ...(a.max_steps_per_run ? { maxStepsPerRun: a.max_steps_per_run } : {}),
    })),
    code: r.code,
    ...(r.params ? { params: r.params } : {}),
    ...(r.sample_event !== undefined ? { sampleEvent: r.sample_event } : {}),
    ...(r.replaces_rule ? { replaces: r.replaces_rule } : {}),
  };
}

/** Rules returned from plan code, checked like the tool's own parameter. */
function rulesFromCode(value: unknown): RuleProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("plan(steps, rules) の rules は配列にしてください");
  return value.map((r, i) => {
    if (!Value.Check(RuleSchema, r)) {
      const problems = [...Value.Errors(RuleSchema, r)].slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`);
      throw new Error(`rules[${i}] の形が違います: ${problems.join("; ")}`);
    }
    return toProposal(r);
  });
}

const RULES_DESCRIPTION = [
  "rules: イベントルール。サーバーで決まったイベントが起きるたびに、依頼者の権限で人の確認なしに変更を実行します。steps と同じ承認ダイアログで確認され、「実行」でステップが済んだあとに登録されます。ルールだけのときは steps を空にします。",
  "  各要素 { name, trigger_event, include_bot_origin?, allow, code, params?, sample_event?, replaces_rule? }。code モードでは rule({ 同じ項目 }) を作って plan(steps, [rule(...), ...]) で返します。",
  "  trigger_event: きっかけ(下の一覧から1つ)。Bot自身が起こしたイベントでは既定で動きません。include_bot_origin は何度動いても結果が同じになるルールにだけ付けます。",
  "  code: イベントごとに読み取り専用のサンドボックスで動く関数本体(文字列)。変更がなければ return null、あれば return plan([call(op, { id?, path, body }), ...])。前のステップの結果は $ref で参照できます。",
  "    使えるもの: event(発火したイベント), params, guild, actor, discord.get(route, { query })(同期関数), call, plan, log。実行は1回10秒・discord.get 50回まで。ネットワーク・タイマー・乱数はありません。",
  "  params: code が params として読む値。この変更のステップで作るもののIDは { \"$ref\": \"steps.<id>.result.id\" } で渡せます(登録時に実際のIDになります)。",
  "  allow: ルールに許す操作。各要素 { op, path?, body?, target?, max_steps_per_run? }。path はパスパラメータごとの、body は本文の、target は対象の実行直前の状態(例: チャンネルの name や type)の JSON Schema です。コードが出したステップはどれか1つに合わないと実行されません。",
  "    できるだけ狭くします: チャンネルやロールが決まっていれば { enum: [ID] } で固定し(この変更で作るものなら { enum: [{ \"$ref\": \"steps.s1.result.id\" }] })、body は使うフィールドだけを properties に書いて additionalProperties: false、max_steps_per_run も付けます。削除や変更の対象を名前などで限るときは target を使います(例: { properties: { name: { pattern: \"^📞\" } }, required: [\"name\"] })。",
  "    ルールのコードが同じ回の前のステップで作ったもの(例: 作った部屋へ移すときの channel_id)は、IDが前もって決まらないので { madeInRun: true } とします。例: { op: \"PATCH /guilds/{guild}/members/{user}\", body: { properties: { channel_id: { madeInRun: true } }, required: [\"channel_id\"], additionalProperties: false } }。そのフィールドは、コードの中で $ref で前のステップを指したときだけ通ります。変更案の steps で作るもの(登録時に決まるID)を指す { \"$ref\": \"steps.s1.result.id\" } とは別物なので混同しないでください。",
  "  sample_event: 実際のイベントで試せないきっかけ(このチャンネルのメッセージやあなたのメンバー情報以外)のとき、ドライラン用のイベントを付けます。",
  "  replaces_rule: 依頼者の既存のルールを直すときにそのID(list_rules で確認)。",
  "  ボイスチャンネルの在室者は discord.get(`/guilds/${guild}/voice-states`) で [{ user_id, channel_id }] として読めます。",
  "  きっかけにできるイベント:",
  triggerSummary(),
].join("\n");

/** Reading the speaker's rules and their runs; the coding agent gets these too, for debugging rules. */
function ruleReadTools(rules: RuleTools): AgentTool<any>[] {
  return [listRules(rules), ruleRuns(rules)];
}

function ruleRuns(rules: RuleTools): AgentTool<any> {
  return tool({
    name: "rule_runs",
    label: "ルールの実行履歴",
    description:
      "話し手のルールの実行履歴を新しい順に返します(時刻・結果・作った変更のID・エラー・log)。結果は no_change(変更なし)、executed(実行した)、rejected(allow や権限で拒否)、failed(コードのエラーなど)、rate_limited(回数制限)のどれかです。履歴が空なら、まだイベントが来ていません。ルールが動かない理由を調べるときに使います。",
    parameters: Type.Object({
      rule_id: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (_id, params) => {
      const runs = rules.runs(params.rule_id, params.limit ?? 10);
      if (runs === null) throw new Error("このルールは話し手のものではないか、このチャンネルでは内容を扱えません");
      if (runs.length === 0) return text("実行履歴はありません(まだイベントが来ていません)");
      return text(
        runs
          .map((r) =>
            JSON.stringify({
              at: r.startedAt,
              version: r.ruleVersion,
              outcome: r.outcome,
              ...(r.planId ? { plan: r.planId } : {}),
              ...(r.error ? { error: r.error } : {}),
              ...(r.logs.length ? { logs: r.logs } : {}),
            }),
          )
          .join("\n"),
      );
    },
  });
}

function listRules(rules: RuleTools): AgentTool<any> {
  return tool({
    name: "list_rules",
    label: "ルールを見る",
    description: "話し手が作ったイベントルールの一覧(ID・名前・状態・きっかけ・許す操作・コード)を返します。ルールを直す依頼のときに使います。",
    parameters: Type.Object({}),
    execute: async () => {
      const items = rules.list();
      if (items.length === 0) return text("ルールはありません");
      return text(
        items
          .map(({ rule, shown }) =>
            shown
              ? JSON.stringify({ id: rule.id, name: rule.name, enabled: rule.enabled, version: rule.version, trigger: rule.trigger, allow: rule.allow, params: rule.params, code: rule.code })
              : `${rule.id} ${rule.name}: このチャンネルでは扱えないチャンネルを使うため、内容は表示できません`,
          )
          .join("\n"),
      );
    },
  });
}

function proposePlan(reader: Reader, propose: Propose, withRules: boolean, coder?: Coder, coderTools: AgentTool<any>[] = []): AgentTool<any> {
  const codeLine = coder
    ? `code_task: 今すぐ行う変更を作るコードの依頼(steps と同時には使えません)。コード用のモデルが読み取り専用のJavaScriptを書いて実行し、変更の一覧を作ります。何を読んで、どんな条件で、どの対象に何をするかを書きます。${CODER_LIMIT_NOTE}`
    : `code: 今すぐ行う変更を作る読み取り専用のJavaScript(steps と同時には使えません)。承認ダイアログにはこのコードと、コードだけを読んだ別のAIによる説明が出るので、読みやすく書きます。run_code と同じ discord.get が使え、call(op, { id?, path, body }) で作ったステップを return plan([...]) で返します。${withRules ? "ルールも作るときは return plan([...], [rule({...}), ...]) です。" : ""}`;
  const rulesDescription = coder
    ? RULES_DESCRIPTION.replace(
        /\n  各要素[^\n]*\n/,
        `\n  各要素 { name, trigger_event, include_bot_origin?, allow, code_task, params?, sample_event?, replaces_rule? }。\n  code_task: イベントごとに動くコードの依頼。コード用のモデルが、ここに書いた内容ときっかけ・params・allow を見てコードを書きます。イベントのどの値を見て、どんなときに何をするか(何もしないのはどんなときか)を書いてください。${CODER_LIMIT_NOTE}\n`,
      ).replace(/\n  code: イベントごとに[^\n]*\n    使えるもの:[^\n]*/, "")
    : RULES_DESCRIPTION;
  const sandboxBindings = bindingsOf(reader);
  return tool({
    name: "propose_plan",
    label: "変更を提案",
    description: [
      "書き込み操作の変更案を出し、チャンネルに承認ダイアログを投稿します。依頼者が「実行」を押したときだけ実行されます。",
      `steps か ${coder ? "code_task" : "code"} のどちらかを渡します。基本は steps です。${coder ? "code_task" : "code"} は対象が多いときや、条件で対象を選ぶとき(「30日発言していない人全員」など)だけ使います。`,
      "steps: [{ id?, op, path, body? }]。op は下の一覧のどれか、path はパスパラメータ(guild は省略可)。前のステップの結果は { \"$ref\": \"steps.<id>.result.id\" } で参照できます。",
      codeLine,
      ...(withRules
        ? [
            "1つの依頼に必要な変更とルールは、まとめて1つの変更案にします(承認は1回で済みます)。例: チャンネルを作るステップと、そのチャンネルを params や allow で $ref 参照するルール。依頼で名前が出たチャンネルなどがまだなければ、作るステップを入れます(list_channels で確かめる)。",
            coder
              ? "ルールのコード(イベントごとに動き event を読む)の依頼は rules[].code_task に書きます。propose_plan の code_task に入れないでください。"
              : "ルールのコード(イベントごとに動き event を読む)は rules[].code に書きます。propose_plan の code に入れないでください。",
            rulesDescription,
          ]
        : []),
      "使える操作(これ以外と、仕様にないフィールドは拒否されます):",
      catalogSummary(),
    ].join("\n"),
    parameters: Type.Object({
      steps: Type.Optional(Type.Array(StepDraftSchema, { maxItems: 100 })),
      ...(coder
        ? { code_task: Type.Optional(Type.String({ maxLength: 4000, description: "今すぐ行う変更を作るコードの依頼" })) }
        : { code: Type.Optional(Type.String({ description: withRules ? "plan([...]) か plan([...], [rule({...})]) を return する関数本体" : "plan([...]) を return する関数本体" })) }),
      rules: Type.Optional(Type.Array(coder ? CodedRuleSchema : RuleSchema, { maxItems: MAX_RULES_PER_PLAN, description: withRules ? "イベントルール" : "ここでは使えません" })),
    }),
    execute: async (_id, input) => {
      const params = input as { steps?: StepDraft[]; code?: string; code_task?: string; rules?: Array<RuleInput | CodedRuleInput> };
      if (params.rules?.length && !withRules) throw new Error("ルールはここでは作れません");
      const codeField = coder ? "code_task" : "code";
      // Both at once used to drop the steps silently, leaving refs to them dangling.
      if ((params.code || params.code_task) && params.steps?.length) {
        throw new Error(`steps と ${codeField} は同時に使えません。今すぐ行う変更はどちらか一方にまとめてください(ルールのコードは rules[].${codeField} に書きます)`);
      }
      const ruleInputs = coder ? await codeRules(coder, (params.rules ?? []) as CodedRuleInput[], sandboxBindings, coderTools) : ((params.rules ?? []) as RuleInput[]);
      let rules: RuleProposal[] = ruleInputs.map(toProposal);

      // Runs plan code; the error comes back as text so the coder can fix it.
      let planned: { drafts: StepDraft[]; rules: RuleProposal[] } | undefined;
      const runPlan = async (code: string): Promise<string | null> => {
        const result = await runSandboxed(code, sandboxBindings, AGENT_SANDBOX_LIMITS);
        if (!result.ok) {
          // A common mix-up: the rule's code (which reads `event`) passed as the plan's code.
          const hint = /\bevent\b/.test(code) ? `\nこのコードは今すぐ行う変更を作るコードで、event はありません(null)。イベントごとに動くコードは rules[].${codeField} に書いてください。` : "";
          return `${result.error}${hint}`;
        }
        const value = result.value as { steps?: unknown; rules?: unknown } | undefined;
        if (!value || !Array.isArray(value.steps)) return "コードは plan([...]) を return してください";
        try {
          const fromCode = rulesFromCode(value.rules);
          if (fromCode.length > 0 && !withRules) return "ルールはここでは作れません";
          planned = { drafts: value.steps as StepDraft[], rules: fromCode };
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };

      let drafts: StepDraft[];
      let code = params.code;
      if (coder && params.code_task) {
        code = (await writeCode(coder, "plan", params.code_task, { check: runPlan, run: (c) => runSandboxed(c, sandboxBindings, AGENT_SANDBOX_LIMITS), tools: coderTools })).code;
      } else if (code) {
        const problem = await runPlan(code);
        if (problem) throw new Error(problem);
      }
      if (planned) {
        drafts = planned.drafts;
        rules = [...rules, ...planned.rules];
      } else if (params.steps) {
        drafts = params.steps;
      } else if (rules.length > 0) {
        drafts = [];
      } else {
        throw new Error(`steps か ${codeField} を渡してください`);
      }
      try {
        const plan = await propose(drafts, code, rules.length > 0 ? rules : undefined);
        const what = [`${plan.steps.length}件`, ...(plan.rules?.length ? [`ルール${plan.rules.length}件`] : [])].join("・");
        return text(
          `承認ダイアログを投稿しました(変更 ${plan.id}、${what}、危険度: ${RISK_LABEL[plan.risk]})。依頼者が「実行」を押すと実行され${plan.rules?.length ? "、ルールが登録され" : ""}、結果はダイアログに表示されます。詳細はダイアログにあるので、返答では何を提案したかを一言添えるだけにしてください。`,
        );
      } catch (e) {
        if (e instanceof PlanRejected) throw new Error(`変更案は拒否されました:\n${e.reasons.join("\n")}`);
        throw e;
      }
    },
  });
}
