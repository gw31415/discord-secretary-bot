import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { lightestThinking, llm } from "../llm/models.ts";
import { catalogSummary } from "../plan/catalog.ts";
import { triggerSummary } from "../rules/triggers.ts";
import { compileJs, WASM_CODE_LINE } from "../sandbox.ts";
import { JUDGE_CODE_LINE } from "./decide.ts";
import { retryFailedCall } from "./retry.ts";

// A second agent, on the model the speaker picked for writing code. The conversation
// agent describes what the code should do; this agent tries code against the server
// (read-only), submits it, and fixes its own errors. It sees only the task, never
// the conversation. Several can run at once (one per rule in a plan).

export type CodeKind = "read" | "plan" | "rule";

/** Runs or checks the code; returns null when it is fine, or the error to fix. */
export type CodeCheck = (code: string) => Promise<string | null>;

export interface CodeEnv {
  /** Checks submitted code: runs it, or for rule code parses it. */
  check: CodeCheck;
  /** Runs read-only code for the coder to look around; `event` stands in for a rule's event. */
  run: (code: string, event?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string; logs: string[] }>;
  /** More read-only tools, such as the speaker's rules and their run history. */
  tools?: AgentTool<any>[];
  /** The code may draw images with createCanvas() and attachImage(). */
  canvas?: boolean;
}

export interface CodeResult {
  code: string;
  attempts: number;
}

export interface Coder {
  /** The model's name, shown with the code it wrote. */
  label: string;
  write(kind: CodeKind, task: string, env: CodeEnv, signal?: AbortSignal): Promise<CodeResult>;
}

export class CodeFailed extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/** Submissions that fail before the coder gives up. */
export const MAX_CODE_ATTEMPTS = 3;
const MAX_CODE_TURNS = 12;
const MAX_OUTPUT_TOKENS = 8000;
const MAX_TRY_OUTPUT = 8000;

const COMMON = [
  "あなたはDiscordサーバー管理Botのコードを書く係です。依頼に合う JavaScript の関数本体を書き、submit_code で提出します。",
  "- データの形がわからないときは、try_code で読み取りのコードを試して確かめてから書きます(try_code は何も変更しません)。",
  "- 提出したコードがエラーになったら、エラーを読んで直して出し直します。提出が通ったら終わりです。説明の文章は不要です。",
  "- コードは関数本体として実行され、最後に return した値が結果になります。async/await・Promise・タイマー・ネットワーク・import はありません。乱数(Math.random)と日時(Date)は使えます。",
  "- 使えるもの: guild(サーバーIDの文字列), actor, discord.get(route, { query }) (同期関数。Discord REST API の GET を読み、JSONを返す。例: discord.get(`/guilds/${guild}/roles`)), log(...)。",
  "- 読める経路は Discord REST API の GET のうち許可されたものだけで、結果は権限と公開範囲に合わせて絞られます。ボイスチャンネルの在室者は discord.get(`/guilds/${guild}/voice-states`) で [{ user_id, channel_id }] として読めます。",
  `- ${JUDGE_CODE_LINE}`,
  `- ${WASM_CODE_LINE}`,
  "- 依頼に書かれたID・名前・条件をそのまま使い、書かれていないことは推測で足さないでください。",
  "- 読みやすく書きます。変数名は内容がわかるものにします。",
];

const PLAN = [
  "- サーバーへの変更は call(op, { id?, path, body }) で1件ずつ作り、return plan([...]) で返します。このコードは変更を作るだけで、実行は人の承認後です。",
  "- path はパスパラメータ(guild は省略可)。前のステップの結果は { $ref: \"steps.<id>.result.id\" } で参照できます(参照するステップには id を付けます)。",
  "- 変更がなければ return plan([]) です。",
  "",
  "使える操作(これ以外と、仕様にないフィールドは拒否されます):",
];

