import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BoxFailed, Busy, type Compiler, NotReady } from "./compiler.ts";
import { describe, guide } from "./languages.ts";
import { parseCompileRequest, RequestError } from "./request.ts";

// The HTTP API, served on a Unix socket only. It knows sources and Wasm and
// nothing of who asks: limits per person belong to the caller.
//
//   GET  /v1/health                  { ok, running, waiting, compiled, cached }
//   GET  /v1/languages               { languages: [...] }
//   GET  /v1/languages/{id}/guide    Markdown for whoever writes the code
//   POST /v1/compile                 { language, files: [{ path, content }], abi?, optimize? }
//        -> { ok: true, wasm (base64), sha256, log, durationMs, cached, language, version }
//         | { ok: false, stage, diagnostics, log, durationMs, cached, language, version }

const MAX_BODY = 2 * 1024 * 1024;

export function createApi(compiler: Compiler, log: (message: string) => void = () => {}): Server {
  return createServer((req, res) => {
    handle(compiler, req, res, log).catch((e) => {
      log(`要求の処理に失敗: ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) send(res, 500, { error: "コンパイラの内部エラーです" });
      else res.end();
    });
  });
}

async function handle(compiler: Compiler, req: IncomingMessage, res: ServerResponse, log: (message: string) => void): Promise<void> {
  const url = new URL(req.url ?? "/", "http://compiler");
  const path = url.pathname;
  if (req.method === "GET" && path === "/v1/health") return send(res, 200, { ok: true, ...compiler.status() });
  if (req.method === "GET" && path === "/v1/languages") {
    return send(res, 200, { languages: [...compiler.languages.values()].map((l) => describe(l, compiler.ready(l))) });
  }
  const guidePath = /^\/v1\/languages\/([a-z0-9-]+)\/guide$/.exec(path);
  if (req.method === "GET" && guidePath) {
    const language = compiler.languages.get(guidePath[1]!);
    if (!language) return send(res, 404, { error: "その言語はありません" });
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(guide(language));
    return;
  }
  if (req.method === "POST" && path === "/v1/compile") {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, e instanceof RequestError ? 413 : 400, { error: e instanceof RequestError ? e.message : "JSON として読めません" });
    }
    try {
      const request = parseCompileRequest(body, compiler.languages);
      const result = await compiler.compile(request);
      log(`${request.language.id} ${result.ok ? `成功 ${result.wasm.length}B` : `失敗(${result.stage})`} ${result.cached ? "キャッシュ" : `${result.durationMs}ms`}`);
      return send(res, 200, result.ok ? { ...result, wasm: result.wasm.toString("base64") } : result);
    } catch (e) {
      if (e instanceof RequestError) return send(res, 400, { error: e.message });
      if (e instanceof Busy || e instanceof NotReady || e instanceof BoxFailed) {
        if (e instanceof BoxFailed) log(e.message);
        return send(res, 503, { error: e.message });
      }
      throw e;
    }
  }
  send(res, 404, { error: "そのAPIはありません" });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new RequestError(`要求は${MAX_BODY / 1024 / 1024}MBまでです`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}
