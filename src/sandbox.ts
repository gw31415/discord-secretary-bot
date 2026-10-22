import { newAsyncContext, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten";
import { CANVAS_PRELUDE, MAX_IMAGES_PER_RUN, measureText, renderCanvas } from "./canvas.ts";

// Read-only code execution. The code runs in QuickJS inside WebAssembly and can
// only reach the bindings passed in here: no network, files, timers or host objects.

export interface SandboxBindings {
  guildId: string;
  actor: { kind: "user"; userId: string; via?: string };
  /** The event an event rule fired on; null for the agent's code. */
  event?: unknown;
  /** The rule's own values (ids it was made with); null for the agent's code. */
  params?: unknown;
  /** Which of the rule's triggers fired, e.g. "CHANNEL_CREATE"; null for the agent's code. */
  eventName?: string | null;
  get: (route: string, query: Record<string, unknown>) => Promise<unknown>;
  /** Enables createCanvas()/attachImage(); takes the drawn PNG and returns the image's id. */
  attach?: (png: Buffer, name: string) => string;
}

export interface SandboxLimits {
  wallTimeMs: number;
  memoryBytes: number;
  maxGets: number;
}

export const AGENT_SANDBOX_LIMITS: SandboxLimits = { wallTimeMs: 30_000, memoryBytes: 64 * 1024 * 1024, maxGets: 200 };
/** A rule runs on every matching event, so it gets less. The wall time includes waiting on discord.get. */
export const RULE_SANDBOX_LIMITS: SandboxLimits = { wallTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maxGets: 50 };

const PRELUDE = [
  "function call(op, args) { args = args || {}; return { id: args.id, op: op, path: args.path, query: args.query, body: args.body }; }",
  "function rule(def) { return def; }",
  "function plan(steps, rules) { return { steps: steps || [], rules: rules || [] }; }",
].join("\n");

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
}

function toHandle(vm: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === undefined) return vm.undefined.dup();
  const json = vm.newString(JSON.stringify(value));
  const parse = vm.getProp(vm.getProp(vm.global, "JSON"), "parse");
  const result = vm.unwrapResult(vm.callFunction(parse, vm.undefined, json));
  json.dispose();
  parse.dispose();
  return result;
}

export async function runSandboxed(code: string, bindings: SandboxBindings, limits: SandboxLimits): Promise<SandboxResult> {
  const vm = await newAsyncContext();
  const logs: string[] = [];
  let gets = 0;
  try {
    vm.runtime.setMemoryLimit(limits.memoryBytes);
    vm.runtime.setMaxStackSize(1024 * 1024);
    vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.wallTimeMs));

    vm.newString(bindings.guildId).consume((h) => vm.setProp(vm.global, "guild", h));
    toHandle(vm, bindings.actor).consume((h) => vm.setProp(vm.global, "actor", h));
    toHandle(vm, bindings.event ?? null).consume((h) => vm.setProp(vm.global, "event", h));
    toHandle(vm, bindings.params ?? null).consume((h) => vm.setProp(vm.global, "params", h));
    toHandle(vm, bindings.eventName ?? null).consume((h) => vm.setProp(vm.global, "eventName", h));

    const discord = vm.newObject();
    vm.newAsyncifiedFunction("get", async (routeHandle, optsHandle) => {
      if (++gets > limits.maxGets) throw new Error(`discord.get は1回の実行で${limits.maxGets}回までです`);
      const route = vm.getString(routeHandle);
      const opts = optsHandle ? (vm.dump(optsHandle) as { query?: Record<string, unknown> } | undefined) : undefined;
      return toHandle(vm, await bindings.get(route, opts?.query ?? {}));
    }).consume((fn) => vm.setProp(discord, "get", fn));
    vm.setProp(vm.global, "discord", discord);
    discord.dispose();

    let attached = 0;
    if (bindings.attach) {
      const attach = bindings.attach;
      vm.newFunction("__attach", (w, h, opsJson, name) => {
        if (++attached > MAX_IMAGES_PER_RUN) throw new Error(`attachImage は1回の実行で${MAX_IMAGES_PER_RUN}回までです`);
        const png = renderCanvas(vm.dump(w), vm.dump(h), JSON.parse(vm.getString(opsJson)));
        return vm.newString(attach(png, vm.getString(name)));
      }).consume((fn) => vm.setProp(vm.global, "__attach", fn));
      vm.newFunction("__measure", (font, text) => toHandle(vm, measureText(vm.getString(font), vm.getString(text)))).consume((fn) => vm.setProp(vm.global, "__measure", fn));
    }

    vm.newFunction("log", (...args) => {
      logs.push(args.map((a) => JSON.stringify(vm.dump(a))).join(" ").slice(0, 2000));
    }).consume((fn) => vm.setProp(vm.global, "log", fn));

    // Wrapped so the code can `return` its answer; JSON keeps host and guest values apart.
    // call()/rule()/plan() only build plain objects: a returned plan is a proposal, not a write.
    const prelude = bindings.attach ? `${PRELUDE}\n${CANVAS_PRELUDE}` : PRELUDE;
    const wrapped = `${prelude}\nJSON.stringify((function () {\n${code}\n})())`;
    const result = await vm.evalCodeAsync(wrapped, "agent.js");
    if (result.error) {
      const err = vm.dump(result.error) as { name?: string; message?: string } | string;
      result.error.dispose();
      return { ok: false, error: typeof err === "string" ? err : `${err.name ?? "Error"}: ${err.message ?? ""}`, logs };
    }
    const json = vm.getString(result.value);
    result.value.dispose();
    return { ok: true, value: json === undefined || json === "undefined" ? undefined : JSON.parse(json), logs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
  } finally {
    vm.dispose();
  }
}