const RULE = [
  "- このコードはイベントルールで、決まったイベントが起きるたびに動きます。event は発火したイベントのペイロード、eventName はどのきっかけで動いたか(\"CHANNEL_CREATE\" など)、params はルールと一緒に登録された値です。",
  "- 変更がなければ return null、あれば return plan([call(op, { id?, path, body }), ...]) を返します。前のステップの結果は { $ref: \"steps.<id>.result.id\" } で参照できます。",
  "- batch はその回のイベント全部(古い順の [{ eventName, event }])で、まとめて実行するルールでは複数件、それ以外は1件です。SCHEDULE(時刻)のときの event は { guild_id, scheduled_at, schedule, timezone }、BOT_READY(起動時)のときは { guild_id } です。COMMAND(スラッシュコマンド)のときは { guild_id, channel_id, command, user: { id, username, global_name }, member: { roles, nick }, options: { オプション名: 値 } } で、reply(\"文\") で実行した人に返事をします(何度も呼ぶと改行でつながり、1900文字まで)。INTERACTION_CREATE(Botのメッセージのボタン・セレクト・フォーム送信)のときは Discord のインタラクションのまま(押した人は event.member、event.data.custom_id、フォームの入力は event.data.components の各 component の custom_id と value)で、respond({ type, data }) で押した人に応答します(type 9 でフォーム、4 でメッセージ(data.flags 64 で押した人だけ)、7 でボタンのメッセージを書き換え。data は Discord の形のまま)。",
  "- state は前回の実行で setState(値) した値(最初は null)です。次の実行に持ち越したい値があれば setState で保存します(JSON にできる値。保存されるのは実行が通ったときだけ)。",
  "- later(いつ) で1分〜7日先に1回だけ(いつは秒数、ISO 8601 の期間 \"PT10M\" か日時 \"2026-10-28T09:00+09:00\"、cron の式 \"0 9 * * *\" は次に当てはまる日時)このルールをもう一度動かす予約ができます(1回の実行で10件まで、保存は実行が通ったときだけ)。その時刻に eventName \"TIMER\"、event { guild_id, due_at, chain, message? } で動き、予約した実行と同じ人として動きます。COMMAND の実行で予約し返事が全員に見えるときは event.message { channel_id, id } がその返事です。何のために起きたか(どのメッセージ・どの申請か)は、予約するときに自分で state に書いておきます。TIMER の実行がまた later できるのは続けて10回まで(event.chain が10なら later はエラー)なので、繰り返す処理には使いません。",
  "- 実行は1回30秒・discord.get 200回までです。",
  "- 画像も作れます。createCanvas(幅, 高さ) で描いて attachImage(c, \"name\")、数式は renderMath(\"TeX\", { size, color, background, display }, \"name\")(SVG。投稿するときは PNG になります)、変換は convertImage(\"img1\" か { message_id, channel_id, index }, { width, height, fit, format, … }, \"name\")。どれも \"img1\" のようなIDを返し、返事や投稿に付くのは10枚までです(絵文字の image・スタンプの file に使う画像は数えません)。投稿(POST /channels/{channel}/messages・DM)の body.files に IDを入れると添付され(許す操作の body に files があるときだけ)、COMMAND では作った画像が返事に添付されます。",
  "- 返すステップは依頼にある「許す操作」に合うものだけにします。合わないステップは実行されません。許す操作で { madeInRun: true } のフィールドには、同じ回の前のステップを指す { $ref: \"steps.<id>.result.id\" } を入れます。",
  "",
  "使える操作:",
];

const CANVAS = "\n\n画像を頼まれたら、const c = createCanvas(幅, 高さ); const ctx = c.getContext(\"2d\"); でブラウザの Canvas 2D と同じように描き(fillRect・fillText・arc・measureText など。画像の読み込みはできません)、attachImage(c, \"name\") で添付します。attachImage は画像のIDを返すので、結果に含めて返します。縦横2048pxまでです。背景は透明なので、必要なら最初に塗ります。\n数式は renderMath(\"TeX\", { size, color, background, display }, \"name\") で MathJax の SVG 画像に(投稿するときは PNG になります)、画像の変換は convertImage(\"img1\" か { message_id, channel_id, index }, { width, height, fit, crop, rotate, flip, flop, grayscale, trim, background, format, quality }, \"name\") でできます(format は png・jpeg・webp)。どちらも新しい画像のIDを返し、canvas と合わせて返事や投稿に付くのは10枚までです(絵文字の image・スタンプの file に使う画像は数えません)。";

const RULE_DEBUG = "\n\n既存のルールを直すときや、ルールが動かない理由を調べるときは、list_rules で今のコードを、rule_runs で実行履歴(結果・エラー・log)を確かめてから書きます。";

function systemPrompt(kind: CodeKind): string {
  if (kind === "read") return [...COMMON, "- このコードは読み取りだけです。調べた結果を return します。"].join("\n");
  if (kind === "plan") return [...COMMON, ...PLAN, catalogSummary()].join("\n");
  return [...COMMON, ...RULE, catalogSummary(), "", "イベントの一覧:", triggerSummary()].join("\n");
}

/** The last ```js block in the reply, or the whole reply when it has none. */
export function extractCode(reply: string): string {
  const blocks = [...reply.matchAll(/```(?:js|javascript|ts|typescript)?[^\n]*\n([\s\S]*?)```/g)];
  const code = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : reply;
  return code.trim();
}

function textOf(m: AssistantMessage): string {
  return m.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("")
    .trim();
}

function clip(value: string): string {
  return value.length > MAX_TRY_OUTPUT ? `${value.slice(0, MAX_TRY_OUTPUT)}\n…(長いため省略)` : value;
}

