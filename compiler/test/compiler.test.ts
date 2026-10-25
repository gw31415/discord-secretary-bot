import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxFailed, Busy, Compiler, NotReady } from "../src/compiler.ts";
import { parseDiagnostics } from "../src/diagnostics.ts";
import { type Language, loadLanguage, loadLanguages } from "../src/languages.ts";
import { parseCompileRequest, RequestError, safePath } from "../src/request.ts";
import { boxArgs, type BoxRunner, type BoxSpec, run } from "../src/sandbox.ts";
import { deniedSyscalls, seccompFilter } from "../src/seccomp.ts";
import { createApi } from "../src/server.ts";

const LANGUAGES = new URL("../languages/", import.meta.url).pathname;
const WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

test("reads every language directory", () => {
  const languages = loadLanguages(LANGUAGES);
  assert.deepEqual([...languages.keys()], ["c", "go", "rust"]);
  for (const l of languages.values()) {
    assert.match(l.fingerprint, /^[0-9a-f]{16}$/);
    assert.ok(l.entry.every((e) => l.paths.test(e)));
  }
});

test("a broken language is left out with a warning", () => {
  const root = mkdtempSync(join(tmpdir(), "langs-"));
  mkdirSync(join(root, "bad"));
  writeFileSync(join(root, "bad", "language.json"), JSON.stringify({ id: "other", name: "x", version: "1", toolchain: "t", rootfs: "base", entry: ["a.x"], extensions: [], paths: "^a\\.x$" }));
  writeFileSync(join(root, "bad", "build.sh"), "");
  const warnings: string[] = [];
  assert.equal(loadLanguages(root, (m) => warnings.push(m)).size, 0);
  assert.match(warnings[0]!, /ディレクトリ名/);
});

test("requests carry source files only, at the paths the language allows", () => {
  const languages = loadLanguages(LANGUAGES);
  const ok = (language: string, ...paths: string[]) => parseCompileRequest({ language, files: paths.map((path) => ({ path, content: "x" })) }, languages);
  const refused = (language: string, ...paths: string[]) => assert.throws(() => ok(language, ...paths), RequestError, paths.join(","));
  assert.equal(ok("rust", "src/main.rs", "src/util/mod.rs").optimize, "size");
  assert.equal(ok("go", "main.go", "util/strings.go").files.length, 2);
  assert.equal(ok("c", "main.cpp", "lib/thing.h").abi, "secretary/1");
  // Build settings and anything that runs while building.
  refused("rust", "src/main.rs", "Cargo.toml");
  refused("rust", "src/main.rs", "build.rs");
  refused("rust", "src/main.rs", ".cargo/config.toml");
  refused("go", "main.go", "go.mod");
  refused("c", "main.c", "Makefile");
  // Ways out of the job directory.
  refused("c", "main.c", "../main.c");
  refused("c", "/etc/main.c");
  refused("go", "main.go", "a/../../b.go");
  // The entry is required.
  refused("rust", "src/lib.rs");
  assert.throws(() => parseCompileRequest({ language: "cobol", files: [] }, languages), /cobol/);
  assert.throws(() => parseCompileRequest({ language: "c", files: [{ path: "main.c", content: "x".repeat(300 * 1024) }] }, languages), /256KB/);
  assert.throws(() => parseCompileRequest({ language: "c", files: [{ path: "main.c", content: "" }, { path: "main.c", content: "" }] }, languages), /二度/);
  assert.throws(() => parseCompileRequest({ language: "c", abi: "secretary/9", files: [{ path: "main.c", content: "" }] }, languages), /abi/);
});

test("safe paths have no dot segments, hidden files or odd characters", () => {
  for (const p of ["main.c", "a/b_c.go", "src/x.rs"]) assert.ok(safePath(p), p);
  for (const p of ["", ".", "..", "a/../b", ".hidden", "a//b", "a b.c", "a\\b.c", "-flag.c", "/abs"]) assert.ok(!safePath(p), p);
});

/** Classic BPF, just the instructions the filter uses. */
function runFilter(filter: Buffer, data: { nr: number; arch: number }): number {
  let a = 0;
  for (let pc = 0; pc < filter.length / 8; ) {
    const code = filter.readUInt16LE(pc * 8);
    const jt = filter.readUInt8(pc * 8 + 2);
    const jf = filter.readUInt8(pc * 8 + 3);
    const k = filter.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) a = k === 0 ? data.nr : k === 4 ? data.arch : assert.fail(`load ${k}`);
    else if (code === 0x15) pc += a === k ? jt : jf;
    else if (code === 0x35) pc += a >= k ? jt : jf;
    else if (code === 0x06) return k;
    else assert.fail(`code ${code}`);
    pc++;
  }
  return assert.fail("fell off the end");
}

