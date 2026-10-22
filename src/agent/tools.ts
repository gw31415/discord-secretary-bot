import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType, ComponentType } from "discord-api-types/v10";
import type { Reader } from "../discord/reader.ts";
import { downloadImages, imageRefs, MAX_IMAGES } from "./images.ts";
import { AGENT_SANDBOX_LIMITS, runSandboxed } from "../sandbox.ts";
import { catalogSummary } from "../plan/catalog.ts";
import { RISK_LABEL, StepDraftSchema } from "../plan/types.ts";
import type { Plan, StepDraft } from "../plan/types.ts";
import { PlanRejected } from "../plan/validate.ts";
import { MAX_ALLOW_ENTRIES } from "../rules/allow.ts";
import { RuleRejected } from "../rules/service.ts";
import { TRIGGERS, triggerSummary } from "../rules/triggers.ts";
import type { Rule, RuleDraft } from "../rules/types.ts";

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

export interface ToolOptions {
  /** The model accepts images, so view_images is offered. */
  images: boolean;
  fetch?: typeof fetch;
  /** Posts an approval dialog for the steps. Present when writes are allowed. */
  propose?: (drafts: StepDraft[], code?: string) => Promise<Plan>;
  /** Event rules: proposing one (with a dry run and a confirmation in the channel), and reading the speaker's own. */
  rules?: RuleTools;
}

export interface RuleTools {
  propose: (draft: RuleDraft, replacesRule?: string) => Promise<{ draftId: string; report: string }>;
  /** The speaker's rules in this server; `shown` is false when its contents may not appear in this channel. */
  list: () => Array<{ rule: Rule; shown: boolean }>;
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
      const result = await runSandboxed(
        params.code,
        {
          guildId: reader.guild.id,
          actor: { kind: "user", userId: reader.scope.speakerId },
          get: (route, query) => reader.get(route, query as Record<string, string>),
        },
        AGENT_SANDBOX_LIMITS,
      );
      const logs = result.logs.length > 0 ? `\nlog:\n${result.logs.join("\n")}` : "";
      if (!result.ok) throw new Error(`${result.error}${logs}`);
      return text(`${JSON.stringify(result.value, null, 1)}${logs}`);
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

  const tools = [readMessages, searchMessages, listChannels, findMembers, runCode];
  if (options.images) tools.push(viewImages);
  if (options.propose) tools.push(proposePlan(reader, options.propose));
  if (options.rules) tools.push(...ruleTools(options.rules));
  return tools;
}

const AllowSchema = Type.Object({
  op: Type.String(),
  path: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), { description: "パスパラメータ名 → JSON Schema。例: { channel: { enum: [\"123\"] } }" })),
  body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "本文の JSON Schema" })),
  max_steps_per_run: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

