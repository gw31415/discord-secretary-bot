import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MEMORY_PAGES, ModuleRejected, prepareModule } from "../src/wasm/module.ts";
import { execute, runModule, warmUp } from "../src/wasm/run.ts";

// Small modules written out byte by byte, so the tests need no Wasm toolchain.

function u32(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
/** i32.const takes a signed LEB128. */
function i32(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) return [0x41, ...out, b];
    out.push(b | 0x80);
  }
}
const str = (s: string) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
const section = (id: number, body: number[]) => [id, ...u32(body.length), ...body];
const vec = (items: number[][]) => [...u32(items.length), ...items.flat()];
const I32 = 0x7f;

interface Spec {
  types: Array<[number[], number[]]>;
  imports?: Array<[string, string, number]>;
  /** [min, max?] in pages. */
  memory?: [number, number?];
  exports?: Array<[string, number, number]>;
  /** Function bodies (type index, locals, code) after the imports. */
  funcs?: Array<[number, number[]]>;
  data?: Array<[number, string]>;
}

function wasm(spec: Spec): Uint8Array {
  const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  bytes.push(...section(1, vec(spec.types.map(([p, r]) => [0x60, ...vec(p.map((t) => [t])), ...vec(r.map((t) => [t]))]))));
  if (spec.imports) bytes.push(...section(2, vec(spec.imports.map(([m, n, t]) => [...str(m), ...str(n), 0, ...u32(t)]))));
  if (spec.funcs) bytes.push(...section(3, vec(spec.funcs.map(([t]) => u32(t)))));
  if (spec.memory) bytes.push(...section(5, vec([spec.memory[1] === undefined ? [0, ...u32(spec.memory[0])] : [1, ...u32(spec.memory[0]), ...u32(spec.memory[1])]])));
  if (spec.exports) bytes.push(...section(7, vec(spec.exports.map(([n, kind, i]) => [...str(n), kind, ...u32(i)]))));
  if (spec.funcs) bytes.push(...section(10, vec(spec.funcs.map(([, code]) => { const body = [0, ...code, 0x0b]; return [...u32(body.length), ...body]; }))));
  if (spec.data) bytes.push(...section(11, vec(spec.data.map(([at, s]) => [0, ...i32(at), 0x0b, ...str(s)]))));
  return Uint8Array.from(bytes);
}

const LOOP = [0x03, 0x40, 0x0c, 0x00, 0x0b]; // loop br 0 end

test("checks uploads and caps their memory", async () => {
  const ok = await prepareModule(wasm({ types: [[[], []]], memory: [1], funcs: [[0, []]], exports: [["_start", 0, 0], ["memory", 2, 0]] }));
  assert.deepEqual(ok.info.memory, { min: 1, max: MAX_MEMORY_PAGES });
  const declared = await prepareModule(wasm({ types: [[[], []]], memory: [1, 4], funcs: [[0, []]], exports: [["_start", 0, 0], ["memory", 2, 0]] }));
  assert.deepEqual(declared.info.memory, { min: 1, max: 4 });

  const rejects = async (spec: Spec, pattern: RegExp) => {
    await assert.rejects(prepareModule(wasm(spec)), (e: unknown) => e instanceof ModuleRejected && pattern.test(e.message));
  };
  await rejects({ types: [[[], []]], memory: [MAX_MEMORY_PAGES + 1], funcs: [[0, []]], exports: [["_start", 0, 0], ["memory", 2, 0]] }, /初期サイズ/);
  await rejects({ types: [[[], []]], imports: [["env", "open", 0]], memory: [1], funcs: [[0, []]], exports: [["_start", 0, 1], ["memory", 2, 0]] }, /env\.open/);
  await rejects({ types: [[[], []]], memory: [1], funcs: [[0, []]], exports: [["main", 0, 0], ["memory", 2, 0]] }, /_start/);
  await assert.rejects(prepareModule(Buffer.from("not wasm")), /Wasmのバイナリではありません/);
});

