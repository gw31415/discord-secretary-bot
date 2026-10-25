import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType, ComponentType } from "discord-api-types/v10";
import type { Reader } from "../discord/reader.ts";
import { downloadImages, fetchImage, imageRefs, MAX_IMAGES } from "./images.ts";
import { CodeFailed, syntaxError } from "./coder.ts";
import type { CodeEnv, Coder, CodeKind } from "./coder.ts";
import { mimeOf } from "./attachments.ts";
import type { ImageBox } from "./attachments.ts";
import { ConvertOptionsSchema, convertImage, forModel, MathOptionsSchema, parseOptions, renderMath } from "../media.ts";
import type { ConvertOptions, MathOptions } from "../media.ts";
import { checkDecideInput, JUDGE_CODE_LINE, MAX_QUESTIONS, MAX_STATE_JSON as MAX_JUDGE_STATE_JSON } from "./decide.ts";
import type { Decide } from "./decide.ts";
import { runRuleCode, runSandboxed, SANDBOX_LIMITS } from "../sandbox.ts";
import type { SandboxBindings } from "../sandbox.ts";
import { catalogSummary } from "../plan/catalog.ts";
import { RISK_LABEL, StepDraftSchema } from "../plan/types.ts";
import type { Plan, StepDraft } from "../plan/types.ts";
import { PlanRejected } from "../plan/validate.ts";
import { MAX_ALLOW_ENTRIES } from "../rules/allow.ts";
import { MAX_OPTIONS, OPTION_TYPES } from "../rules/command.ts";
import type { CommandSpec } from "../rules/command.ts";
import { MAX_RULES_PER_PLAN } from "../rules/service.ts";
import { MAX_BATCH, MAX_DEBOUNCE_SECONDS, MAX_TRIGGER_EVENTS, triggerSummary } from "../rules/triggers.ts";
import { MAX_LIMITS, MAX_STATE_JSON } from "../rules/types.ts";
import type { Rule, RuleProposal, RuleRun } from "../rules/types.ts";
import type { WasmModule } from "../db.ts";
import { MAX_MODULE_BYTES, prepareModule } from "../wasm/module.ts";
import { execute, hostCalls, wasmInput } from "../wasm/run.ts";
import type { WasmBindings } from "../wasm/run.ts";

/** How much of a one-shot module's stdout the model sees. */
const MAX_WASM_OUTPUT = 20_000;
import { FRESH_TTL_MS, sizeLabel } from "../wasm/registry.ts";
import type { CompileResult, FreshModule } from "../wasm/registry.ts";
import type { CompilerLanguage, SourceFile } from "../wasm/compiler.ts";
import { docsIndex, loadDocs, readDoc, searchDocs } from "./docs.ts";

// Phase 1 tools are read-only. Every one of them goes through Reader, which
// narrows results to what may be shown in the channel the reply goes to.

const MAX_TOOL_OUTPUT = 20_000;

