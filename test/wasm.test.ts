import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MEMORY_PAGES, ModuleRejected, prepareModule } from "../src/wasm/module.ts";
import { execute, runWasm } from "../src/wasm/run.ts";

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
  const r = await runWasm(await WebAssembly.compile(spin.bytes), { guildId: "1", actor: { kind: "user", userId: "2" }, get: async () => null }, { wallTimeMs: 300, memoryBytes: 0, maxGets: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /上限/);
  assert.ok(Date.now() - started < 3000);
});

test("rule code compiles to bytecode once and runs from it", async () => {
  const { compileJs, runSandboxed, setBytecodeCache, RULE_SANDBOX_LIMITS } = await import("../src/sandbox.ts");
  await assert.rejects(compileJs("return )"), /SyntaxError/);
  const kept = new Map<string, Buffer>();
  setBytecodeCache({ get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v) });
  try {
    const bindings = { guildId: "1", actor: { kind: "user" as const, userId: "2" }, get: async () => ({ n: 3 }), state: null };
    const code = "return plan([call('POST /channels/{channel}/messages', { path: { channel: '9' }, body: { content: String(discord.get('/x').n) } })])";
    const first = await runSandboxed(code, bindings, RULE_SANDBOX_LIMITS, { cache: true });
    assert.equal(kept.size, 1);
    const second = await runSandboxed(code, bindings, RULE_SANDBOX_LIMITS, { cache: true });
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
    code: "",
    wasm: v1.sha256,
    summary: null,
    limits: DEFAULT_LIMITS,
  });
  assert.equal(store.getRule(rule.id)!.wasm, v1.sha256);

  engine.dispatch("MESSAGE_CREATE", GUILD, { id: "700", channel_id: "10", guild_id: GUILD, content: "hi", author: { id: "3" } });
  await engine.idle();
  assert.equal(runs.length, 1, JSON.stringify(store.recentRuleRuns(rule.id, 1)));
  assert.equal(runs[0].ownerId, "1");
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
