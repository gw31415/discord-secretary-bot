import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { KeyProviderId, ProviderId } from "../llm/models.ts";

// Web access for the agent. Each person picks the service in /settings; the keys are theirs.
// Claude's own tools run on Anthropic's servers. The others are ordinary tools the bot
// calls, so they work with any model: GLM Coding Plan's Web Search / Web Reader MCP
// servers, and Tavily's search and extract API.

export const WEB_TOOLS = {
  auto: { label: "応答モデルの標準", description: "ClaudeならClaudeの検索、GLMならGLMの検索を使います" },
  anthropic: { label: "Claude", description: "Claudeのサーバー側の検索と取得。応答モデルがClaudeのときだけ使えます" },
  zai: { label: "GLM Coding Plan", description: "GLMのWeb Search / Web Reader。GLM Coding Planのキーが要ります" },
  tavily: { label: "Tavily", description: "どのモデルでも使えます。Tavilyのキーが要ります(月1,000回まで無料)" },
  off: { label: "使わない", description: "BotはWebを調べません" },
} as const;

export type WebTool = keyof typeof WEB_TOOLS;

export function isWebTool(value: string): value is WebTool {
  return Object.hasOwn(WEB_TOOLS, value);
}

export type WebAccess =
  | { kind: "anthropic" }
  | { kind: "zai"; apiKey: string }
  | { kind: "tavily"; apiKey: string };

/**
 * What the agent may use for this answer. Null when the choice does not fit the
 * response model or its key is missing; panelWarning() tells the person why.
 */
export function resolveWebAccess(choice: WebTool, model: ProviderId, keyOf: (p: KeyProviderId) => string | undefined): WebAccess | null {
  const tool = choice === "auto" ? (model === "anthropic" ? "anthropic" : model === "zai" ? "zai" : "off") : choice;
  switch (tool) {
    case "anthropic":
      return model === "anthropic" ? { kind: "anthropic" } : null;
    case "zai":
    case "tavily": {
      const apiKey = keyOf(tool);
      return apiKey ? { kind: tool, apiKey } : null;
    }
    default:
      return null;
  }
}

/** Why the chosen web tool will not work with these settings, or null if it will. */
export function webToolWarning(choice: WebTool, model: ProviderId | undefined, keys: ReadonlySet<KeyProviderId>): string | null {
  if (choice === "off" || !model) return null;
  if (choice === "anthropic" && model !== "anthropic") return "応答モデルがClaudeではないため、Webは使われません。";
  if (choice === "zai" && !keys.has("zai")) return "GLM Coding Planのキーがないため、Webは使われません。";
  if (choice === "tavily" && !keys.has("tavily")) return "Tavilyのキーがないため、Webは使われません。";
  return null;
}

/** Anthropic server tools, added to the raw request. pi-ai keeps only the final text. */
export const ANTHROPIC_WEB_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
] as const;

const MAX_OUTPUT = 15_000;
const TIMEOUT_MS = 30_000;

function text(value: string) {
  const body = value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n…(長いため省略)` : value;
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

const searchParams = Type.Object({
  query: Type.String({ description: "検索語" }),
});
const fetchParams = Type.Object({
  url: Type.String({ description: "読むページのURL(http/https)" }),
});

const SEARCH_DESCRIPTION = "Webを検索し、ページのタイトル・URL・要約を返します。最新の情報やサーバーの外の情報が必要なときに使います。";
const FETCH_DESCRIPTION = "指定したURLのページを読み、本文を返します。検索結果や会話に出たURLの中身を確かめるときに使います。";

function checkUrl(url: string): void {
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new Error("http か https のURLだけ読めます");
}

/** The agent's web_search and web_fetch tools for services the bot calls itself. */
export function webTools(access: WebAccess, fetchImpl: typeof fetch = fetch): AgentTool<any>[] {
  if (access.kind === "anthropic") return [];
  const service = access.kind === "zai" ? zaiService(access.apiKey, fetchImpl) : tavilyService(access.apiKey, fetchImpl);
  const search: AgentTool<typeof searchParams> = {
    name: "web_search",
    label: "Web検索",
    description: SEARCH_DESCRIPTION,
    parameters: searchParams,
    execute: async (_id, params, signal) => text(await service.search(params.query, signal)),
  };
  const read: AgentTool<typeof fetchParams> = {
    name: "web_fetch",
    label: "ページを読む",
    description: FETCH_DESCRIPTION,
    parameters: fetchParams,
    execute: async (_id, params, signal) => {
      checkUrl(params.url);
      return text(await service.fetch(params.url, signal));
    },
  };
  return [search, read];
}

interface WebService {
  search(query: string, signal?: AbortSignal): Promise<string>;
  fetch(url: string, signal?: AbortSignal): Promise<string>;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// --- Tavily ---------------------------------------------------------------

const TAVILY = "https://api.tavily.com";

interface TavilySearchResponse {
  results: { title: string; url: string; content: string; published_date?: string }[];
}

interface TavilyExtractResponse {
  results: { url: string; raw_content: string }[];
  failed_results?: { url: string; error: string }[];
}

function tavilyService(apiKey: string, fetchImpl: typeof fetch): WebService {
  const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await fetchImpl(`${TAVILY}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: withTimeout(signal),
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("Tavilyのキーが無効です");
      if (res.status === 432 || res.status === 433) throw new Error("Tavilyの利用上限に達しました");
      throw new Error(`Tavilyがエラーを返しました(${res.status})`);
    }
    return (await res.json()) as T;
  };
  return {
    async search(query, signal) {
      const data = await post<TavilySearchResponse>("/search", { query, max_results: 8, search_depth: "basic" }, signal);
      if (data.results.length === 0) return "見つかりませんでした。";
      return data.results
        .map((r) => [`- ${r.title}`, `  ${r.url}${r.published_date ? ` (${r.published_date})` : ""}`, `  ${r.content.replaceAll("\n", " ")}`].join("\n"))
        .join("\n");
    },
    async fetch(url, signal) {
      const data = await post<TavilyExtractResponse>("/extract", { urls: [url], format: "markdown" }, signal);
      const page = data.results[0];
      if (!page) throw new Error(`読めませんでした: ${data.failed_results?.[0]?.error ?? "不明な理由"}`);
      return page.raw_content;
    },
  };
}