function text(value: string) {
  const body = value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n…(長いため省略)` : value;
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

const ImageSourceSchema = Type.Union([
  Type.String({ description: "この返答で用意した画像のID(img1 など)" }),
  Type.Object({
    message_id: Type.String(),
    channel_id: Type.Optional(Type.String({ description: "省略時は今のチャンネル" })),
    index: Type.Optional(Type.Integer({ minimum: 0, description: "何枚目の画像か(0から、既定 0)" })),
  }),
]);

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

export function formatMessage(m: Omit<APIMessage, "reactions"> & Partial<Pick<APIMessage, "reactions">>): string {
  const name = m.author.global_name ?? m.author.username;
  const parts = [`[${m.id}] ${m.timestamp.slice(0, 16).replace("T", " ")} ${name}(${m.author.id})${m.author.bot ? "[bot]" : ""}`];
  if (m.message_reference?.message_id) parts.push(`返信先:${m.message_reference.message_id}`);
  const content = [m.content, ...componentText(m.components)].filter(Boolean).join("\n");
  let line = `${parts.join(" ")}: ${content}`;
  if (m.attachments.length > 0) {
    line += ` [添付: ${m.attachments.map((a) => `${a.filename}${a.content_type?.startsWith("image/") ? "(画像)" : a.filename.toLowerCase().endsWith(".wasm") ? `(Wasmモジュール ${sizeLabel(a.size)}、register_wasm で登録できる)` : ""}`).join(", ")}]`;
  }
  if (m.embeds.length > 0) line += ` [埋め込み${m.embeds.length}件${m.embeds.some((e) => e.image || e.thumbnail) ? "・画像あり" : ""}]`;
  if (m.reactions?.length) {
    const shown = m.reactions.map((r) => `${r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name}${r.count}${r.me ? "(Botも)" : ""}`);
    line += ` [リアクション: ${shown.join(" ")}]`;
  }
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
function bindingsOf(reader: Reader, decide?: Decide): SandboxBindings {
  return {
    guildId: reader.guild.id,
    actor: { kind: "user", userId: reader.scope.speakerId },
    get: (route, query) => reader.get(route, query as Record<string, string>),
    ...(decide ? { decide } : {}),
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
  /** Where run_code's drawings go; when set, the code can draw with createCanvas(). */
  attachments?: ImageBox;
  /** Asks the speaker to let this reply read up to their own permissions; true when allowed. */
  widen?: (reason: string) => Promise<boolean>;
  /** Judgments by the speaker's judge model: the judge tool, and judge()/rank() in code. */
  decide?: Decide;
}

export type Propose = (drafts: StepDraft[], code?: string, rules?: RuleProposal[]) => Promise<Plan>;

export interface RuleTools {
  /** The speaker's rules in this server; `shown` is false when its contents may not appear in this channel. */
  list: () => Array<{ rule: Rule; shown: boolean; state?: unknown }>;
  /** Recent runs of one of the speaker's rules; null when it is not theirs or not shown here. */
  runs: (ruleId: string, limit: number) => RuleRun[] | null;
  /** The speaker's uploaded Wasm modules, which rules may run instead of code. */
  wasm?: WasmTools;
}

export interface WasmTools {
  list: () => WasmModule[];
  /** Checks and keeps a module for the speaker; throws ModuleRejected with the reason. */
  upload: (name: string, bytes: Uint8Array) => Promise<{ module: WasmModule; replaced: number }>;
  /** A kept module the speaker may run: their own by name, or one from someone in the server by sha256. */
  load: (ref: string) => Promise<{ module: WebAssembly.Module; name: string; sha256: string }>;
  /** Building from source, when the compiler service is there. */
  compiler?: {
    /** Languages it can build now. */
    languages: () => CompilerLanguage[];
    guide: (language: string) => Promise<string>;
    compile: (language: string, files: SourceFile[], optimize: "size" | "speed") => Promise<CompileResult>;
    /** A module the speaker built and has not kept, by sha256. */
    fresh: (ref: string) => FreshModule;
    /** Keeps a module the speaker built, with its sources. */
    keep: (name: string, ref: string) => Promise<{ module: WasmModule; replaced: number }>;
  };
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

  const sandboxBindings = bindingsOf(reader, options.decide);
  const box = options.attachments;

  /** An image the reply may use: one already in the box, or one on a message this channel may show. */
  const loadImage = async (source: unknown): Promise<Buffer> => {
    if (typeof source === "string") {
      const file = box?.get(source);
      if (!file) throw new Error(`画像 ${source} はありません。この返答で用意した画像のIDを指定してください`);
      return file.data;
    }
    if (!Value.Check(ImageSourceSchema, source) || typeof source !== "object") throw new Error('画像は "img1" のようなIDか { message_id, channel_id, index } で指定してください');
    const { message_id, channel_id, index } = source as { message_id: string; channel_id?: string; index?: number };
    // Goes through the reader, so only messages that may be shown here are opened.
    const message = (await reader.get(`/channels/${channel_id ?? reader.scope.channelId}/messages/${message_id}`)) as APIMessage;
    const ref = imageRefs(message).at(index ?? 0);
    if (!ref) throw new Error(`メッセージ ${message_id} に${index ? ` ${index + 1}枚目の` : ""}画像がありません`);
    const image = await fetchImage(ref, options.fetch);
    if (!image) throw new Error("画像を取得できませんでした(20MBまでの PNG・JPEG・GIF・WebP だけ扱えます)");
    return image.data;
  };
  const makeMath = async (tex: string, opts: MathOptions, name: string | undefined): Promise<string> => {
    box!.checkRoom();
    return box!.add({ data: await renderMath(tex, opts), name: `${name || "math"}.svg` });
  };
  const makeConverted = async (source: unknown, opts: ConvertOptions, name: string | undefined): Promise<string> => {
    box!.checkRoom();
    const { data, format } = await convertImage(await loadImage(source), opts);
    return box!.add({ data, name: `${name || "image"}.${format === "jpeg" ? "jpg" : format}` });
  };

  /** Bindings for one run whose images go into the reply's box; `made` collects their ids. */
  const drawingBindings = (made: string[]): SandboxBindings => {
    if (!box) return sandboxBindings;
    const keep = (id: string) => (made.push(id), id);
    return {
      ...sandboxBindings,
      attach: (png, name) => keep(box.add({ data: png, name: `${name || "image"}.png` })),
      media: {
        math: async (tex, raw, name) => keep(await makeMath(tex, parseOptions(MathOptionsSchema, raw), name)),
        convert: async (source, raw, name) => keep(await makeConverted(source, parseOptions(ConvertOptionsSchema, raw), name)),
      },
    };
  };
  /** Runs code whose images go into the reply's box; a failed run leaves none behind. */
  const runDrawing = async (code: string) => {
    const made: string[] = [];
    const result = await runSandboxed(code, drawingBindings(made), SANDBOX_LIMITS);
    if (!result.ok) box?.discard(made);
    return { result, made: result.ok ? made : [] };
  };
  /** The coder's trial runs draw too, but nothing is kept; formulas are still checked so TeX mistakes show. */
  const trialBindings: SandboxBindings = box
    ? {
        ...sandboxBindings,
        attach: () => "img0",
        media: {
          math: async (tex, raw) => (await renderMath(tex, parseOptions(MathOptionsSchema, raw)), "img0"),
          convert: async (_source, raw) => (parseOptions(ConvertOptionsSchema, raw), "img0"),
        },
      }
    : sandboxBindings;
  /** The images as the model sees them: shrunk, and only when it can see images. */
  const drawn = async (ids: string[]) => {
    if (!box || ids.length === 0) return [];
    const shown = options.images
      ? await Promise.all(ids.map(async (id) => {
          const file = box.get(id)!;
          const small = await forModel(file.data, mimeOf(file.name) ?? "image/png");
          return { type: "image" as const, data: small.data.toString("base64"), mimeType: small.mimeType };
        }))
      : [];
    return [
      { type: "text" as const, text: `\n画像 ${ids.join(", ")} を用意しました。返答に添付されます。propose_plan の投稿に付けるときは body の files にIDを入れます。` },
      ...shown,
    ];
  };
  const CANVAS_LINE = box
    ? "画像も描けます: const c = createCanvas(幅, 高さ); const ctx = c.getContext(\"2d\"); でブラウザの Canvas 2D と同じように描き(fillRect・fillText・arc・measureText など。画像の読み込みはできません)、attachImage(c, \"name\") で添付します(画像のIDが返ります。1回4枚、縦横2048pxまで)。" +
      "数式は renderMath(\"TeX\", { size, color, background, display }, \"name\") で SVG に(投稿するときは PNG になります)、画像の変換(大きさ・切り抜き・回転・形式)は convertImage(\"img1\" か { message_id, channel_id, index }, { width, height, fit, crop, rotate, format, quality, background, grayscale, trim }, \"name\") で作れます。どちらも新しい画像のIDを返し、作れるのは canvas と合わせて1回4枚までです。"
    : "";

  const runCode = tool({
    name: "run_code",
    label: "コードで調べる",
    description: [
      "読み取り専用のJavaScriptを実行し、returnした値をJSONで返します。複数のAPIを組み合わせる集計に使います。",
      "使えるもの: guild(サーバーID), actor, discord.get(route, { query }) (同期関数。例: discord.get(`/guilds/${guild}/roles`)), log(...)。",
      "読めるのは許可された経路だけで、結果は今のチャンネルで扱える範囲に絞られます。ネットワーク・タイマー・ファイルはありません。",
      ...(CANVAS_LINE ? [CANVAS_LINE] : []),
      ...(options.decide ? [JUDGE_CODE_LINE] : []),
    ].join("\n"),
    parameters: Type.Object({ code: Type.String({ description: "関数本体。最後に return で結果を返す" }) }),
    execute: async (_id, params) => {
      const { result, made } = await runDrawing(params.code);
      const logs = result.logs.length > 0 ? `\nlog:\n${result.logs.join("\n")}` : "";
      if (!result.ok) throw new Error(`${result.error}${logs}`);
      return { content: [{ type: "text" as const, text: `${JSON.stringify(result.value, null, 1)}${logs}` }, ...(await drawn(made))], details: {} };
    },
  });

  const coder = options.coder;
  // The coding agent reads the speaker's rules and runs too, so it can debug them.
  const coderTools = [readDocsTool(), ...(options.rules ? ruleReadTools(options.rules) : [])];
  const runCodeTask = tool({
    name: "run_code",
    label: "コードで調べる",
    description: [
      "読み取り専用のJavaScriptで調べ、結果をJSONで返します。複数のAPIを組み合わせる集計に使います。",
      "コードはコード用のモデルが書きます。task には、何を調べて何を返すコードかを具体的に書きます。コード用のモデルは会話を見ていないので、使うID・名前・条件・返してほしい形を task に全部書いてください。",
      "コードは Discord REST API の GET を読めます(結果は今のチャンネルで扱える範囲に絞られます)。返ってきたコードと結果を確かめて使ってください。",
      ...(box ? ["画像(グラフや表など。数式や、画像の変換も)を作って添付することもできます。そのときは task に、何をどう描くかと画像の名前を書きます。"] : []),
    ].join("\n"),
    parameters: Type.Object({ task: Type.String({ description: "何を調べて何を返すコードか" }) }),
    execute: async (_id, params) => {
      let result: Awaited<ReturnType<typeof runSandboxed>> | undefined;
      let made: string[] = [];
      const { code } = await writeCode(coder!, "read", params.task, {
        check: async (code) => {
          ({ result, made } = await runDrawing(code));
          return result.ok ? null : `${result.error}${result.logs.length > 0 ? `\nlog:\n${result.logs.join("\n")}` : ""}`;
        },
        run: (code) => runSandboxed(code, trialBindings, SANDBOX_LIMITS),
        tools: coderTools,
        ...(box ? { canvas: true } : {}),
      });
      const logs = result!.logs.length > 0 ? `\nlog:\n${result!.logs.join("\n")}` : "";
      return { content: [{ type: "text" as const, text: `コード:\n${code}\n\n結果:\n${JSON.stringify(result!.value, null, 1)}${logs}` }, ...(await drawn(made))], details: {} };
    },
  });

  const renderMathTool = tool({
    name: "render_math",
    label: "数式を描く",
    description: "TeX の数式を MathJax で SVG 画像にして添付します(Discord には PNG にして送られます。ams・mhchem の \\ce・color・cancel・boldsymbol が使えます)。文中に式を並べるより読みやすいときに使います。いくつもの式は aligned などで1枚にまとめられます。",
    parameters: Type.Object({
      tex: Type.String({ maxLength: 2000, description: "TeX($ や \\[ \\] で囲まない)" }),
      name: Type.Optional(Type.String({ maxLength: 40, description: "ファイル名(拡張子なし)" })),
      ...MathOptionsSchema.properties,
    }),
    execute: async (_id, params) => {
      const { tex, name, ...opts } = params;
      const id = await makeMath(tex, opts, name);
      return { content: await drawn([id]), details: { id } };
    },
  });

  const convertImageTool = tool({
    name: "convert_image",
    label: "画像を変換する",
    description: "画像の大きさ・切り抜き・回転・反転・白黒・余白の削除・背景色・形式(PNG・JPEG・WebP)を変えた画像を作って添付します。元にできるのは、この返答で用意した画像(img1 など。render_math の SVG も可)か、メッセージに添付された画像です。",
    parameters: Type.Object({
      source: ImageSourceSchema,
      name: Type.Optional(Type.String({ maxLength: 40, description: "ファイル名(拡張子なし)" })),
      ...ConvertOptionsSchema.properties,
    }),
    execute: async (_id, params) => {
      const { source, name, ...opts } = params;
      const id = await makeConverted(source, opts, name);
      return { content: await drawn([id]), details: { id } };
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

  const wasm = options.rules?.wasm;
  const runWasmTool = tool({
    name: "run_wasm",
    label: "Wasmを動かす",
    description: [
      "Wasmモジュールを登録せずに1回だけ動かし、標準出力・ログ・画像を返します。メッセージに添付された .wasm(だれの添付でも可)か、登録済みのモジュール(話し手のものは名前、同じサーバーの人のものは sha256 12文字以上)か、compile_wasm で作ったモジュール(compiled に sha256)を指定します。",
      "実行は読み取りだけです。モジュールは WASI のコマンドとして、標準入力で { guild, actor, eventName: null, event: input, batch: null, params: null, state: null } のJSONを読みます(stdin を渡すとその文字列だけ)。Discordの読み取りなどは secretary.call で、範囲は今のチャンネルで扱える分だけです。1回30秒・メモリ64MiBまで。",
      "標準出力が { steps: [...] } なら変更の提案です。実行するには、その steps を propose_plan の steps に渡して確認ダイアログを出します(勝手には実行されません)。reply があれば返答に使えます。",
    ].join("\n"),
    parameters: Type.Object({
      ...WASM_SOURCE,
      module: Type.Optional(Type.String({ description: "登録済みのモジュール名か sha256。message_id の代わりに" })),
      compiled: Type.Optional(Type.String({ description: "compile_wasm で作ったモジュールの sha256。message_id の代わりに" })),
      input: Type.Optional(Type.Unknown({ description: "標準入力のJSONの event に入れる値" })),
      stdin: Type.Optional(Type.String({ maxLength: 100_000, description: "標準入力にそのまま渡す文字列(input の代わりに)" })),
    }),
    execute: async (_id, params) => {
      if (!wasm) throw new Error("ここでは Wasm を動かせません");
      let module: WebAssembly.Module;
      let label: string;
      if (params.compiled) {
        if (!wasm.compiler) throw new Error("ここではコンパイルできません");
        const fresh = wasm.compiler.fresh(params.compiled);
        module = await WebAssembly.compile(fresh.bytes);
        label = `コンパイルした ${fresh.source.language} のモジュール(${fresh.info.sha256.slice(0, 12)})`;
      } else if (params.module) {
        const found = await wasm.load(params.module);
        module = found.module;
        label = `${found.name}(${found.sha256.slice(0, 12)})`;
      } else if (params.message_id) {
        const { bytes, filename } = await attachedWasm(reader, { ...params, message_id: params.message_id }, options.fetch ?? fetch);
        const prepared = await prepareModule(bytes);
        module = await WebAssembly.compile(prepared.bytes);
        label = `${filename}(${prepared.info.sha256.slice(0, 12)})`;
      } else throw new Error("message_id・module・compiled のどれかを指定してください");
      const made: string[] = [];
      const bindings: WasmBindings = {
        ...drawingBindings(made),
        ...(box
          ? {
              // Whatever the module hands over is re-encoded, so only real images go out.
              image: async (data: Buffer, name: string) => {
                box.checkRoom();
                const { data: out, format } = await convertImage(data, {});
                const id = box.add({ data: out, name: `${name || "image"}.${format === "jpeg" ? "jpg" : format}` });
                made.push(id);
                return id;
              },
            }
          : {}),
      };
      const stdin = params.stdin ?? wasmInput({ ...sandboxBindings, eventName: null, event: params.input ?? null, state: null });
      let run;
      try {
        run = await execute(module, new TextEncoder().encode(stdin), hostCalls(bindings, SANDBOX_LIMITS), SANDBOX_LIMITS.wallTimeMs);
      } catch (e) {
        box?.discard(made);
        throw e;
      }
      const out = run.stdout.toString("utf8");
      const lines = [`${label} 終了コード ${run.exitCode}`, `標準出力${out.length > MAX_WASM_OUTPUT ? `(先頭 ${MAX_WASM_OUTPUT} 文字)` : ""}:\n${out.slice(0, MAX_WASM_OUTPUT) || "(なし)"}`];
      if (run.logs.length) lines.push(`ログ(標準エラー出力):\n${run.logs.join("\n")}`);
      try {
        const parsed = JSON.parse(out) as { steps?: unknown };
        if (Array.isArray(parsed?.steps) && parsed.steps.length > 0) lines.push(`変更の提案が ${parsed.steps.length} 件あります。実行するなら steps を propose_plan の steps に渡してください。`);
      } catch {
        // Plain text output.
      }
      return { content: [{ type: "text" as const, text: lines.join("\n\n") }, ...(await drawn(made))], details: {} };
    },
  });

  const tools = [readMessages, searchMessages, listChannels, findMembers, coder ? runCodeTask : runCode, readDocsTool()];
  if (wasm) tools.push(runWasmTool);
  if (options.images) tools.push(viewImages);
  if (box) tools.push(renderMathTool, convertImageTool);
  if (options.propose) tools.push(proposePlan(reader, options.propose, !!options.rules, coder, coderTools, options.decide));
  if (options.decide) tools.push(judgeTool(options.decide));
  if (options.rules) tools.push(...ruleReadTools(options.rules));
  if (options.rules?.wasm) tools.push(...wasmTools(reader, options.rules.wasm, options.fetch ?? fetch));
  if (options.widen && reader.narrowed) tools.push(widenRead(reader, options.widen));
  return tools;
}

function widenRead(reader: Reader, widen: (reason: string) => Promise<boolean>): AgentTool<any> {
  return tool({
    name: "widen_read",
    label: "読み取りを広げる",
    description:
      "読み取りは、このチャンネルを見られる全員が見られる範囲に限られています。頼まれたことに答えるのにそれでは足りないとき(ツールが公開範囲や権限で拒否したときなど)だけ、話し手が見られる範囲まで広げる許可を求めます。話し手の設定によってはボタンで確認するので、答えが返るまで待ちます。",
    parameters: Type.Object({
      reason: Type.String({ maxLength: 300, description: "何を読むために広げたいか。話し手に見せる1文" }),
    }),
    execute: async (_id, params) => {
      if (!reader.narrowed) return text("読み取りはもう話し手が見られる範囲まで広がっています");
      if (!(await widen(params.reason))) {
        return text("話し手は読み取りを広げることを許可しませんでした(または返事がありませんでした)。今の範囲で答え、読めなかったものは読めなかったと伝えてください。");
      }
      reader.widen();
      return text(
        "話し手が見られる範囲まで読めるようになりました(この返答のあいだだけ)。ここで読んだものは、このチャンネルの全員は見られない内容かもしれません。返答には頼まれたことに必要な分だけ書いてください。",
      );
    },
  });
}

const AllowSchema = Type.Object({
  op: Type.String(),
  path: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), { description: "パスパラメータ名 → JSON Schema。例: { channel: { enum: [\"123\"] } }" })),
  body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "本文の JSON Schema" })),
  target: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "対象(チャンネル・ロール・メンバーなど)の実行直前の状態が満たすべき JSON Schema" })),
  channel: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "ステップが働くチャンネル(投稿先など)の実行直前の状態が満たすべき JSON Schema" })),
  max_steps_per_run: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const RULE_FIELDS = {
  name: Type.String({ minLength: 1, maxLength: 60, description: "ルールの短い名前" }),
  trigger_event: Type.String(),
  more_trigger_events: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_TRIGGER_EVENTS - 1, description: "同じルールを動かすほかのきっかけ" })),
  include_bot_origin: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("other_rules")])),
  schedule: Type.Optional(Type.String({ maxLength: 100, description: "SCHEDULE の cron(分 時 日 月 曜日)" })),
  timezone: Type.Optional(Type.String({ maxLength: 64 })),
  debounce_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DEBOUNCE_SECONDS })),
  serial_by: Type.Optional(Type.String({ maxLength: 64, description: "\"rule\" か、イベントの項目のパス(user_id など)" })),
  limits: Type.Optional(
    Type.Object({
      per_minute: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMITS.perMinute })),
      max_consecutive_failures: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMITS.maxConsecutiveFailures })),
    }),
  ),
  allow: Type.Array(AllowSchema, { maxItems: MAX_ALLOW_ENTRIES, description: "COMMAND で返事だけのときは空でかまいません" }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sample_event: Type.Optional(Type.Unknown()),
  replaces_rule: Type.Optional(Type.String()),
  wasm: Type.Optional(Type.String({ description: "コードの代わりに動かすアップロード済みWasmモジュール(話し手のモジュール名か sha256)" })),
  command: Type.Optional(
    Type.Object(
      {
        name: Type.String({ maxLength: 32, description: "コマンド名(小文字・数字・-・_)" }),
        description: Type.String({ maxLength: 100 }),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({ maxLength: 32 }),
              description: Type.String({ maxLength: 100 }),
              type: Type.Union(Object.keys(OPTION_TYPES).map((k) => Type.Literal(k))),
              required: Type.Optional(Type.Boolean()),
              choices: Type.Optional(Type.Array(Type.Object({ name: Type.String(), value: Type.Union([Type.String(), Type.Number()]) }), { maxItems: 25 })),
            }),
            { maxItems: MAX_OPTIONS },
          ),
        ),
        permissions: Type.Optional(Type.Array(Type.String(), { description: "実行する人に必要な Discord 権限名(例: ManageChannels)" })),
        visibility: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("private"), Type.Literal("public")], { description: "返事を見せる相手。auto(既定)は返事ごとに判定用のモデルが決め、private は実行した人だけ、public はチャンネルの全員" })),
      },
      { description: "trigger_event が COMMAND のときのスラッシュコマンド" },
    ),
  ),
};
const RuleSchema = Type.Object({ ...RULE_FIELDS, code: Type.Optional(Type.String({ maxLength: 8000 })) });
type RuleInput = Static<typeof RuleSchema>;
/** With a coding model, the agent describes each rule's code and the coder writes it. */
const CodedRuleSchema = Type.Object({
  ...RULE_FIELDS,
  code_task: Type.Optional(Type.String({ maxLength: 4000, description: "イベントごとに何を確かめて何をするコードか(wasm のときは不要)" })),
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
function ruleTask(r: CodedRuleInput & { code_task: string }): string {
  return [
    r.code_task,
    "",
    `きっかけ: ${[r.trigger_event, ...(r.more_trigger_events ?? [])].join("、")}${r.more_trigger_events?.length ? "(どれで動いたかは eventName で分かります)" : ""}`,
    ...(r.schedule ? [`時刻: cron ${r.schedule}(${r.timezone ?? "Asia/Tokyo"})`] : []),
    ...(r.command ? [`スラッシュコマンド: ${JSON.stringify(r.command)}(オプションは event.options、返事は reply("文"))`] : []),
    ...(r.debounce_seconds ? [`まとめて実行: 最後のイベントから${r.debounce_seconds}秒待って1回だけ動きます。その間のイベントは batch(古い順の [{ eventName, event }])で全部読め、event は最後のものです`] : []),
    `params: ${JSON.stringify(r.params ?? null)}`,
    `許す操作: ${JSON.stringify(r.allow)}`,
    ...(r.replaces_rule ? [`直すルール: ${r.replaces_rule}(list_rules・rule_runs で今のコードと実行履歴を見られます)`] : []),
    ...(r.sample_event !== undefined ? [`イベントの例: ${JSON.stringify(r.sample_event).slice(0, 2000)}`] : []),
  ].join("\n");
}

/** A rule's trial runs draw too, but nothing is kept; formulas are still checked so TeX mistakes show. */
const RULE_TRIAL_MEDIA: Pick<SandboxBindings, "attach" | "media"> = {
  attach: () => "img1",
  media: {
    math: async (tex, raw) => (await renderMath(tex, parseOptions(MathOptionsSchema, raw)), "img1"),
    convert: async (_source, raw) => (parseOptions(ConvertOptionsSchema, raw), "img1"),
  },
};

/** One coding agent per rule, all at once. */
async function codeRules(coder: Coder, rules: CodedRuleInput[], bindings: SandboxBindings, tools: AgentTool<any>[]): Promise<RuleInput[]> {
  return Promise.all(
    rules.map(async (r, i) => {
      const { code_task: task, ...rest } = r;
      // A rule that runs an uploaded module has no code to write.
      if (r.wasm) return rest;
      if (!task) throw new Error(`rules[${i}](${r.name}): code_task か wasm を渡してください`);
      try {
        const { code } = await writeCode(coder, "rule", ruleTask({ ...r, code_task: task }), {
          // Rule code only runs on events, so a submission is parsed rather than run.
          check: (code) => syntaxError(code),
          run: (code, event) => runRuleCode(code, { ...bindings, ...RULE_TRIAL_MEDIA, ...(r.trigger_event === "COMMAND" ? { reply: () => {} } : {}), event: event ?? null, params: r.params ?? null, state: null }),
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
    trigger: {
      event: r.trigger_event,
      ...(r.more_trigger_events?.length ? { events: r.more_trigger_events.filter((e) => e !== r.trigger_event) } : {}),
      ...(r.include_bot_origin ? { includeBotOrigin: r.include_bot_origin } : {}),
      ...(r.schedule !== undefined ? { schedule: r.schedule } : {}),
      ...(r.timezone !== undefined ? { timezone: r.timezone } : {}),
      ...(r.debounce_seconds ? { debounceSeconds: r.debounce_seconds } : {}),
      ...(r.serial_by ? { serialBy: r.serial_by } : {}),
      ...(r.command ? { command: r.command as CommandSpec } : {}),
    },
    ...(r.limits
      ? { limits: { ...(r.limits.per_minute ? { perMinute: r.limits.per_minute } : {}), ...(r.limits.max_consecutive_failures ? { maxConsecutiveFailures: r.limits.max_consecutive_failures } : {}) } }
      : {}),
    allow: r.allow.map((a) => ({
      op: a.op,
      ...(a.path ? { path: a.path } : {}),
      ...(a.body ? { body: a.body } : {}),
      ...(a.target ? { target: a.target } : {}),
      ...(a.channel ? { channel: a.channel } : {}),
      ...(a.max_steps_per_run ? { maxStepsPerRun: a.max_steps_per_run } : {}),
    })),
    program: r.wasm ? { kind: "wasm", module: r.wasm } : { kind: "js", code: r.code ?? "" },
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
  "  各要素 { name, trigger_event, more_trigger_events?, include_bot_origin?, schedule?, timezone?, debounce_seconds?, serial_by?, limits?, command?, allow, code か wasm, params?, sample_event?, replaces_rule? }。code モードでは rule({ 同じ項目 }) を作って plan(steps, [rule(...), ...]) で返します。",
  "  trigger_event: きっかけ(下の一覧から1つ)。同じ処理を複数のきっかけで動かすときは、残りを more_trigger_events に並べます(合わせて" + MAX_TRIGGER_EVENTS + "種類まで。例: 作成と変更の両方で並べ替える)。ルールを分ける必要はありません。コードはどのきっかけで動いたかを eventName(\"CHANNEL_CREATE\" など)で読めます。sample_event は trigger_event のイベントの例にします。Bot自身が起こしたイベントでは既定で動きません。include_bot_origin は何度動いても結果が同じになるルールにだけ付けます。true はBotの変更すべてで動き、\"other_rules\" はほかのルールや会話からの変更では動くがこのルール自身の変更では動きません(Botの投稿・リアクションでは動きません)。ほかのルールの結果に合わせて直すルール(例: 並べ替えのあとに一覧を作り直す)は \"other_rules\" にします。",
  "  時刻で動かすときは trigger_event(または more_trigger_events)に SCHEDULE を入れ、schedule に cron(分 時 日 月 曜日。例: 毎朝4時は \"0 4 * * *\"、10分おきは \"*/10 * * * *\")を、必要なら timezone(既定 Asia/Tokyo)を書きます。イベントのきっかけと一緒に使えます(例: チャンネルの作成・変更と毎日4時の作り直し)。BOT_READY はBotの起動・再接続のたびに動くので、止まっていた間の変化を取り込めます。",
  "  debounce_seconds: 短い間にイベントがまとめて来るとき(並べ替えでチャンネルの変更が何件も届くなど)に付けると、最後のイベントからその秒数待って1回だけ動きます。コードはその間のイベントを batch(古い順の [{ eventName, event }]。最大" + MAX_BATCH + "件)で読めます。batch はいつもあり、まとめないときは1件です。",
  "  serial_by: 同じルールの実行は既定で並行に動きます(debounce_seconds があるルールと state を書くルールは自動で1回ずつ)。前の実行の結果を前提にするときに付けます。\"rule\" はこのルールの実行をすべて順番に、イベントの項目のパス(例: \"user_id\")はその値が同じイベントだけ順番にします(例: 同じ人の入室と退室で部屋の作成と削除が入れ替わらないように)。",
  "  state: ルールごとに次の実行へ値を持ち越せます。コードは前回保存した値を state(最初は null)で読み、setState(値) で次回の state を決めます(JSONで" + MAX_STATE_JSON + "文字まで)。保存されるのは実行が通ったとき(変更なし・実行済み)だけで、失敗した回は前の state のままです。setState を呼ばなければ state は変わりません。例: 前回作った一覧の内容を覚えて差分だけ直す、回数を数える、最後に処理したメッセージIDを覚える。",
  "  limits: { per_minute?, max_consecutive_failures? }。既定は1分に10回・3回続けて失敗で停止です。必要なときだけ変えます。",
  "  code: イベントごとに読み取り専用のサンドボックスで動く関数本体(文字列)。変更がなければ return null、あれば return plan([call(op, { id?, path, body }), ...])。前のステップの結果は $ref で参照できます。",
  "    使えるもの: event(発火したイベント), params, guild, actor, discord.get(route, { query })(同期関数), call, plan, log, reply(COMMAND のときだけ), createCanvas・attachImage・renderMath・convertImage(画像を作ってIDを返します。投稿の body.files に入れるか、COMMAND では返事に添付されます。1回4枚まで), judge・rank(作成者の判定モデル、COMMAND では実行した人の判定モデルで判定・並べ替え。使い方は run_code の説明と同じ), Math.random, Date。実行は1回30秒・discord.get 200回まで。ネットワーク・タイマーはありません。",
  "  params: code が params として読む値。この変更のステップで作るもののIDは { \"$ref\": \"steps.<id>.result.id\" } で渡せます(登録時に実際のIDになります)。",
  "  allow: ルールに許す操作。各要素 { op, path?, body?, target?, channel?, max_steps_per_run? }。path はパスパラメータごとの、body は本文の、target は対象の実行直前の状態(例: チャンネルの name や type)の、channel はステップが働くチャンネル(投稿・メッセージ削除・リアクションの場所)の実行直前の状態の JSON Schema です。決まったカテゴリの中のチャンネルにだけ投稿させるなら channel: { properties: { parent_id: { const: \"<カテゴリID>\" } }, required: [\"parent_id\"] } のようにします。コードが出したステップはどれか1つに合わないと実行されません。",
  "    できるだけ狭くします: チャンネルやロールが決まっていれば { enum: [ID] } で固定し(この変更で作るものなら { enum: [{ \"$ref\": \"steps.s1.result.id\" }] })、body は使うフィールドだけを properties に書いて additionalProperties: false、max_steps_per_run も付けます。削除や変更の対象を名前などで限るときは target を使います(例: { properties: { name: { pattern: \"^📞\" } }, required: [\"name\"] })。",
  "    ルールのコードが同じ回の前のステップで作ったもの(例: 作った部屋へ移すときの channel_id)は、IDが前もって決まらないので { madeInRun: true } とします。例: { op: \"PATCH /guilds/{guild}/members/{user}\", body: { properties: { channel_id: { madeInRun: true } }, required: [\"channel_id\"], additionalProperties: false } }。そのフィールドは、コードの中で $ref で前のステップを指したときだけ通ります。変更案の steps で作るもの(登録時に決まるID)を指す { \"$ref\": \"steps.s1.result.id\" } とは別物なので混同しないでください。",
  "  sample_event: 実際のイベントで試せないきっかけ(このチャンネルのメッセージやあなたのメンバー情報以外)のとき、ドライラン用のイベントを付けます。",
  "  replaces_rule: 依頼者の既存のルールを直すときにそのID(list_rules で確認)。",
  "  wasm: コードの代わりに、アップロードされたWasmモジュール(Botがソースからコンパイルして登録したものを含む)を動かすときに付けます(code は付けません)。話し手のモジュール名(list_wasm で確認)か、同じサーバーの人が上げたモジュールの sha256(12文字以上)です。Wasmは会話で登録できます(/settings の「Wasm」からも登録できます)。一度動かすだけなら登録せずに run_wasm で動かします。話し手が .wasm を添付して使い道を話したら、何をするモジュールか・どう使いたいか(どのきっかけで動かすか、コマンドにするか、何を変更するか)を相談し、決まったら register_wasm で登録してからルール案を出します。登録しただけで済ませたいと言われたら登録だけします。JavaScript 以外の言語(Rust・Go・C・MoonBit・Zig・Nim など)で書きたいと頼まれたら、compile_wasm でコンパイルし、register_wasm(compiled と name)で登録してからその名前を wasm に入れます。モジュールはWASIのコマンドとして、標準入力でイベントなどのJSONを読み、標準出力に { steps, state?, reply? } を書きます(steps は call と同じ { id?, op, path, body } の配列)。allow・trigger・params などはJSのルールと同じに決めます。何をするモジュールかは話し手に聞くか、list_wasm の説明から判断します。",
  "  ルールのコードでも画像を作れます(createCanvas・attachImage・renderMath・convertImage)。投稿の body.files に画像のID(\"img1\" など)を入れると添付されるので、そのときは allow の body に files: { type: \"array\", maxItems: 4 } を加えます。",
  "  メッセージに付いたリアクションの人は discord.get(`/channels/<チャンネル>/messages/<メッセージ>/reactions/<絵文字>`) で読めます。リアクションの付け外しは PUT/DELETE …/reactions/{emoji}/@me、ほかの人のリアクションを外すのは DELETE …/reactions/{emoji}/{user} です(emoji は 👍 のような絵文字か 名前:ID)。Botの投稿の書き換えは PATCH /channels/{channel}/messages/{message} です。",
  "  スラッシュコマンドにするとき(「/◯◯ で△△できるように」など)は trigger_event を COMMAND だけにし、command: { name, description, options?: [{ name, description, type: string・integer・number・boolean・user・channel・role, required?, choices? }], permissions?, visibility? } を付けます。コマンドはこのサーバーに登録され、実行されるとオプションの値が event.options(名前 → 値。user・channel・role はID)に、実行した人が event.user・event.member に入ります。コードは reply(\"文\") で実行した人に返事をします(visibility は既定の \"auto\" で返事ごとに実行した人の判定用モデルが全員に見せるか決め、迷えば実行した人だけに見せます。いつも本人だけなら \"private\"、いつも全員なら \"public\" です。依頼で指定がなければ付けません。そのときは確認画面で判定用モデルが既定値を選び、依頼者が3つから選び直せます)。コマンドは実行した人として動きます。変更は allow の範囲で、さらに実行した人が持つ権限の分だけ実行され、読み取りはそのチャンネルを見られる全員(と実行した人)が読めるものに限られます。permissions(例: [\"ManageChannels\"])を付けると、その権限がない人にはコマンドが出ず実行もできません。変更がなく返事だけのコマンドは allow を [] にします。sample_event には { options: { … } } を書けます。返事に画像を付けるときは、コードで renderMath・createCanvas などを呼ぶだけで添付されます。",
  "  ボイスチャンネルの在室者は discord.get(`/guilds/${guild}/voice-states`) で [{ user_id, channel_id }] として読めます。",
  "  きっかけにできるイベント:",
  triggerSummary(),
].join("\n");

/** A .wasm attached to a message the reader may open. */
async function attachedWasm(reader: Reader, ref: { message_id: string; channel_id?: string | undefined; index?: number | undefined }, fetchFn: typeof fetch): Promise<{ bytes: Uint8Array; filename: string; authorId: string }> {
  const channelId = ref.channel_id ?? reader.scope.channelId;
  const message = (await reader.get(`/channels/${channelId}/messages/${ref.message_id}`, {})) as APIMessage | null;
  if (!message) throw new Error("メッセージが見つかりません");
  const files = message.attachments.filter((a) => a.filename.toLowerCase().endsWith(".wasm"));
  const file = files[ref.index ?? 0];
  if (!file) throw new Error("このメッセージに .wasm の添付はありません");
  if (file.size > MAX_MODULE_BYTES) throw new Error(`.wasm は${MAX_MODULE_BYTES / 1024 / 1024}MBまでです`);
  const res = await fetchFn(file.url);
  if (!res.ok) throw new Error(`添付を取得できませんでした(${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), filename: file.filename, authorId: message.author.id };
}