function reply(text: string, extra: { isError?: boolean; terminate?: boolean } = {}) {
  return { content: [{ type: "text" as const, text }], details: {}, ...extra };
}

export function llmCoder(model: Model<Api>, apiKey: string): Coder {
  return {
    label: model.name ?? model.id,
    async write(kind, task, env, signal) {
      let accepted: string | null = null;
      let last: string | null = null;
      let failures = 0;
      let error = "";

      const tryCode: AgentTool<any> = {
        name: "try_code",
        label: "コードを試す",
        description: kind === "rule"
          ? "読み取り専用のコードを今のサーバーで試し、return した値を返します。event を渡すと、そのイベントが起きたものとして動きます。"
          : "読み取り専用のコードを今のサーバーで試し、return した値を返します。",
        parameters: Type.Object({
          code: Type.String({ description: "関数本体" }),
          ...(kind === "rule" ? { event: Type.Optional(Type.Unknown({ description: "試すイベントのペイロード" })) } : {}),
        }),
        execute: async (_id, input) => {
          const params = input as { code: string; event?: unknown };
          const result = await env.run(params.code, params.event);
          const logs = result.logs.length > 0 ? `\nlog:\n${result.logs.join("\n")}` : "";
          if (!result.ok) return reply(`${result.error}${logs}`, { isError: true });
          return reply(clip(`${JSON.stringify(result.value, null, 1)}${logs}`));
        },
      };
      const submitCode: AgentTool<any> = {
        name: "submit_code",
        label: "コードを提出",
        description: "完成したコードを提出します。エラーなら理由が返るので、直して出し直します。",
        parameters: Type.Object({ code: Type.String({ description: "関数本体" }) }),
        execute: async (_id, input) => {
          const params = input as { code: string };
          last = params.code;
          const problem = await env.check(params.code);
          if (problem === null) {
            accepted = params.code;
            return reply("受け付けました。", { terminate: true });
          }
          error = problem;
          if (++failures >= MAX_CODE_ATTEMPTS) return reply(problem, { isError: true, terminate: true });
          return reply(`エラーになりました。直して出し直してください。\n${problem}`, { isError: true });
        },
      };

      const agent = new Agent({
        initialState: {
          systemPrompt: systemPrompt(kind) + (env.tools?.some((t) => t.name === "rule_runs") ? RULE_DEBUG : "") + (env.canvas ? CANVAS : ""),
          model,
          tools: [tryCode, submitCode, ...(env.tools ?? [])], thinkingLevel: lightestThinking(model) ?? "off" },
        getApiKey: () => apiKey,
        toolExecution: "sequential",
        streamFn: (m, context, options) =>
          llm.streamSimple(m, context, { ...options, apiKey, maxTokens: Math.min(MAX_OUTPUT_TOKENS, m.maxTokens || MAX_OUTPUT_TOKENS) }),
      });
      let turns = 0;
      agent.subscribe((event) => {
        if (event.type === "turn_end" && ++turns >= MAX_CODE_TURNS) agent.abort();
      });
      const timeout = signal ?? AbortSignal.timeout(180_000);
      timeout.addEventListener("abort", () => agent.abort(), { once: true });
      await agent.prompt(task);
      await retryFailedCall(agent, () => accepted === null && turns < MAX_CODE_TURNS && !timeout.aborted);

      if (accepted !== null) return { code: accepted, attempts: failures + 1 };
      // A model that answers with a code block instead of calling the tool still gets one check.
      if (failures === 0) {
        const lastMessage = agent.state.messages.findLast((m) => m.role === "assistant") as AssistantMessage | undefined;
        if (lastMessage?.stopReason === "error") throw new CodeFailed(`コード用モデルの呼び出しに失敗しました: ${lastMessage.errorMessage ?? ""}`, last);
        const code = lastMessage ? extractCode(textOf(lastMessage)) : "";
        if (code) {
          const problem = await env.check(code);
          if (problem === null) return { code, attempts: 1 };
          last = code;
          error = problem;
        }
      }
      if (failures >= MAX_CODE_ATTEMPTS) throw new CodeFailed(`コード用モデルが${MAX_CODE_ATTEMPTS}回書き直してもエラーが残りました: ${error}`, last);
      throw new CodeFailed(last ? `コード用モデルが完成させられませんでした: ${error || "手順が多すぎます"}` : "コード用モデルがコードを提出しませんでした", last);
    },
  };
}

/**
 * Parses without running: catches syntax errors in rule code, which only runs on events.
 * The parse happens inside the sandbox too, so rule code is never handed to Node itself.
 */
export async function syntaxError(code: string): Promise<string | null> {
  // Compiling builds the program without running it.
  try {
    await compileJs(code);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "構文エラー";
  }
}