// --- GLM Coding Plan (remote MCP over streamable HTTP) ----------------------

export const ZAI_MCP = {
  search: { url: "https://api.z.ai/api/mcp/web_search_prime/mcp", tool: "webSearchPrime" },
  read: { url: "https://api.z.ai/api/mcp/web_reader/mcp", tool: "webReader" },
} as const;

function zaiService(apiKey: string, fetchImpl: typeof fetch): WebService {
  return {
    search: (query, signal) => callMcpTool(ZAI_MCP.search, apiKey, query, fetchImpl, signal),
    fetch: (url, signal) => callMcpTool(ZAI_MCP.read, apiKey, url, fetchImpl, signal),
  };
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

const PROTOCOL_VERSION = "2025-06-18";

/** A JSON-RPC exchange over MCP streamable HTTP, which may answer as JSON or as a server-sent event stream. */
async function rpc(
  url: string,
  apiKey: string,
  body: { id?: number; method: string; params?: unknown },
  session: { id?: string },
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session.id ? { "mcp-session-id": session.id, "mcp-protocol-version": PROTOCOL_VERSION } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("GLM Coding Planのキーが無効か、Web検索を使えないプランです");
    throw new Error(`GLMのWebツールがエラーを返しました(${res.status})`);
  }
  session.id ??= res.headers.get("mcp-session-id") ?? undefined;
  if (body.id === undefined) return undefined; // a notification
  const raw = await res.text();
  const messages: JsonRpcResponse[] = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()) as JsonRpcResponse)
    : [JSON.parse(raw) as JsonRpcResponse];
  const reply = messages.find((m) => m.id === body.id);
  if (!reply) throw new Error("GLMのWebツールから応答がありませんでした");
  if (reply.error) throw new Error(`GLMのWebツールがエラーを返しました: ${reply.error.message}`);
  return reply.result;
}

interface McpTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface McpCallResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

// The servers do not document their tool schemas, and the published tool names have
// drifted from the docs (webSearchPrime), so the tool and its first required argument
// are read from tools/list once per server and remembered.
const resolved = new Map<string, { name: string; argument: string }>();

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The listed tool meant by `wanted`: the same name ignoring case and separators, else the only tool. */
export function pickMcpTool(tools: McpTool[], wanted: string): McpTool | undefined {
  return tools.find((t) => t.name === wanted) ?? tools.find((t) => normalize(t.name) === normalize(wanted)) ?? (tools.length === 1 ? tools[0] : undefined);
}

async function callMcpTool(
  target: { url: string; tool: string },
  apiKey: string,
  value: string,
  fetchImpl: typeof fetch,
  outer?: AbortSignal,
): Promise<string> {
  const signal = withTimeout(outer);
  const session: { id?: string } = {};
  await rpc(target.url, apiKey, {
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "discord-secretary-bot", version: "0.1.0" } },
  }, session, fetchImpl, signal);
  await rpc(target.url, apiKey, { method: "notifications/initialized" }, session, fetchImpl, signal);

  let tool = resolved.get(target.url);
  if (!tool) {
    const list = (await rpc(target.url, apiKey, { id: 2, method: "tools/list" }, session, fetchImpl, signal)) as { tools?: McpTool[] };
    const tools = list.tools ?? [];
    const found = pickMcpTool(tools, target.tool);
    if (!found) throw new Error(`GLMのWebツール ${target.tool} が見つかりません(あるのは ${tools.map((t) => t.name).join(", ") || "なし"})`);
    const schema = found.inputSchema ?? {};
    const argument = schema.required?.[0] ?? Object.keys(schema.properties ?? {})[0];
    if (!argument) throw new Error(`GLMのWebツール ${found.name} の引数がわかりません`);
    tool = { name: found.name, argument };
    resolved.set(target.url, tool);
  }

  const result = (await rpc(target.url, apiKey, {
    id: 3,
    method: "tools/call",
    params: { name: tool.name, arguments: { [tool.argument]: value } },
  }, session, fetchImpl, signal)) as McpCallResult;
  const body = (result.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
  if (result.isError) throw new Error(body || "GLMのWebツールが失敗しました");
  return body || "結果がありませんでした。";
}
