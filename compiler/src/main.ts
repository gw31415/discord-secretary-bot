import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Compiler } from "./compiler.ts";
import { loadLanguages } from "./languages.ts";
import { parseCompileRequest } from "./request.ts";
import { bubblewrap, type SandboxOptions } from "./sandbox.ts";
import { seccompFilter } from "./seccomp.ts";
import { createApi } from "./server.ts";

// wasm-compiler: a service apart from the bot that turns source code into
// WASI modules. Usage:
//
//   node src/main.ts serve              listen on the Unix socket
//   node src/main.ts setup <language>   fetch and prewarm a language's toolchain (needs network; run by an admin)
//   node src/main.ts rootfs <name>      build a root filesystem with rootfs/<name>.sh (needs root and network)
//   node src/main.ts selftest           check that a box has no network and sees nothing of the host,
//                                       and that each set-up language builds its tests
//
// Settings come from the environment (defaults in parentheses):
//   WASM_COMPILER_HOME (/opt/wasm-compiler)   toolchains/, rootfs/ and seccomp.bpf live here
//   WASM_COMPILER_JOBS (/var/lib/wasm-compiler/jobs)
//   WASM_COMPILER_SOCKET (/run/wasm-compiler/compiler.sock)
//   WASM_COMPILER_SOCKET_GID                  group that may connect (numeric)
//   WASM_COMPILER_CONCURRENCY (1), BWRAP (/usr/bin/bwrap), PRLIMIT (/usr/bin/prlimit)

const APP = resolve(dirname(new URL(import.meta.url).pathname), "..");
const HOME = process.env.WASM_COMPILER_HOME ?? "/opt/wasm-compiler";
const PATHS = {
  toolchains: join(HOME, "toolchains"),
  rootfs: join(HOME, "rootfs"),
  jobs: process.env.WASM_COMPILER_JOBS ?? "/var/lib/wasm-compiler/jobs",
};
const SOCKET = process.env.WASM_COMPILER_SOCKET ?? "/run/wasm-compiler/compiler.sock";
const LANGUAGES = join(APP, "languages");

const log = (message: string) => console.log(`[wasm-compiler] ${message}`);
const die = (message: string): never => {
  console.error(`エラー: ${message}`);
  process.exit(1);
};

function sandboxOptions(): SandboxOptions {
  // Written on every start, so the filter always matches this build of the service.
  const seccompPath = join(PATHS.jobs, "seccomp.bpf");
  mkdirSync(PATHS.jobs, { recursive: true });
  writeFileSync(seccompPath, seccompFilter());
  return {
    bwrap: process.env.BWRAP ?? "/usr/bin/bwrap",
    prlimit: process.env.PRLIMIT ?? "/usr/bin/prlimit",
    seccompPath,
    tmpBytes: 256 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
  };
}

