import { request } from "node:http";

// The bot's side of wasm-compiler (compiler/), a service of its own reached
// over a Unix socket: the bot sends source files and gets a Wasm module back,
// or where the build failed. The service knows nothing of Discord or of who
// asks, so limits per person are kept here.

export interface CompilerLanguage {
  id: string;
  name: string;
  version: string;
  entry: string[];
  extensions: string[];
  paths: string;
  maxFiles: number;
  libraries: string[];
  ready: boolean;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  message: string;
}

export type CompileOutcome =
  | { ok: true; wasm: Buffer; log: string; durationMs: number; cached: boolean; language: string; version: string }
  | { ok: false; stage: "compile" | "link" | "limit"; diagnostics: Diagnostic[]; log: string; durationMs: number; cached: boolean; language: string; version: string };

/** The service is down, busy or refused the request; the message says which. */
export class CompilerUnavailable extends Error {}

const LANGUAGES_TTL_MS = 5 * 60 * 1000;

export class CompilerClient {
  readonly #socket: string;
  readonly #timeoutMs: number;
  #languages: CompilerLanguage[] = [];
  #fetchedAt = 0;

  constructor(socket: string, timeoutMs = 240_000) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
  }

  /** Languages the service can build now; refreshed in the background, so a tool list never waits on it. */
  languages(): CompilerLanguage[] {
    if (Date.now() - this.#fetchedAt > LANGUAGES_TTL_MS) void this.refresh().catch(() => undefined);
    return this.#languages.filter((l) => l.ready);
  }

  async refresh(): Promise<CompilerLanguage[]> {
    this.#fetchedAt = Date.now();
    const { body } = await this.#call("GET", "/v1/languages");
    this.#languages = (JSON.parse(body) as { languages: CompilerLanguage[] }).languages;
    return this.#languages;
  }

  async guide(language: string): Promise<string> {
    if (!/^[a-z0-9-]+$/.test(language)) throw new CompilerUnavailable(`言語 ${language} はありません`);
    return (await this.#call("GET", `/v1/languages/${language}/guide`)).body;
  }

  async compile(language: string, files: SourceFile[], optimize: "size" | "speed" = "size"): Promise<CompileOutcome> {
    const { body } = await this.#call("POST", "/v1/compile", { language, files, optimize, abi: "secretary/1" });
    const res = JSON.parse(body) as CompileOutcome & { wasm?: string };
    return res.ok ? { ...res, wasm: Buffer.from(res.wasm as unknown as string, "base64") } : res;
  }

  #call(method: string, path: string, payload?: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const data = payload === undefined ? undefined : JSON.stringify(payload);
      const req = request(
        { socketPath: this.#socket, method, path, timeout: this.#timeoutMs, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status === 200) return resolve({ status, body });
            let message = body;
            try {
              message = (JSON.parse(body) as { error?: string }).error ?? body;
            } catch {
              // Not JSON: say it as it came.
            }
            reject(new CompilerUnavailable(message.slice(0, 500) || `コンパイラが ${status} を返しました`));
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new CompilerUnavailable("コンパイラが時間内に答えませんでした")));
      req.on("error", (e) => reject(e instanceof CompilerUnavailable ? e : new CompilerUnavailable(`コンパイラにつながりません(${(e as NodeJS.ErrnoException).code ?? e.message})`)));
      req.end(data);
    });
  }
}