test("a module runs once, reaches the host only through secretary.call, and is stopped when time is up", async () => {
  const request = JSON.stringify({ fn: "get", route: "/guilds/1" });
  // _start: n = secretary.call(0, len, 1024, 4096); iovec at 512 = { 1024, n }; fd_write(1, 512, 1, 600)
  const echo = await prepareModule(
    wasm({
      types: [[[I32, I32, I32, I32], [I32]], [[], []]],
      imports: [["secretary", "call", 0], ["wasi_snapshot_preview1", "fd_write", 0]],
      memory: [1],
      funcs: [[1, [
        ...i32(512), ...i32(1024), 0x36, 2, 0, // i32.store [512] = 1024
        ...i32(516), ...i32(0), ...i32(request.length), ...i32(1024), ...i32(4096), 0x10, 0, 0x36, 2, 0, // [516] = call(...)
        ...i32(1), ...i32(512), ...i32(1), ...i32(600), 0x10, 1, 0x1a, // fd_write(...); drop
      ]]],
      exports: [["_start", 0, 2], ["memory", 2, 0]],
      data: [[0, request]],
    }),
  );
  const module = await WebAssembly.compile(echo.bytes);
  const asked: string[] = [];
  const run = await execute(module, new Uint8Array(), async (r) => (asked.push(r), JSON.stringify({ value: { name: "鯖" } })), 5000);
  assert.deepEqual(asked, [request]);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(JSON.parse(run.stdout.toString()), { value: { name: "鯖" } });

  const spin = await prepareModule(wasm({ types: [[[], []]], memory: [1], funcs: [[0, LOOP]], exports: [["_start", 0, 0], ["memory", 2, 0]] }));
  const started = Date.now();
  const r = await runModule({ module: await WebAssembly.compile(spin.bytes) }, { guildId: "1", actor: { kind: "user", userId: "2" }, get: async () => null }, { wallTimeMs: 300, maxGets: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /上限/);
  assert.ok(Date.now() - started < 3000);
});

test("a module is warmed up once, and a warm-up that never ends is cut short", async () => {
  const spin = await WebAssembly.compile((await prepareModule(wasm({ types: [[[], []]], memory: [1], funcs: [[0, LOOP]], exports: [["_start", 0, 0], ["memory", 2, 0]] }))).bytes);
  let started = Date.now();
  await warmUp({ module: spin });
  const took = Date.now() - started;
  assert.ok(took >= 1500 && took < 4000, `took ${took}ms`);
  started = Date.now();
  await warmUp({ module: spin });
  assert.ok(Date.now() - started < 100);
  // A warmed module still runs as usual.
  const out = await WebAssembly.compile(printer(JSON.stringify({ steps: [] })));
  await warmUp({ module: out });
  const r = await runModule({ module: out }, { guildId: "1", actor: { kind: "user", userId: "2" }, get: async () => null }, { wallTimeMs: 5000, maxGets: 1 });
  assert.deepEqual(r.value, { steps: [] });
});

test("rule code compiles to bytecode once and runs from it", async () => {
  const { compileJs, jsProgram, setBytecodeCache, SANDBOX_LIMITS } = await import("../src/sandbox.ts");
  await assert.rejects(compileJs("return )"), /SyntaxError/);
  const kept = new Map<string, Buffer>();
  setBytecodeCache({ get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v) });
  try {
    const bindings = { guildId: "1", actor: { kind: "user" as const, userId: "2" }, get: async () => ({ n: 3 }), state: null };
    const code = "return plan([call('POST /channels/{channel}/messages', { path: { channel: '9' }, body: { content: String(discord.get('/x').n) } })])";
    const first = await runModule(await jsProgram(code), bindings, SANDBOX_LIMITS);
    assert.equal(kept.size, 1);
    const second = await runModule(await jsProgram(code), bindings, SANDBOX_LIMITS);
    assert.deepEqual(first.value, second.value);
    assert.equal((second.value as { steps: Array<{ body: { content: string } }> }).steps[0]!.body.content, "3");
  } finally {
    setBytecodeCache(null);
  }
});