function ruleTools(rules: RuleTools): AgentTool<any>[] {
  const propose = tool({
    name: "propose_rule",
    label: "ルールを提案",
    description: [
      "イベントルールの案を出します。ルールは、サーバーで決まったイベントが起きるたびに、依頼者の権限で人の確認なしに変更を実行します。",
      "案はその場でドライランし、問題があれば理由を返すので直して出し直してください。問題がなければチャンネルに登録の確認を投稿し、依頼者が「登録」を押すと有効になります。",
      "trigger_event: きっかけ(下の一覧から1つ)。Bot自身が起こしたイベントでは既定で動きません。include_bot_origin は何度動いても結果が同じになるルールにだけ付けます。",
      "code: イベントごとに読み取り専用のサンドボックスで動く関数本体。変更がなければ return null か return plan([])、あれば return plan([call(op, { id?, path, body }), ...])。",
      "  使えるもの: event(発火したイベント), guild, actor, discord.get(route, { query })(同期関数), call, plan, log。実行は1回10秒・discord.get 50回まで。ネットワーク・タイマー・乱数はありません。",
      "allow: ルールに許す操作。各要素 { op, path?, body?, max_steps_per_run? }。path はパスパラメータごとの、body は本文の JSON Schema です。コードが出したステップはどれか1つに合わないと実行されません。",
      "  できるだけ狭くします: チャンネルやロールが決まっていれば { enum: [ID] } で固定し、body は使うフィールドだけを properties に書いて additionalProperties: false、max_steps_per_run も付けます。",
      "sample_event: 実際のイベントで試せないきっかけ(このチャンネルのメッセージやあなたのメンバー情報以外)のとき、ドライラン用のイベントを付けます。",
      "replaces_rule: 依頼者の既存のルールを直すときにそのID(list_rules で確認)。",
      "きっかけにできるイベント:",
      triggerSummary(),
      "操作は propose_plan と同じ一覧から選びます。",
    ].join("\n"),
    parameters: Type.Object({
      name: Type.String({ maxLength: 60, description: "ルールの短い名前" }),
      trigger_event: Type.String(),
      include_bot_origin: Type.Optional(Type.Boolean()),
      allow: Type.Array(AllowSchema, { minItems: 1, maxItems: MAX_ALLOW_ENTRIES }),
      code: Type.String({ maxLength: 8000 }),
      sample_event: Type.Optional(Type.Unknown()),
      replaces_rule: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      if (!TRIGGERS[params.trigger_event]) throw new Error(`きっかけ ${params.trigger_event} には対応していません`);
      const draft: RuleDraft = {
        name: params.name.slice(0, 60),
        trigger: { event: params.trigger_event, ...(params.include_bot_origin ? { includeBotOrigin: true } : {}) },
        allow: params.allow.map((a) => ({
          op: a.op,
          ...(a.path ? { path: a.path } : {}),
          ...(a.body ? { body: a.body } : {}),
          ...(a.max_steps_per_run ? { maxStepsPerRun: a.max_steps_per_run } : {}),
        })),
        code: params.code,
        ...(params.sample_event !== undefined ? { sampleEvent: params.sample_event } : {}),
      };
      try {
        const { draftId, report } = await rules.propose(draft, params.replaces_rule);
        return text(`登録の確認を投稿しました(ルール案 ${draftId}、ドライラン: ${report})。依頼者が「登録」を押すと有効になります。返答では何をするルールかを一言添えるだけにしてください。`);
      } catch (e) {
        if (e instanceof RuleRejected) throw new Error(`このままでは出せません:\n${e.reasons.join("\n")}`);
        throw e;
      }
    },
  });

  const list = tool({
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
              ? JSON.stringify({ id: rule.id, name: rule.name, enabled: rule.enabled, version: rule.version, trigger: rule.trigger, allow: rule.allow, code: rule.code })
              : `${rule.id} ${rule.name}: このチャンネルでは扱えないチャンネルを使うため、内容は表示できません`,
          )
          .join("\n"),
      );
    },
  });
  return [propose, list];
}

function proposePlan(reader: Reader, propose: (drafts: StepDraft[], code?: string) => Promise<Plan>): AgentTool<any> {
  return tool({
    name: "propose_plan",
    label: "変更を提案",
    description: [
      "書き込み操作の変更案を出し、チャンネルに承認ダイアログを投稿します。依頼者が「実行」を押したときだけ実行されます。",
      "steps か code のどちらかを渡します。基本は steps です。code は対象が多いときや、条件で対象を選ぶとき(「30日発言していない人全員」など)だけ使います。",
      "steps: [{ id?, op, path, body? }]。op は下の一覧のどれか、path はパスパラメータ(guild は省略可)。前のステップの結果は { \"$ref\": \"steps.<id>.result.id\" } で参照できます。",
      "code: 読み取り専用のJavaScript。承認ダイアログにはこのコードと、コードだけを読んだ別のAIによる説明が出るので、読みやすく書きます。run_code と同じ discord.get が使え、call(op, { id?, path, body }) で作ったステップを return plan([...]) で返します。",
      "使える操作(これ以外と、仕様にないフィールドは拒否されます):",
      catalogSummary(),
    ].join("\n"),
    parameters: Type.Object({
      steps: Type.Optional(Type.Array(StepDraftSchema, { maxItems: 100 })),
      code: Type.Optional(Type.String({ description: "plan([...]) を return する関数本体" })),
    }),
    execute: async (_id, params) => {
      let drafts: StepDraft[];
      if (params.code) {
        const result = await runSandboxed(
          params.code,
          {
            guildId: reader.guild.id,
            actor: { kind: "user", userId: reader.scope.speakerId },
            get: (route, query) => reader.get(route, query as Record<string, string>),
          },
          AGENT_SANDBOX_LIMITS,
        );
        if (!result.ok) throw new Error(result.error);
        const value = result.value as { steps?: unknown } | undefined;
        if (!value || !Array.isArray(value.steps)) throw new Error("code は plan([...]) を return してください");
        drafts = value.steps as StepDraft[];
      } else if (params.steps) {
        drafts = params.steps;
      } else {
        throw new Error("steps か code を渡してください");
      }
      try {
        const plan = await propose(drafts, params.code);
        return text(
          `承認ダイアログを投稿しました(変更 ${plan.id}、${plan.steps.length}件、危険度: ${RISK_LABEL[plan.risk]})。依頼者が「実行」を押すと実行され、結果はダイアログに表示されます。詳細はダイアログにあるので、返答では何を提案したかを一言添えるだけにしてください。`,
        );
      } catch (e) {
        if (e instanceof PlanRejected) throw new Error(`変更案は拒否されました:\n${e.reasons.join("\n")}`);
        throw e;
      }
    },
  });
}
