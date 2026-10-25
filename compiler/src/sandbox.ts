import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

// The throwaway box one build runs in. bubblewrap gives it its own user, PID,
// network, IPC, UTS and cgroup namespaces, so it has no network at all (not
// even loopback) and sees no other process. Its root is the language's own
// read-only root filesystem, never the host's; the only other mounts are the
// toolchain and the language directory (read-only), the job's directory at
// /work and a small /tmp. The environment is emptied, new user namespaces are
// refused, the seccomp filter (seccomp.ts) drops the calls that reach past the
// box, and prlimit caps the size of any file it writes. The service runs as
// its own user under systemd limits, so a box broken open still reaches
// nothing of the bot's.

export interface BoxSpec {
  rootfs: string;
  toolchain: string;
  language: string;
  work: string;
  env: Record<string, string>;
  command: string[];
  /** Setup builds (prewarming caches) write to the toolchain; builds never do. */
  writableToolchain?: boolean;
}

export interface SandboxOptions {
  bwrap: string;
  /** prlimit(1); empty to run bwrap directly (tests). */
  prlimit: string;
  /** File holding the seccomp filter; empty for none (tests). */
  seccompPath: string;
  tmpBytes: number;
  maxFileBytes: number;
}

export const SECCOMP_FD = 3;
const PATH = "/toolchain/bin:/usr/local/bin:/usr/bin:/bin";

export function boxArgs(spec: BoxSpec, options: SandboxOptions): string[] {
  const env = { PATH, HOME: "/work", TMPDIR: "/tmp", LANG: "C.UTF-8", ...spec.env };
  const args = [
    ...(options.prlimit ? [options.prlimit, `--fsize=${options.maxFileBytes}`, "--nofile=1024", "--core=0", "--"] : []),
    options.bwrap,
    "--unshare-all",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--hostname", "wasm-compiler",
    "--ro-bind", spec.rootfs, "/",
    spec.writableToolchain ? "--bind" : "--ro-bind", spec.toolchain, "/toolchain",
    "--ro-bind", spec.language, "/lang",
    "--bind", spec.work, "/work",
    "--size", String(options.tmpBytes), "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--chdir", "/work",
  ];
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  if (options.seccompPath) args.push("--seccomp", String(SECCOMP_FD));
  args.push("--", ...spec.command);
  return args;
}

export interface BoxOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** stdout and stderr together, the start and the end kept when it runs long. */
  output: string;
  truncated: boolean;
}

/** Something that runs a box; the service uses bubblewrap, tests a stand-in. */
export type BoxRunner = (spec: BoxSpec, timeoutMs: number) => Promise<BoxOutcome>;

export const MAX_OUTPUT = 64 * 1024;
const HEAD = 48 * 1024;

export function bubblewrap(options: SandboxOptions): BoxRunner {
  return (spec, timeoutMs) => {
    const argv = boxArgs(spec, options);
    const fd = options.seccompPath ? openSync(options.seccompPath, "r") : undefined;
    return run(argv, timeoutMs, fd).finally(() => {
      if (fd !== undefined) closeSync(fd);
    });
  };
}

/** Runs argv in its own process group and kills the whole group when time is up. */
export function run(argv: string[], timeoutMs: number, seccompFd?: number): Promise<BoxOutcome> {
  return new Promise((resolve, reject) => {
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
    if (seccompFd !== undefined) stdio[SECCOMP_FD] = seccompFd;
    const child = spawn(argv[0]!, argv.slice(1), { stdio, detached: true, env: {} });
    const head: Buffer[] = [];
    let headBytes = 0;
    let tail = Buffer.alloc(0);
    let total = 0;
    const take = (chunk: Buffer) => {
      total += chunk.length;
      if (headBytes < HEAD) {
        const part = chunk.subarray(0, HEAD - headBytes);
        head.push(part);
        headBytes += part.length;
        chunk = chunk.subarray(part.length);
      }
      if (chunk.length) {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > MAX_OUTPUT - HEAD) tail = tail.subarray(tail.length - (MAX_OUTPUT - HEAD));
      }
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      kill();
      const truncated = total > headBytes + tail.length;
      const output = Buffer.concat(head).toString("utf8") + (truncated ? "\n…(途中を省略)…\n" : "") + tail.toString("utf8");
      resolve({ exitCode, signal, timedOut, output, truncated });
    });
  });
}