const WASM_SOURCE = {
  message_id: Type.Optional(Type.String({ description: ".wasm が添付されたメッセージ" })),
  channel_id: Type.Optional(Type.String({ description: "省略時は今のチャンネル" })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "何個目の .wasm か(0から、既定 0)" })),
};

/** The speaker's Wasm modules: listing them, and keeping one attached to a message. */
function wasmTools(reader: Reader, wasm: WasmTools, fetchFn: typeof fetch): AgentTool<any>[] {
  const describe = (m: WasmModule) =>
    JSON.stringify({ name: m.name, sha256: m.sha256, size: sizeLabel(m.size), built_with: m.info.producers, ...(m.source ? { source: `${m.source.language}(${m.source.files}ファイル、Botがコンパイル)` } : {}), uploaded: m.createdAt.slice(0, 16) });
  return [
    ...(wasm.compiler && wasm.compiler.languages().length ? compileTools(reader, wasm.compiler, fetchFn) : []),
    tool({
      name: "list_wasm",
      label: "Wasmモジュールを見る",
      description: "話し手がアップロードしたWasmモジュールの一覧(名前・sha256・大きさ・ビルドした道具・登録日時)を新しい順に返します。ルールの wasm に名前を入れるときに確かめます。",
      parameters: Type.Object({}),
      execute: async () => {
        const items = wasm.list();
        return text(items.length ? items.map(describe).join("\n") : "モジュールはありません。.wasm を添付して話しかけてもらえば register_wasm で登録できます(/settings の「Wasm」からも登録できます)");
      },
    }),
    tool({
      name: "register_wasm",
      label: "Wasmを登録",
      description: `メッセージに添付された .wasm か、compile_wasm で作ったモジュール(compiled に sha256、name は必須)を話し手のモジュールとして登録します(${MAX_MODULE_BYTES / 1024 / 1024}MBまで)。コンパイルしたものはソースも一緒に保存されます。同じ名前で登録すると新しい版になり、それを使うルールは差し替えるまで古い版のまま動きます。添付は話し手本人のメッセージのときだけ使います。登録しただけでは何も動きません。`,
      parameters: Type.Object({
        ...WASM_SOURCE,
        compiled: Type.Optional(Type.String({ description: "compile_wasm で作ったモジュールの sha256。message_id の代わりに" })),
        name: Type.Optional(Type.String({ maxLength: 40, description: "モジュール名。添付なら省略時はファイル名" })),
      }),
      execute: async (_id, params) => {
        if (params.compiled) {
          if (!wasm.compiler) throw new Error("ここではコンパイルできません");
          if (!params.name) throw new Error("compiled で登録するときは name を付けてください");
          const { module, replaced } = await wasm.compiler.keep(params.name, params.compiled);
          return text(`登録しました: ${describe(module)}${replaced ? `(同じ名前の古い版${replaced}個は使われていないので消しました)` : ""}`);
        }
        if (!params.message_id) throw new Error("message_id か compiled を指定してください");
        const { bytes, filename, authorId } = await attachedWasm(reader, { ...params, message_id: params.message_id }, fetchFn);
        if (authorId !== reader.scope.speakerId) throw new Error("話し手本人が添付した .wasm だけ登録できます");
        const { module, replaced } = await wasm.upload(params.name ?? filename, bytes);
        return text(`登録しました: ${describe(module)}${replaced ? `(同じ名前の古い版${replaced}個は使われていないので消しました)` : ""}`);
      },
    }),
  ];
}

