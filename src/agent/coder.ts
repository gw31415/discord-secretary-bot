import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { lightestThinking, llm } from "../llm/models.ts";
import { catalogSummary } from "../plan/catalog.ts";
import { triggerSummary } from "../rules/triggers.ts";

// A separate model the speaker picked for writing code. The conversation model
// describes what the code should do; the coder writes it and fixes its own errors.
// It sees only the task, never the conversation.

export type CodeKind = "read" | "plan" | "rule";

/** Runs or checks the code; returns null when it is fine, or the error to fix. */
export type CodeCheck = (code: string) => Promise<string | null>;

export interface CodeResult {
  code: string;
  attempts: number;
}

export interface Coder {
  /** The model's name, shown with the code it wrote. */
  label: string;
  write(kind: CodeKind, task: string, check: CodeCheck, signal?: AbortSignal): Promise<CodeResult>;
}

export class CodeFailed extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

export const MAX_CODE_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 8000;

const COMMON = [
  "あなたはDiscordサーバー管理Botのコードを書く係です。依頼に合う JavaScript の関数本体だけを書きます。",
  "- 出力は ```js と ``` で囲んだコードブロック1つだけにします。説明は不要です。",
  "- コードは関数本体として実行され、最後に return した値が結果になります。async/await・Promise・タイマー・ネットワーク・乱数・import はありません。",
  "- 使えるもの: guild(サーバーIDの文字列), actor, discord.get(route, { query }) (同期関数。Discord REST API の GET を読み、JSONを返す。例: discord.get(`/guilds/${guild}/roles`)), log(...)。",
  "- 読める経路は Discord REST API の GET のうち許可されたものだけで、結果は権限と公開範囲に合わせて絞られます。ボイスチャンネルの在室者は discord.get(`/guilds/${guild}/voice-states`) で [{ user_id, channel_id }] として読めます。",
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
  "- このコードはイベントルールで、決まったイベントが起きるたびに動きます。event は発火したイベントのペイロード、params はルールと一緒に登録された値です。",
  "- 変更がなければ return null、あれば return plan([call(op, { id?, path, body }), ...]) を返します。前のステップの結果は { $ref: \"steps.<id>.result.id\" } で参照できます。",
  "- 実行は1回10秒・discord.get 50回までです。",
  "- 返すステップは依頼にある「許す操作」に合うものだけにします。合わないステップは実行されません。",
  "",
  "使える操作:",
];

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

export function llmCoder(model: Model<Api>, apiKey: string): Coder {
  return {
    label: model.name ?? model.id,
    async write(kind, task, check, signal) {
      const reasoning = lightestThinking(model);
      const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
      let last: string | null = null;
      let error = "";
      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        const res = await llm.completeSimple(
          model,
          { systemPrompt: systemPrompt(kind), messages },
          { apiKey, signal: signal ?? AbortSignal.timeout(120_000), maxTokens: Math.min(MAX_OUTPUT_TOKENS, model.maxTokens || MAX_OUTPUT_TOKENS), ...(reasoning ? { reasoning } : {}) },
        );
        if (res.stopReason === "error") throw new CodeFailed(`コード用モデルの呼び出しに失敗しました: ${res.errorMessage ?? ""}`, last);
        const code = extractCode(textOf(res));
        if (!code) throw new CodeFailed("コード用モデルがコードを返しませんでした", last);
        last = code;
        const problem = await check(code);
        if (problem === null) return { code, attempts: attempt };
        error = problem;
        messages.push(res, { role: "user", content: `実行するとエラーになりました。直したコードを書いてください。\n${problem}`, timestamp: Date.now() });
      }
      throw new CodeFailed(`コード用モデルが${MAX_CODE_ATTEMPTS}回書き直してもエラーが残りました: ${error}`, last);
    },
  };
}

/** Parses without running: catches syntax errors in rule code, which only runs on events. */
export function syntaxError(code: string): string | null {
  try {
    // Constructing a Function only compiles it; the body never runs here.
    new Function("event", "params", "guild", "actor", "discord", "call", "plan", "log", code);
    return null;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}