test("the seccomp filter refuses what reaches past the box and allows the rest", () => {
  const ALLOW = 0x7fff0000;
  const EPERM = 0x00050001;
  const ENOSYS = 0x00050026;
  const KILL = 0x80000000;
  const arm = seccompFilter("arm64");
  const ARM = 0xc00000b7;
  assert.equal(runFilter(arm, { arch: ARM, nr: 63 }), ALLOW); // read
  assert.equal(runFilter(arm, { arch: ARM, nr: 220 }), ALLOW); // clone (threads, fork)
  assert.equal(runFilter(arm, { arch: ARM, nr: 117 }), EPERM); // ptrace
  assert.equal(runFilter(arm, { arch: ARM, nr: 40 }), EPERM); // mount
  assert.equal(runFilter(arm, { arch: ARM, nr: 97 }), EPERM); // unshare
  assert.equal(runFilter(arm, { arch: ARM, nr: 280 }), EPERM); // bpf
  assert.equal(runFilter(arm, { arch: ARM, nr: 435 }), ENOSYS); // clone3
  assert.equal(runFilter(arm, { arch: 0xc000003e, nr: 63 }), KILL); // another architecture's numbers
  const x64 = seccompFilter("x64");
  const X64 = 0xc000003e;
  assert.equal(runFilter(x64, { arch: X64, nr: 0 }), ALLOW);
  assert.equal(runFilter(x64, { arch: X64, nr: 101 }), EPERM); // ptrace
  assert.equal(runFilter(x64, { arch: X64, nr: 0x40000000 }), KILL); // x32
  assert.ok(deniedSyscalls("arm64").includes("keyctl"));
  assert.throws(() => seccompFilter("riscv64"));
});