const MAX_SOURCE_BYTES = 256 * 1024;

/** Source files attached to a message, placed where the language expects them (main.rs → src/main.rs). */
async function attachedSources(reader: Reader, ref: { message_id: string; channel_id?: string | undefined }, language: CompilerLanguage, fetchFn: typeof fetch): Promise<SourceFile[]> {
  const channelId = ref.channel_id ?? reader.scope.channelId;
  const message = (await reader.get(`/channels/${channelId}/messages/${ref.message_id}`, {})) as APIMessage | null;
  if (!message) throw new Error("メッセージが見つかりません");
  const paths = new RegExp(language.paths);
  const files = message.attachments.filter((a) => language.extensions.some((e) => a.filename.toLowerCase().endsWith(e)));
  if (files.length === 0) throw new Error(`このメッセージに ${language.extensions.join(" ")} の添付はありません`);
  if (files.reduce((n, a) => n + a.size, 0) > MAX_SOURCE_BYTES) throw new Error(`ソースは合計${MAX_SOURCE_BYTES / 1024}KBまでです`);
  return Promise.all(
    files.map(async (a) => {
      const path = paths.test(a.filename) ? a.filename : paths.test(`src/${a.filename}`) ? `src/${a.filename}` : null;
      if (!path) throw new Error(`${a.filename} は置けない名前です(${language.paths})`);
      const res = await fetchFn(a.url);
      if (!res.ok) throw new Error(`添付を取得できませんでした(${res.status})`);
      return { path, content: await res.text() };
    }),
  );
}