/** A module that prints `output` and nothing else. */
function printer(output: string): Uint8Array {
  return wasm({
    types: [[[I32, I32, I32, I32], [I32]], [[], []]],
    imports: [["wasi_snapshot_preview1", "fd_write", 0]],
    memory: [1],
    funcs: [[1, [
      ...i32(512), ...i32(1024), 0x36, 2, 0,
      ...i32(516), ...i32(Buffer.byteLength(output)), 0x36, 2, 0,
      ...i32(1), ...i32(512), ...i32(1), ...i32(600), 0x10, 0, 0x1a,
    ]]],
    exports: [["_start", 0, 1], ["memory", 2, 0]],
    data: [[1024, output]],
  });
}

test("an uploaded module runs a rule as its owner, pinned to its build; others in the server may use it too", async () => {
  const { randomBytes } = await import("node:crypto");
  const { Store } = await import("../src/db.ts");
  const { GuildCache } = await import("../src/discord/cache.ts");
  const { RuleAdmin } = await import("../src/rules/admin.ts");
  const { RuleEngine } = await import("../src/rules/engine.ts");
  const { DEFAULT_LIMITS } = await import("../src/rules/types.ts");
  const { WasmRegistry } = await import("../src/wasm/registry.ts");
  const { GUILD, makeGuild, SELF } = await import("./helpers.ts");

  const store = new Store(":memory:", randomBytes(32));
  const cache = new GuildCache(GUILD);
  cache.guild = makeGuild();
  const caches = { get: (id: string | undefined) => (id === GUILD ? cache : undefined) };
  const registry = new WasmRegistry(store);
  const runs: any[] = [];
  const engine = new RuleEngine({
    store,
    caches,
    planner: { runForRule: async (input) => (runs.push(input), { plan: { id: "p1" }, status: "succeeded", reason: null }) as never },
    selfId: () => SELF,
    now: () => 1_000_000,
    makeReader: () => ({ get: async () => null }) as never,
    log: () => {},
    wasm: registry,
  });
  const step = { op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "from wasm" } };
  const { module: v1 } = await registry.upload("1", "greeter.wasm", printer(JSON.stringify({ steps: [step], state: { n: 1 } })));
  assert.equal(v1.name, "greeter");
  assert.equal(registry.resolve("1", cache.guild, "greeter").sha256, v1.sha256);
  // Someone else in the server names it by its sha256; a stranger's module stays out of reach.
  assert.equal(registry.resolve("2", cache.guild, v1.sha256.slice(0, 12)).sha256, v1.sha256);
  assert.throws(() => registry.resolve("2", cache.guild, "greeter"), /見つかりません/);

  const admin = new RuleAdmin({ store, caches, selfId: () => SELF, now: () => 1_000_000 });
  const rule = admin.save(GUILD, "1", {
    name: "wasm",
    sourcePrompt: "",
    trigger: { event: "MESSAGE_CREATE" },
    allow: [{ op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } } }],
    program: { kind: "wasm", sha256: v1.sha256 },
    summary: null,
    limits: DEFAULT_LIMITS,
  });
  assert.deepEqual(store.getRule(rule.id)!.program, { kind: "wasm", sha256: v1.sha256 });

  engine.dispatch("MESSAGE_CREATE", GUILD, { id: "700", channel_id: "10", guild_id: GUILD, content: "hi", author: { id: "3" } });
  await engine.idle();
  assert.equal(runs.length, 1, JSON.stringify(store.recentRuleRuns(rule.id, 1)));
  assert.equal(runs[0].actorId, "1");
  assert.deepEqual(runs[0].drafts, [step]);
  assert.deepEqual(store.getRuleState(rule.id), { n: 1 });

  // A new build under the same name leaves the old one in place while a rule runs it.
  const { module: v2, replaced } = await registry.upload("1", "greeter", printer("{}"));
  assert.equal(replaced, 0);
  assert.equal(registry.resolve("1", cache.guild, "greeter").sha256, v2.sha256);
  assert.throws(() => registry.remove("1", v1.sha256), /使っているので消せません/);
  assert.equal(registry.remove("1", v2.sha256).sha256, v2.sha256);
});