test("the box shares no namespace and mounts nothing of the host but what it is given", () => {
  const spec: BoxSpec = { rootfs: "/opt/r/base", toolchain: "/opt/t/rust", language: "/app/languages/rust", work: "/jobs/job-1", env: { OPTIMIZE: "size" }, command: ["/bin/sh", "/lang/build.sh"] };
  const args = boxArgs(spec, { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", seccompPath: "/x/seccomp.bpf", tmpBytes: 1024, maxFileBytes: 2048 });
  assert.deepEqual(args.slice(0, 5), ["/usr/bin/prlimit", "--fsize=2048", "--nofile=1024", "--core=0", "--"]);
  for (const flag of ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--share-net"));
  const mounts: string[][] = [];
  args.forEach((a, i) => {
    if (a === "--ro-bind" || a === "--bind") mounts.push([a, args[i + 1]!, args[i + 2]!]);
  });
  assert.deepEqual(mounts, [
    ["--ro-bind", "/opt/r/base", "/"],
    ["--ro-bind", "/opt/t/rust", "/toolchain"],
    ["--ro-bind", "/app/languages/rust", "/lang"],
    ["--bind", "/jobs/job-1", "/work"],
  ]);
  assert.deepEqual(args.slice(args.indexOf("--seccomp"), args.indexOf("--seccomp") + 2), ["--seccomp", "3"]);
  assert.deepEqual(args.slice(-3), ["--", "/bin/sh", "/lang/build.sh"]);
  // The environment is only what the box sets.
  const env = args.flatMap((a, i) => (a === "--setenv" ? [args[i + 1]] : []));
  assert.deepEqual(env.sort(), ["HOME", "LANG", "OPTIMIZE", "PATH", "TMPDIR"]);
  // Setup's prewarm writes to the toolchain; a build never does.
  const setup = boxArgs({ ...spec, writableToolchain: true }, { bwrap: "bwrap", prlimit: "", seccompPath: "", tmpBytes: 1, maxFileBytes: 1 });
  assert.equal(setup[0], "bwrap");
  assert.deepEqual(setup.slice(setup.indexOf("/opt/t/rust") - 1, setup.indexOf("/opt/t/rust") + 2), ["--bind", "/opt/t/rust", "/toolchain"]);
  assert.ok(!setup.includes("--seccomp"));
});

test("a run past its time is killed with everything it started", async () => {
  const started = Date.now();
  const outcome = await run(["/bin/sh", "-c", "echo started; sleep 30 & sleep 30"], 300);
  assert.ok(outcome.timedOut);
  assert.ok(Date.now() - started < 5000);
  assert.match(outcome.output, /started/);
});

test("long output keeps its start and its end", async () => {
  const outcome = await run(["/bin/sh", "-c", "echo FIRST; i=0; while [ $i -lt 20000 ]; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; echo LAST"], 10_000);
  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.truncated);
  assert.ok(outcome.output.startsWith("FIRST"));
  assert.ok(outcome.output.trimEnd().endsWith("LAST"));
  assert.ok(outcome.output.length < 70 * 1024);
});

test("reads clang, rustc and go messages", () => {
  const log = [
    "main.c:4:10: error: use of undeclared identifier 'undefined_name'",
    "    4 |   return undefined_name;",
    "lib/x.h:2:1: warning: unused function 'f' [-Wunused-function]",
    "src/main.rs:4:18: error[E0308]: mismatched types",
    "warning: unused variable: `x`",
    "./main.go:4:2: undefined: undefinedName",
    "/work/src/util/a.go:1:1: expected 'package', found 'EOF'",
    "error: could not compile `module` (bin \"module\") due to 1 previous error",
  ].join("\n");
  assert.deepEqual(parseDiagnostics(log), [
    { file: "main.c", line: 4, col: 10, severity: "error", message: "use of undeclared identifier 'undefined_name'" },
    { file: "lib/x.h", line: 2, col: 1, severity: "warning", message: "unused function 'f' [-Wunused-function]" },
    { file: "src/main.rs", line: 4, col: 18, severity: "error", message: "mismatched types" },
    { file: "main.go", line: 4, col: 2, severity: "error", message: "undefined: undefinedName" },
    { file: "util/a.go", line: 1, col: 1, severity: "error", message: "expected 'package', found 'EOF'" },
  ]);
});

/** A compiler over the real language definitions, set up in a temp dir, with a stand-in box. */
function setup(box: BoxRunner, options: { ready?: boolean; concurrency?: number; maxQueue?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wasmc-"));
  const languages = loadLanguages(LANGUAGES);
  const paths = { toolchains: join(home, "toolchains"), rootfs: join(home, "rootfs"), jobs: join(home, "jobs") };
  if (options.ready !== false) {
    for (const l of languages.values()) {
      mkdirSync(join(paths.toolchains, l.toolchain), { recursive: true });
      writeFileSync(join(paths.toolchains, l.toolchain, ".ready"), "");
    }
    mkdirSync(join(paths.rootfs, "base"), { recursive: true });
    writeFileSync(join(paths.rootfs, "base", ".ready"), "");
  }
  const compiler = new Compiler({ languages, paths, box, concurrency: options.concurrency ?? 1, ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }) });
  return { compiler, languages, paths };
}

const compileC = (languages: Map<string, Language>, content = "int main(void){return 0;}") => parseCompileRequest({ language: "c", files: [{ path: "main.c", content }] }, languages);

test("a build gets its sources under /work/src, and its module comes back", async () => {
  const seen: BoxSpec[] = [];
  const { compiler, languages, paths } = setup(async (spec) => {
    seen.push(spec);
    assert.equal(await readFile(join(spec.work, "src", "main.c"), "utf8"), "int main(void){return 0;}");
    await writeFile(join(spec.work, "out", "module.wasm"), WASM);
    return { exitCode: 0, signal: null, timedOut: false, output: "built", truncated: false };
  });
  const result = await compiler.compile(compileC(languages));
  assert.ok(result.ok);
  assert.deepEqual(result.wasm, WASM);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(seen[0]!.env.ENTRY, "main.c");
  assert.equal(seen[0]!.env.OPTIMIZE, "size");
  assert.equal(seen[0]!.toolchain, join(paths.toolchains, "wasi-sdk-25"));
  assert.deepEqual(seen[0]!.command, ["/bin/sh", "/lang/build.sh"]);
  // The job directory is gone afterwards.
  assert.deepEqual(readdirSync(paths.jobs), []);
  // The same sources come from the cache without another build.
  const again = await compiler.compile(compileC(languages));
  assert.ok(again.ok && again.cached);
  assert.equal(seen.length, 1);
});

test("a failed build returns where it failed", async () => {
  const { compiler, languages } = setup(async () => ({ exitCode: 1, signal: null, timedOut: false, output: "main.c:1:20: error: expected ';'", truncated: false }));
  const result = await compiler.compile(compileC(languages, "int main(void){return 0}"));
  assert.ok(!result.ok);
  assert.equal(result.stage, "compile");
  assert.deepEqual(result.diagnostics.map((d) => [d.file, d.line]), [["main.c", 1]]);
});

test("a build past its time is a limit and is not cached", async () => {
  let builds = 0;
  const { compiler, languages } = setup(async () => {
    builds++;
    return { exitCode: null, signal: "SIGKILL", timedOut: true, output: "", truncated: false };
  });
  const result = await compiler.compile(compileC(languages));
  assert.ok(!result.ok && result.stage === "limit");
  await compiler.compile(compileC(languages));
  assert.equal(builds, 2);
});

test("a box that bubblewrap cannot make is the service's failure, not the source's, and is not cached", async () => {
  let builds = 0;
  const { compiler, languages } = setup(async () => {
    builds++;
    return { exitCode: 1, signal: null, timedOut: false, output: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n", truncated: false };
  });
  await assert.rejects(compiler.compile(compileC(languages)), BoxFailed);
  await assert.rejects(compiler.compile(compileC(languages)), BoxFailed);
  assert.equal(builds, 2);
});

test("a build that writes something other than Wasm fails", async () => {
  const { compiler, languages } = setup(async (spec) => {
    await writeFile(join(spec.work, "out", "module.wasm"), "#!/bin/sh");
    return { exitCode: 0, signal: null, timedOut: false, output: "", truncated: false };
  });
  const result = await compiler.compile(compileC(languages));
  assert.ok(!result.ok && result.stage === "link");
});

test("a language without its toolchain is not ready", async () => {
  const { compiler, languages } = setup(async () => assert.fail("no build"), { ready: false });
  await assert.rejects(compiler.compile(compileC(languages)), NotReady);
});

test("builds run one at a time and a full queue is refused", async () => {
  let running = 0;
  let most = 0;
  const release: Array<() => void> = [];
  const { compiler, languages } = setup(
    async (spec) => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
      await writeFile(join(spec.work, "out", "module.wasm"), WASM);
      return { exitCode: 0, signal: null, timedOut: false, output: "", truncated: false };
    },
    { maxQueue: 1 },
  );
  const first = compiler.compile(compileC(languages, "1"));
  const second = compiler.compile(compileC(languages, "2"));
  await assert.rejects(compiler.compile(compileC(languages, "3")), Busy);
  while (release.length === 0) await new Promise((r) => setTimeout(r, 5));
  release.shift()!();
  await first;
  while (release.length === 0) await new Promise((r) => setTimeout(r, 5));
  release.shift()!();
  await second;
  assert.equal(most, 1);
});

function call(socket: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("the API lists languages, gives guides and compiles over a Unix socket", async () => {
  const { compiler } = setup(async (spec) => {
    await writeFile(join(spec.work, "out", "module.wasm"), WASM);
    return { exitCode: 0, signal: null, timedOut: false, output: "", truncated: false };
  });
  const socket = join(mkdtempSync(join(tmpdir(), "sock-")), "c.sock");
  const server = createApi(compiler);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const languages = JSON.parse((await call(socket, "GET", "/v1/languages")).body) as { languages: Array<{ id: string; ready: boolean; version: string }> };
    assert.deepEqual(languages.languages.map((l) => [l.id, l.ready]), [["c", true], ["go", true], ["rust", true]]);
    const guide = await call(socket, "GET", "/v1/languages/rust/guide");
    assert.match(guide.body, /mod secretary/);
    const ok = JSON.parse((await call(socket, "POST", "/v1/compile", { language: "go", files: [{ path: "main.go", content: "package main" }] })).body) as { ok: boolean; wasm: string };
    assert.ok(ok.ok);
    assert.deepEqual(Buffer.from(ok.wasm, "base64"), WASM);
    const bad = await call(socket, "POST", "/v1/compile", { language: "go", files: [{ path: "go.mod", content: "" }] });
    assert.equal(bad.status, 400);
    assert.equal((await call(socket, "POST", "/v1/compile", "not json{")).status, 400);
    assert.equal((await call(socket, "GET", "/v1/nothing")).status, 404);
    assert.equal(JSON.parse((await call(socket, "GET", "/v1/health")).body).compiled, 1);
  } finally {
    server.close();
  }
});

test("a language's own files key the cache", () => {
  const a = loadLanguage(join(LANGUAGES, "rust"));
  const b = loadLanguage(join(LANGUAGES, "go"));
  assert.notEqual(a.fingerprint, b.fingerprint);
});
