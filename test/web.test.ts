import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebTool, pickMcpTool, resolveWebAccess, webToolWarning, webTools, ZAI_MCP } from "../src/agent/web.ts";
import type { KeyProviderId } from "../src/llm/models.ts";

const keys = (map: Partial<Record<KeyProviderId, string>>) => (p: KeyProviderId) => map[p];

test("the web choice resolves against the response model and the person's keys", () => {
  assert.deepEqual(resolveWebAccess("auto", "anthropic", keys({})), { kind: "anthropic" });
  assert.deepEqual(resolveWebAccess("auto", "zai", keys({ zai: "z" })), { kind: "zai", apiKey: "z" });
  assert.deepEqual(resolveWebAccess("auto", "openai", keys({})), { kind: "openai" });
  assert.equal(resolveWebAccess("auto", "openrouter", keys({ tavily: "t" })), null, "no standard web tool");
  assert.equal(resolveWebAccess("auto", "zai", keys({})), null);
  assert.deepEqual(resolveWebAccess("tavily", "anthropic", keys({ tavily: "t" })), { kind: "tavily", apiKey: "t" });
  assert.equal(resolveWebAccess("tavily", "anthropic", keys({})), null);
  assert.deepEqual(resolveWebAccess("zai", "anthropic", keys({ zai: "z" })), { kind: "zai", apiKey: "z" }, "GLM's tools work with Claude too");
  assert.equal(resolveWebAccess("off", "anthropic", keys({ tavily: "t" })), null);
  assert.equal(webToolWarning("tavily", "anthropic", new Set()), "Tavilyのキーがないので、Webを使いません。");
  assert.equal(webToolWarning("tavily", "anthropic", new Set(["tavily"])), null);
  assert.equal(webToolWarning("auto", "openai", new Set()), null);
  assert.match(webToolWarning("auto", "openrouter", new Set()) ?? "", /標準のWebツールがない/);
  assert.match(webToolWarning("auto", "zai", new Set()) ?? "", /GLM Coding Planのキーがない/);
});

test("Claude's and OpenAI's web tools run on their servers, so the bot adds no tools of its own", () => {
  assert.deepEqual(webTools({ kind: "anthropic" }), []);
  assert.deepEqual(webTools({ kind: "openai" }), []);
  assert.ok(!isWebTool("anthropic"), "Claude is not a choice of its own");
  assert.ok(!isWebTool("openai"));
});

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

test("Tavily search and extract go out with the person's key", async () => {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    if (url.endsWith("/search")) return json({ results: [{ title: "Node.js 26", url: "https://nodejs.org/", content: "released" }] });
    return json({ results: [{ url: "https://nodejs.org/", raw_content: "# Node.js" }], failed_results: [] });
  }) as typeof fetch;
  const [search, read] = webTools({ kind: "tavily", apiKey: "tvly-key" }, fake);
  const found = await search!.execute("1", { query: "node 26" });
  assert.match((found.content[0] as { text: string }).text, /Node\.js 26\n  https:\/\/nodejs\.org\/\n  released/);
  const page = await read!.execute("2", { url: "https://nodejs.org/" });
  assert.equal((page.content[0] as { text: string }).text, "# Node.js");
  assert.deepEqual(calls.map((c) => c.url), ["https://api.tavily.com/search", "https://api.tavily.com/extract"]);
  assert.ok(calls.every((c) => c.auth === "Bearer tvly-key"));
  await assert.rejects(read!.execute("3", { url: "file:///etc/passwd" }), /http か https/);
});

test("GLM's web tools are called over MCP, with the argument name taken from the tool list", async () => {
  const methods: string[] = [];
  let session: string | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    methods.push(body.method);
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "s1" });
    session = headers.get("mcp-session-id");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "webSearchPrime", inputSchema: { properties: { search_query: {} }, required: ["search_query"] } }] } });
    }
    assert.equal(url, ZAI_MCP.search.url);
    assert.deepEqual(body.params, { name: "webSearchPrime", arguments: { search_query: "glm" } });
    const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "結果" }] } })}\n\n`;
    return new Response(event, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const [search] = webTools({ kind: "zai", apiKey: "z" }, fake);
  const out = await search!.execute("1", { query: "glm" });
  assert.equal((out.content[0] as { text: string }).text, "結果");
  assert.equal(session, "s1");
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  // The argument name is remembered, so the list is not asked again.
  methods.length = 0;
  await search!.execute("2", { query: "glm" });
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
});

test("an MCP tool is found despite case and separator differences in its published name", () => {
  const tools = [{ name: "web_search_prime" }, { name: "other" }];
  assert.equal(pickMcpTool(tools, "webSearchPrime")?.name, "web_search_prime");
  assert.equal(pickMcpTool([{ name: "search" }], "webSearchPrime")?.name, "search", "a server with one tool");
  assert.equal(pickMcpTool(tools, "webReader"), undefined);
});