test("a .wasm attached to a message is pointed out to the agent", async () => {
  const { formatMessage } = await import("../src/agent/tools.ts");
  const line = formatMessage({ id: "1", timestamp: "2026-10-23T05:00:00Z", author: { id: "2", username: "a" }, content: "これを /hello にしたい", attachments: [{ id: "3", filename: "hello.wasm", size: 2048, url: "", proxy_url: "" }], embeds: [] } as never);
  assert.match(line, /hello\.wasm\(Wasmモジュール 2KB、register_wasm で登録できる\)/);
});

test("run_wasm runs an attached or kept module once, read-only, and points steps at propose_plan", async () => {
  const { readTools } = await import("../src/agent/tools.ts");
  const step = { op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "hi" } };
  const bytes = printer(JSON.stringify({ steps: [step] }));
  const message = { id: "5", author: { id: "9" }, attachments: [{ id: "a", filename: "post.wasm", size: bytes.length, url: "https://cdn/post.wasm" }] };
  const reader = { guild: { id: "1" }, scope: { speakerId: "1", channelId: "10" }, get: async (route: string) => (route === "/channels/10/messages/5" ? message : null) } as never;
  const loaded: string[] = [];
  const tools = readTools(reader, {
    images: false,
    fetch: (async () => new Response(bytes)) as never,
    rules: {
      list: () => [],
      runs: () => null,
      wasm: {
        list: () => [],
        upload: async () => { throw new Error("not here"); },
        load: async (ref: string) => (loaded.push(ref), { module: await WebAssembly.compile(bytes), name: "post", sha256: "ab".repeat(32) }),
      },
    },
  });
  const run = tools.find((t) => t.name === "run_wasm")!;
  const fromAttachment = await run.execute("t", { message_id: "5" });
  const shown = (fromAttachment.content[0] as { text: string }).text;
  assert.match(shown, /post\.wasm.*終了コード 0/);
  assert.match(shown, /"op":"POST \/channels\/\{channel\}\/messages"/);
  assert.match(shown, /変更の提案が 1 件/);
  const fromModule = await run.execute("t", { module: "post" });
  assert.match((fromModule.content[0] as { text: string }).text, /post\(abababababab\) 終了コード 0/);
  assert.deepEqual(loaded, ["post"]);
  await assert.rejects(run.execute("t", {}), /message_id・module・compiled/);
});

test("rules saved before programs were a union read as a JS or a Wasm program", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomBytes } = await import("node:crypto");
  const { Store } = await import("../src/db.ts");
  const path = join(mkdtempSync(join(tmpdir(), "rules-")), "bot.db");
  const key = randomBytes(32);
  let store = new Store(path, key);
  const version = store.db.pragma("user_version", { simple: true }) as number;
  const insert = store.db.prepare("INSERT INTO rules (id, guild_id, owner_id, name, rule_json, version, enabled, consecutive_failures, created_at, updated_at) VALUES (?, '1', '2', ?, ?, 1, 1, 0, '', '')");
  const old = { sourcePrompt: "", trigger: { event: "MESSAGE_CREATE" }, allow: [], summary: null, limits: { perMinute: 10, maxConsecutiveFailures: 5 } };
  insert.run("js", "js", JSON.stringify({ ...old, name: "js", code: "return null" }));
  insert.run("wasm", "wasm", JSON.stringify({ ...old, name: "wasm", code: "", wasm: "ab".repeat(32) }));
  store.db.pragma(`user_version = ${version - 1}`);
  store.close();
  store = new Store(path, key);
  try {
    assert.deepEqual(store.getRule("js")!.program, { kind: "js", code: "return null" });
    assert.deepEqual(store.getRule("wasm")!.program, { kind: "wasm", sha256: "ab".repeat(32) });
    assert.equal("code" in store.getRule("wasm")!, false);
    assert.deepEqual(store.enabledRuleCode(), ["return null"]);
    assert.deepEqual(store.wasmInUse(), ["ab".repeat(32)]);
  } finally {
    store.close();
  }
});