async function serve(): Promise<void> {
  // Whatever a crash left behind goes before the first build.
  rmSync(PATHS.jobs, { recursive: true, force: true });
  const languages = loadLanguages(LANGUAGES, log);
  const compiler = new Compiler({ languages, paths: PATHS, box: bubblewrap(sandboxOptions()), concurrency: Number(process.env.WASM_COMPILER_CONCURRENCY ?? 1) });
  for (const l of languages.values()) log(`${l.id}: ${l.name} ${l.version}${compiler.ready(l) ? "" : "(未セットアップ)"}`);
  if (existsSync(SOCKET)) unlinkSync(SOCKET);
  const server = createApi(compiler, log);
  server.listen(SOCKET, () => {
    const gid = process.env.WASM_COMPILER_SOCKET_GID;
    if (gid) chownSync(SOCKET, -1, Number(gid));
    chmodSync(SOCKET, gid ? 0o660 : 0o600);
    log(`${SOCKET} で待ち受けています`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** Runs a language's setup.sh (network) and then its prewarm.sh in a box (no network), and swaps the result in. */
async function setup(id: string): Promise<void> {
  const language = loadLanguages(LANGUAGES, log).get(id) ?? die(`言語 ${id} はありません`);
  const final = join(PATHS.toolchains, language.toolchain);
  const staging = `${final}.new`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : die(`${process.arch} には対応していません`);
  const sh = spawnSync("/bin/sh", [join(language.dir, "setup.sh")], { stdio: "inherit", env: { ...process.env, DEST: staging, LANG_DIR: language.dir, ARCH: arch } });
  if (sh.status !== 0) die(`${id} の setup.sh が失敗しました`);
  const prewarm = join(language.dir, "prewarm.sh");
  if (existsSync(prewarm)) {
    if (!existsSync(join(PATHS.rootfs, language.rootfs, ".ready"))) die(`rootfs ${language.rootfs} がありません。先に rootfs ${language.rootfs} を作ってください`);
    const work = mkdtempSync(join(PATHS.toolchains, ".prewarm-"));
    const box = bubblewrap(sandboxOptions());
    const outcome = await box(
      { rootfs: join(PATHS.rootfs, language.rootfs), toolchain: staging, language: language.dir, work, env: language.env, command: ["/bin/sh", "/lang/prewarm.sh"], writableToolchain: true },
      30 * 60 * 1000,
    );
    rmSync(work, { recursive: true, force: true });
    console.log(outcome.output);
    if (outcome.exitCode !== 0) die(`${id} の prewarm.sh が失敗しました`);
  }
  writeFileSync(join(staging, ".ready"), `${JSON.stringify({ language: id, version: language.version, at: new Date().toISOString() })}\n`);
  if (existsSync(final)) renameSync(final, `${final}.old`);
  renameSync(staging, final);
  rmSync(`${final}.old`, { recursive: true, force: true });
  log(`${id} を用意しました: ${final}`);
}

function rootfs(name: string): void {
  if (!/^[a-z0-9-]+$/.test(name)) die("rootfs の名前が不正です");
  const script = join(APP, "rootfs", `${name}.sh`);
  if (!existsSync(script)) die(`${script} がありません`);
  const final = join(PATHS.rootfs, name);
  const staging = `${final}.new`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  const sh = spawnSync("/bin/sh", [script], { stdio: "inherit", env: { ...process.env, DEST: staging } });
  if (sh.status !== 0) die(`${name} の作成に失敗しました`);
  // Mount points for the box: the root is read-only, so they must already be there.
  for (const dir of ["toolchain", "lang", "work"]) mkdirSync(join(staging, dir), { recursive: true });
  writeFileSync(join(staging, ".ready"), `${new Date().toISOString()}\n`);
  if (existsSync(final)) renameSync(final, `${final}.old`);
  renameSync(staging, final);
  rmSync(`${final}.old`, { recursive: true, force: true });
  log(`rootfs ${name} を作りました: ${final}`);
}

/** Probes from inside a box: what it can see and reach. Exits non-zero when something leaks. */
async function selftest(): Promise<void> {
  const base = join(PATHS.rootfs, "base");
  if (!existsSync(join(base, ".ready"))) die("rootfs base がありません");
  mkdirSync(PATHS.jobs, { recursive: true });
  const empty = mkdtempSync(join(PATHS.jobs, "selftest-"));
  const work = mkdtempSync(join(PATHS.jobs, "selftest-work-"));
  const probe = [
    "echo user=$(id -u)",
    "echo ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ',')",
    "echo procs=$(ls /proc | grep -c '^[0-9]')",
    "echo home=$(ls -A /home 2>/dev/null | wc -l)",
    "echo env=$(env | grep -cv -E '^(PATH|HOME|TMPDIR|LANG|PWD|SHLVL|_)=')",
    "if touch /usr/x 2>/dev/null; then echo rootwrite=yes; else echo rootwrite=no; fi",
    "if touch /toolchain/x 2>/dev/null; then echo toolchainwrite=yes; else echo toolchainwrite=no; fi",
    "if unshare -U true 2>/dev/null; then echo userns=yes; else echo userns=no; fi",
    "if getent hosts example.com >/dev/null 2>&1; then echo dns=yes; else echo dns=no; fi",
  ].join("; ");
  const outcome = await bubblewrap(sandboxOptions())({ rootfs: base, toolchain: empty, language: empty, work, env: {}, command: ["/bin/sh", "-c", probe] }, 30_000);
  rmSync(empty, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  console.log(outcome.output.trim());
  const got = Object.fromEntries(outcome.output.trim().split("\n").map((l) => l.split("=") as [string, string]));
  const want: Record<string, string> = { ifaces: "lo,", home: "0", env: "0", rootwrite: "no", toolchainwrite: "no", userns: "no", dns: "no" };
  const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
  if (!(Number(got.procs) <= 10)) bad.push(["procs", "10以下"]);
  if (outcome.exitCode !== 0 || bad.length) die(`箱の確認に失敗: ${bad.map(([k, v]) => `${k} は ${v} のはずが ${got[k] ?? "(なし)"}`).join("、") || `終了コード ${outcome.exitCode}`}`);
  log("箱の確認: ネットワークなし・ホストは見えない・書けるのは /work と /tmp だけ");

  // Each set-up language builds its tests/ok and fails on its tests/bad with a located error.
  const languages = loadLanguages(LANGUAGES, log);
  const compiler = new Compiler({ languages, paths: PATHS, box: bubblewrap(sandboxOptions()) });
  let failed = false;
  for (const language of languages.values()) {
    if (!compiler.ready(language)) {
      log(`${language.id}: 未セットアップなので飛ばします`);
      continue;
    }
    for (const kind of ["ok", "bad"] as const) {
      const dir = join(language.dir, "tests", kind);
      if (!existsSync(dir)) continue;
      const result = await compiler.compile(parseCompileRequest({ language: language.id, files: readTree(dir) }, languages));
      const good = kind === "ok" ? result.ok : !result.ok && result.diagnostics.some((d) => d.severity === "error");
      log(`${language.id} ${kind}: ${good ? "期待どおり" : "期待と違う"} ${result.ok ? `${result.wasm.length}B` : `${result.stage} ${result.diagnostics.map((d) => `${d.file}:${d.line}`).join(" ")}`} ${result.durationMs}ms`);
      if (!good) {
        failed = true;
        console.log(result.log);
      }
    }
  }
  if (failed) die("言語のテストに失敗しました");
}

function readTree(dir: string, prefix = ""): Array<{ path: string; content: string }> {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? readTree(dir, path) : [{ path, content: readFileSync(join(dir, path), "utf8") }];
  });
}

const [command = "serve", arg] = process.argv.slice(2);
if (command === "serve") await serve();
else if (command === "setup") await setup(arg ?? die("言語を指定してください"));
else if (command === "rootfs") rootfs(arg ?? "base");
else if (command === "selftest") await selftest();
else die(`知らないコマンド: ${command}`);