/**
 * The secretary.call ABI and its host functions, from docs/wasm.md, for every
 * language guide: the SDKs wrap them, but code without the SDK needs them.
 */
async function hostCallGuide(): Promise<string> {
  try {
    const docs = await loadDocs();
    const sections = ["secretary.call", "ホスト関数"].map((s) => readDoc(docs, "wasm", s).replace(/^###/gm, "##"));
    return ["# secretary.call の受け渡し(全言語共通)", "SDK の Call・Get などはこれを包んでいます。SDK を使わずに呼ぶときや、ホスト関数の引数を確かめるときに読みます。入出力の JSON など残りは read_docs の wasm にあります。", ...sections].join("\n\n");
  } catch {
    return "secretary.call の受け渡しは read_docs の wasm(見出し「secretary.call」「ホスト関数」)にあります。";
  }
}

/** Building Wasm modules from source with the compiler service. */
function compileTools(reader: Reader, compiler: NonNullable<WasmTools["compiler"]>, fetchFn: typeof fetch): AgentTool<any>[] {
  const languages = compiler.languages();
  const summary = languages.map((l) => `${l.id}(${l.name}、入口 ${l.entry.join(" か ")}、使えるライブラリ: ${l.libraries.join("・") || "標準のみ"})`).join("、");
  const find = (id: string) => compiler.languages().find((l) => l.id === id) ?? null;
  return [
    tool({
      name: "wasm_language_guide",
      label: "Wasmの書き方を見る",
      description: `compile_wasm でソースを書く前に、その言語の書き方(SDK・入出力・置けるファイル・例)を読みます。言語: ${summary}`,
      parameters: Type.Object({ language: Type.String() }),
      execute: async (_id, params) => text([await compiler.guide(params.language), await hostCallGuide()].join("\n\n")),
    }),
    tool({
      name: "compile_wasm",
      label: "Wasmにコンパイル",
      description: [
        `ソースを Wasm モジュールにコンパイルします。言語: ${summary}。`,
        "コンパイルは Bot とは別のコンパイラで、ネットワークなしの箱の中で行われます。送れるのはソースファイルだけで、Cargo.toml・go.mod・build.rs などのビルド設定や追加のライブラリは指定できません。書く前に wasm_language_guide で書き方を確かめます。ABI やホスト関数の細かい決まりは read_docs の wasm と languages にあります。",
        "ソースは files に書くか、メッセージに添付されたソース(message_id)を使います。失敗したらエラーの場所と内容が返るので、直してもう一度呼びます。",
        `できたモジュールは${FRESH_TTL_MS / 60000}分だけ保持されます。一度動かすなら run_wasm の compiled に、ルールやコマンドに使うなら register_wasm の compiled と name で登録して(ソースも保存されます)、rules の wasm にその名前を入れます。`,
      ].join("\n"),
      parameters: Type.Object({
        language: Type.String({ description: languages.map((l) => l.id).join(" / ") }),
        files: Type.Optional(Type.Array(Type.Object({ path: Type.String({ maxLength: 200 }), content: Type.String() }), { maxItems: 32, description: "ソースファイル(パスは言語の決まりに合わせる)" })),
        message_id: Type.Optional(Type.String({ description: "ソースが添付されたメッセージ(files と合わせても可)" })),
        channel_id: Type.Optional(Type.String({ description: "省略時は今のチャンネル" })),
        optimize: Type.Optional(Type.Union([Type.Literal("size"), Type.Literal("speed")], { description: "既定は size" })),
      }),
      execute: async (_id, params) => {
        const language = find(params.language);
        if (!language) throw new Error(`言語 ${params.language} は使えません(${languages.map((l) => l.id).join(", ")})`);
        const files: SourceFile[] = [...(params.files ?? [])];
        if (params.message_id) files.push(...(await attachedSources(reader, { message_id: params.message_id, channel_id: params.channel_id }, language, fetchFn)));
        if (files.length === 0) throw new Error("files か message_id でソースを渡してください");
        const result = await compiler.compile(language.id, files, params.optimize ?? "size");
        const located = (d: { file: string; line: number; col: number; severity: string; message: string }) => `${d.file}:${d.line}:${d.col}: ${d.severity}: ${d.message}`;
        if (!result.ok) {
          const lines = [`コンパイルできませんでした(${result.stage === "limit" ? "時間か大きさの上限" : result.stage === "link" ? "リンク" : "コンパイル"})。`];
          if (result.diagnostics.length) lines.push(...result.diagnostics.slice(0, 20).map(located));
          lines.push(`ログ(末尾):\n${result.log.slice(-3000)}`);
          return text(lines.join("\n"));
        }
        const m = result.module;
        const warnings = result.log.split("\n").filter((l) => /\bwarning\b/.test(l)).slice(0, 10);
        return text(
          [
            `コンパイルしました(${language.name} ${m.source.version}、${result.cached ? "同じソースの結果を再利用" : `${Math.round(result.durationMs / 100) / 10}秒`}): sha256 ${m.info.sha256} 大きさ ${sizeLabel(m.bytes.length)}`,
            `${FRESH_TTL_MS / 60000}分だけ保持されます。動かすなら run_wasm の compiled、残すなら register_wasm の compiled と name に sha256 を渡します。`,
            ...(warnings.length ? [`警告:\n${warnings.join("\n")}`] : []),
          ].join("\n"),
        );
      },
    }),
  ];
}

/** The bot's own documentation (docs/), for how it works: conversation, /settings, rules, JS API, Wasm, languages, operations. */
function readDocsTool(): AgentTool<any> {
  return tool({
    name: "read_docs",
    label: "ドキュメントを読む",
    description: [
      "Bot 自身のドキュメントを読みます。使い方(会話・/settings・ルール・コマンド)、JavaScript の API、Wasm の ABI、言語と SDK、書き込み操作と権限が書いてあります。",
      "Bot の仕組みや使い方を聞かれたとき、ルールやコード、Wasm を書く前に決まりを確かめるときに使います。覚えで答えずに、ここで確かめます。",
      "doc を省くと目次(文書と見出し)、doc だけなら文書全体、section を付けるとその見出しの中だけ、query を付けると全文書からその言葉を含む行を返します。",
    ].join("\n"),
    parameters: Type.Object({
      doc: Type.Optional(Type.String({ description: "conversation / settings / rules / js-api / wasm / languages / operations" })),
      section: Type.Optional(Type.String({ description: "見出し(doc と一緒に)" })),
      query: Type.Optional(Type.String({ description: "探す言葉(空白で区切ると全部を含む行)" })),
    }),
    execute: async (_id, params) => {
      const docs = await loadDocs();
      if (params.query) return text(searchDocs(docs, params.query, params.doc));
      if (params.doc) return text(readDoc(docs, params.doc, params.section));
      return text(docsIndex(docs));
    },
  });
}

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
    description: "話し手が作ったイベントルールの一覧(ID・名前・有効か・きっかけ・許す操作・コード・持ち越している state)を返します。ルールを直す依頼のときに使います。",
    parameters: Type.Object({}),
    execute: async () => {
      const items = rules.list();
      if (items.length === 0) return text("ルールはありません");
      return text(
        items
          .map(({ rule, shown, state }) =>
            shown
              ? JSON.stringify({ id: rule.id, name: rule.name, enabled: rule.enabled, version: rule.version, trigger: rule.trigger, allow: rule.allow, params: rule.params, ...(rule.program.kind === "wasm" ? { wasm: rule.program.sha256 } : { code: rule.program.code }), state: state ?? null })
              : `${rule.id} ${rule.name}: このチャンネルでは扱えないチャンネルを使うため、内容は表示できません`,
          )
          .join("\n"),
      );
    },
  });
}

