import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import type { Reader } from "../discord/reader.ts";
import { downloadImages, imageRefs, MAX_IMAGES } from "./images.ts";
import { AGENT_SANDBOX_LIMITS, runSandboxed } from "../sandbox.ts";

// Phase 1 tools are read-only. Every one of them goes through Reader, which
// narrows results to what may be shown in the channel the reply goes to.

const MAX_TOOL_OUTPUT = 20_000;

function text(value: string) {
  const body = value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n…(長いため省略)` : value;
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

export function formatMessage(m: Omit<APIMessage, "reactions">): string {
  const name = m.author.global_name ?? m.author.username;
  const parts = [`[${m.id}] ${m.timestamp.slice(0, 16).replace("T", " ")} ${name}(${m.author.id})${m.author.bot ? "[bot]" : ""}`];
  if (m.message_reference?.message_id) parts.push(`返信先:${m.message_reference.message_id}`);
  let line = `${parts.join(" ")}: ${m.content}`;
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
  return options.images ? [...tools, viewImages] : tools;
}