/** A stand-in for wasm-compiler on a Unix socket: answers like the service does. */
async function fakeCompiler(answer: (body: { language: string; files: Array<{ path: string; content: string }> }) => object) {
  const { createServer } = await import("node:http");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const socket = join(mkdtempSync(join(tmpdir(), "wasmc-")), "c.sock");
  const requests: Array<{ language: string; files: Array<{ path: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/languages") return res.end(JSON.stringify({ languages: [{ id: "rust", name: "Rust", version: "1+abc", entry: ["src/main.rs"], extensions: [".rs"], paths: "^src/([a-z0-9_]+/)*[a-z0-9_]+\\.rs$", maxFiles: 32, libraries: ["serde_json"], ready: true }, { id: "zig", name: "Zig", version: "1", entry: ["main.zig"], extensions: [".zig"], paths: "^main\\.zig$", maxFiles: 1, libraries: [], ready: false }] }));
      if (req.url === "/v1/languages/rust/guide") return res.end("# Rust でモジュールを書く");
      if (req.url === "/v1/compile") {
        const body = JSON.parse(raw);
        requests.push(body);
        return res.end(JSON.stringify(answer(body)));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "そのAPIはありません" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, requests, close: () => server.close() };
}

test("a module built from source is checked, held for a while, and kept with its sources", async () => {
  const { randomBytes } = await import("node:crypto");
  const { Store } = await import("../src/db.ts");
  const { WasmRegistry, wasmRef } = await import("../src/wasm/registry.ts");
  const { CompilerClient, CompilerUnavailable } = await import("../src/wasm/compiler.ts");
  const built = printer(JSON.stringify({ reply: "hi" }));
  const fake = await fakeCompiler((body) =>
    body.files[0]!.content.includes("broken")
      ? { ok: false, stage: "compile", diagnostics: [{ file: "src/main.rs", line: 2, col: 5, severity: "error", message: "mismatched types" }], log: "src/main.rs:2:5: error[E0308]: mismatched types", durationMs: 100, cached: false, language: "rust", version: "1+abc" }
      : { ok: true, wasm: Buffer.from(built).toString("base64"), sha256: "x", log: "", durationMs: 900, cached: false, language: "rust", version: "1+abc" },
  );
  try {
    const client = new CompilerClient(fake.socket);
    assert.deepEqual((await client.refresh()).map((l) => l.id), ["rust", "zig"]);
    assert.deepEqual(client.languages().map((l) => l.id), ["rust"]); // not set up: left out
    assert.match(await client.guide("rust"), /Rust/);
    const store = new Store(":memory:", randomBytes(32));
    const registry = new WasmRegistry(store, client);
    const files = [{ path: "src/main.rs", content: "fn main() {}" }];

    const failed = await registry.compile("7", "rust", [{ path: "src/main.rs", content: "broken" }]);
    assert.ok(!failed.ok);
    assert.deepEqual(failed.diagnostics.map((d) => `${d.file}:${d.line}`), ["src/main.rs:2"]);

    const ok = await registry.compile("7", "rust", files);
    assert.ok(ok.ok);
    const sha = ok.module.info.sha256;
    // Checked like an upload: the memory cap is written in, so the hash is of the kept bytes.
    assert.equal(ok.module.info.memory.max, MAX_MEMORY_PAGES);
    assert.equal(registry.fresh("7", sha.slice(0, 12)).bytes.length, ok.module.bytes.length);
    // Only the person who built it can use it before it is kept.
    assert.throws(() => registry.fresh("8", sha), ModuleRejected);
    // Nothing is kept until asked.
    assert.deepEqual(registry.list("7"), []);
    const { module } = await registry.uploadCompiled("7", "pins", sha);
    assert.deepEqual(module.source, { language: "rust", files: 1 });
    assert.deepEqual(registry.source(sha), { language: "rust", version: "1+abc", files });
    assert.deepEqual(wasmRef(module, registry.source(sha)).source, { language: "rust", files });
    // A plain upload of the same bytes keeps the sources it already has.
    await registry.upload("7", "pins", ok.module.bytes);
    assert.deepEqual(registry.list("7")[0]!.source, { language: "rust", files: 1 });

    // The service being away is said plainly.
    const away = new WasmRegistry(store, new CompilerClient("/nonexistent/c.sock"));
    await assert.rejects(away.compile("7", "rust", files), CompilerUnavailable);
    await assert.rejects(new WasmRegistry(store).compile("7", "rust", files), CompilerUnavailable);
  } finally {
    fake.close();
  }
});

test("compiles are limited per person: one at a time and so many an hour", async () => {
  const { randomBytes } = await import("node:crypto");
  const { Store } = await import("../src/db.ts");
  const { MAX_COMPILES_PER_HOUR, WasmRegistry } = await import("../src/wasm/registry.ts");
  const outcome = { ok: false, stage: "compile", diagnostics: [], log: "", durationMs: 1, cached: false, language: "rust", version: "1" } as const;
  let release: () => void = () => {};
  const client = { compile: () => new Promise((resolve) => (release = () => resolve(outcome))) };
  const registry = new WasmRegistry(new Store(":memory:", randomBytes(32)), client as never);
  const files = [{ path: "src/main.rs", content: "" }];
  const first = registry.compile("7", "rust", files);
  await assert.rejects(registry.compile("7", "rust", files), /前のコンパイル/);
  release();
  await first;
  const instant = { compile: async () => outcome };
  const limited = new WasmRegistry(new Store(":memory:", randomBytes(32)), instant as never);
  for (let i = 0; i < MAX_COMPILES_PER_HOUR; i++) await limited.compile("7", "rust", files);
  await assert.rejects(limited.compile("7", "rust", files), /1時間/);
  // Someone else still can.
  await limited.compile("8", "rust", files);
});

test("the agent compiles, reads the errors, and keeps or runs what it built", async () => {
  const { readTools } = await import("../src/agent/tools.ts");
  const built = printer(JSON.stringify({ reply: "built" }));
  const { prepareModule } = await import("../src/wasm/module.ts");
  const prepared = await prepareModule(built);
  const fresh = { ownerId: "1", bytes: prepared.bytes, info: prepared.info, source: { language: "rust", version: "1+abc", files: [{ path: "src/main.rs", content: "fn main() {}" }] }, expires: Date.now() + 60_000 };
  const compiled: Array<{ language: string; files: Array<{ path: string; content: string }> }> = [];
  const kept: string[] = [];
  const message = { id: "5", author: { id: "1" }, attachments: [{ id: "a", filename: "main.rs", size: 12, url: "https://cdn/main.rs" }] };
  const reader = { guild: { id: "1" }, scope: { speakerId: "1", channelId: "10" }, get: async (route: string) => (route === "/channels/10/messages/5" ? message : null) } as never;
  const tools = readTools(reader, {
    images: false,
    fetch: (async () => new Response("fn main() { attached }")) as never,
    rules: {
      list: () => [],
      runs: () => null,
      wasm: {
        list: () => [],
        upload: async () => { throw new Error("not here"); },
        load: async () => { throw new Error("not here"); },
        compiler: {
          languages: () => [{ id: "rust", name: "Rust", version: "1", entry: ["src/main.rs"], extensions: [".rs"], paths: "^src/([a-z0-9_]+/)*[a-z0-9_]+\\.rs$", maxFiles: 32, libraries: ["serde_json"], ready: true }],
          guide: async () => "# guide",
          compile: async (language, files) => {
            compiled.push({ language, files });
            return files[0]!.content.includes("broken")
              ? { ok: false, stage: "compile", diagnostics: [{ file: "src/main.rs", line: 1, col: 13, severity: "error", message: "cannot find value `broken`" }], log: "error: could not compile", durationMs: 50, cached: false, language: "rust", version: "1" }
              : { ok: true, module: fresh, log: "", durationMs: 1200, cached: false };
          },
          fresh: (ref) => {
            if (!prepared.info.sha256.startsWith(ref)) throw new ModuleRejected("ない");
            return fresh;
          },
          keep: async (name, ref) => {
            kept.push(`${name}:${ref}`);
            return { module: { ownerId: "1", sha256: prepared.info.sha256, name, size: prepared.bytes.length, info: prepared.info, createdAt: "2026-10-25T09:00:00Z", source: { language: "rust", files: 1 } }, replaced: 0 };
          },
        },
      },
    },
  });
  const compile = tools.find((t) => t.name === "compile_wasm")!;
  assert.ok(tools.some((t) => t.name === "wasm_language_guide"));
  assert.match(compile.description, /rust\(Rust/);

  const failed = (await compile.execute("t", { language: "rust", files: [{ path: "src/main.rs", content: "fn main() { broken }" }] })).content[0] as { text: string };
  assert.match(failed.text, /コンパイルできませんでした/);
  assert.match(failed.text, /src\/main\.rs:1:13: error: cannot find value `broken`/);

  // An attached main.rs goes where Rust expects it.
  const ok = (await compile.execute("t", { language: "rust", message_id: "5" })).content[0] as { text: string };
  assert.deepEqual(compiled.at(-1)!.files, [{ path: "src/main.rs", content: "fn main() { attached }" }]);
  assert.match(ok.text, new RegExp(`sha256 ${prepared.info.sha256}`));
  await assert.rejects(compile.execute("t", { language: "cobol", files: [] }), /cobol/);

  const run = tools.find((t) => t.name === "run_wasm")!;
  const ran = (await run.execute("t", { compiled: prepared.info.sha256.slice(0, 12) })).content[0] as { text: string };
  assert.match(ran.text, /コンパイルした rust のモジュール.*終了コード 0/);
  assert.match(ran.text, /"reply":"built"/);

  const register = tools.find((t) => t.name === "register_wasm")!;
  await assert.rejects(register.execute("t", { compiled: prepared.info.sha256 }), /name/);
  const registered = (await register.execute("t", { compiled: prepared.info.sha256, name: "hello" })).content[0] as { text: string };
  assert.deepEqual(kept, [`hello:${prepared.info.sha256}`]);
  assert.match(registered.text, /Botがコンパイル/);
});

test("a compiled Wasm rule shows its source on the rule's code page", async () => {
  const { detailView } = await import("../src/rules/panel.ts");
  const rule = {
    id: "r1", name: "hello", ownerId: "u1", enabled: true, version: 1, sourcePrompt: "挨拶して",
    trigger: { events: ["MESSAGE_CREATE"] }, allow: [], program: { kind: "wasm", sha256: "ab".repeat(32) },
  } as unknown as import("../src/rules/types.ts").Rule;
  const base = { rule, userId: "u1", page: "source" as const, runs: [], can: { enable: true, disable: true, remove: true, owner: true } };
  const text = (r: unknown) => JSON.stringify(r);
  const compiled = text(detailView({ ...base, wasmSource: { language: "rust", version: "1", files: [{ path: "src/main.rs", content: "fn main() { greet(); }" }] } }, (id) => id));
  assert.match(compiled, /```rust\\nfn main\(\) \{ greet\(\); \}/);
  assert.match(compiled, /ファイルで/);
  const uploaded = text(detailView(base, (id) => id));
  assert.match(uploaded, /ソースはありません/);
  assert.doesNotMatch(uploaded, /ファイルで/);
});