/** Judging and ranking by the speaker's judge model, which is lighter than the agent's own. */
function judgeTool(decideFn: Decide): AgentTool<any> {
  return tool({
    name: "judge",
    label: "判定する",
    description: [
      "判定モデルに、データについての判定をまとめて頼みます。はい・いいえ(bool)、選択肢から1つ(choice)、段階での点数付け(score)ができます。",
      "多くのメッセージやメンバーを分類する、条件に合うか見分ける、関連の強い順に並べるなど、判断の数が多いときに使います。自分で読んで判断するより軽く済みます。",
      `state: 判定するデータ(オブジェクト。JSONで${MAX_JUDGE_STATE_JSON}文字まで)。questions: { キー: 質問 }(${MAX_QUESTIONS}個まで)。質問は { type: "bool", instructions, criteria: { true, false } }、{ type: "choice", instructions, criteria: { 選択肢キー: 説明 } }、{ type: "score", instructions, criteria: [低い段階の説明, …, 高い段階の説明] } です。`,
      "答えは bool なら probability(0〜1)、choice なら choice と confidence、score なら score(段階の番号。小数あり)と confidence です。",
    ].join("\n"),
    parameters: Type.Object({
      state: Type.Record(Type.String(), Type.Unknown()),
      questions: Type.Record(Type.String(), Type.Unknown()),
    }),
    execute: async (_id, params) => {
      const input = checkDecideInput(params.state, params.questions);
      const answers = await decideFn(input.state, input.questions);
      return text(JSON.stringify(answers, null, 1));
    },
  });
}

