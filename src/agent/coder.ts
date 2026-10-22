import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { lightestThinking, llm } from "../llm/models.ts";
import { catalogSummary } from "../plan/catalog.ts";
import { triggerSummary } from "../rules/triggers.ts";
import { runSandboxed } from "../sandbox.ts";

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
  "- 返すステップは依頼にある「許す操作」に合うものだけにします。合わないステップは実行されません。許す操作で { madeInRun: true } のフィールドには、同じ回の前のステップを指す { $ref: \"steps.<id>.result.id\" } を入れます。",
  "",
  "使える操作:",
];

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
          systemPrompt: systemPrompt(kind) + (env.tools?.some((t) => t.name === "rule_runs") ? RULE_DEBUG : ""),
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
  // Defining the function compiles its body without calling it.
  const result = await runSandboxed(
    `return typeof function (event, params) {\n${code}\n};`,
    { guildId: "0", actor: { kind: "user", userId: "0" }, get: async () => { throw new Error("構文チェック中は読めません"); } },
    { wallTimeMs: 2_000, memoryBytes: 16 * 1024 * 1024, maxGets: 0 },
  );
  return result.ok ? null : (result.error ?? "構文エラー");
}