function proposePlan(reader: Reader, propose: Propose, withRules: boolean, coder?: Coder, coderTools: AgentTool<any>[] = [], decide?: Decide): AgentTool<any> {
  const codeLine = coder
    ? `code_task: 今すぐ行う変更を作るコードの依頼(steps と同時には使えません)。コード用のモデルが読み取り専用のJavaScriptを書いて実行し、変更の一覧を作ります。何を読んで、どんな条件で、どの対象に何をするかを書きます。${CODER_LIMIT_NOTE}`
    : `code: 今すぐ行う変更を作る読み取り専用のJavaScript(steps と同時には使えません)。承認ダイアログにはこのコードと、コードだけを読んだ別のAIによる説明が出るので、読みやすく書きます。run_code と同じ discord.get が使え、call(op, { id?, path, body }) で作ったステップを return plan([...]) で返します。${withRules ? "ルールも作るときは return plan([...], [rule({...}), ...]) です。" : ""}`;
  const rulesDescription = coder
    ? RULES_DESCRIPTION.replace(
        /\n  各要素[^\n]*\n/,
        `\n  各要素 { name, trigger_event, more_trigger_events?, include_bot_origin?, schedule?, timezone?, debounce_seconds?, serial_by?, limits?, command?, allow, code_task か wasm, params?, sample_event?, replaces_rule? }。\n  code_task: イベントごとに動くコードの依頼。コード用のモデルが、ここに書いた内容ときっかけ・params・allow を見てコードを書きます。イベントのどの値を見て、どんなときに何をするか(何もしないのはどんなときか)を書いてください。${CODER_LIMIT_NOTE}\n`,
      ).replace(/\n  code: イベントごとに[^\n]*\n    使えるもの:[^\n]*/, "")
    : RULES_DESCRIPTION;
  const sandboxBindings = bindingsOf(reader, decide);
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
        const result = await runSandboxed(code, sandboxBindings, SANDBOX_LIMITS);
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
        code = (await writeCode(coder, "plan", params.code_task, { check: runPlan, run: (c) => runSandboxed(c, sandboxBindings, SANDBOX_LIMITS), tools: coderTools })).code;
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
