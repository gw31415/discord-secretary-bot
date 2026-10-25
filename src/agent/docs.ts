import { readdir, readFile } from "node:fs/promises";

// The docs/ folder of the repository, read by the agents so they can answer
// how the bot works with what is written there instead of guessing.

const DOCS_DIR = new URL("../../docs/", import.meta.url);

export interface Doc {
  /** File name without .md (conversation, rules, ...). */
  name: string;
  title: string;
  body: string;
}

interface Heading {
  level: number;
  title: string;
  line: number;
}

let cached: Promise<Doc[]> | null = null;

/** The documents in docs/, without the index (README.md). Read once. */
export function loadDocs(dir: URL = DOCS_DIR): Promise<Doc[]> {
  if (dir !== DOCS_DIR) return readDocs(dir);
  cached ??= readDocs(dir).catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

async function readDocs(dir: URL): Promise<Doc[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  return Promise.all(
    names.map(async (f) => {
      const body = await readFile(new URL(f, dir), "utf8");
      return { name: f.slice(0, -3), title: headings(body)[0]?.title ?? f, body };
    }),
  );
}

function headings(body: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  body.split("\n").forEach((l, line) => {
    if (l.startsWith("```")) fenced = !fenced;
    const m = !fenced && /^(#{1,6})\s+(.+?)\s*$/.exec(l);
    if (m) out.push({ level: m[1]!.length, title: m[2]!, line });
  });
  return out;
}

/** The list of documents with their headings, for choosing what to read. */
export function docsIndex(docs: Doc[]): string {
  return docs
    .map((d) => {
      const sections = headings(d.body)
        .filter((h) => h.level >= 2)
        .map((h) => `${"  ".repeat(h.level - 2)}- ${h.title}`);
      return [`${d.name}: ${d.title}`, ...sections].join("\n");
    })
    .join("\n\n");
}

/** A whole document, or one section of it (with its subsections). */
export function readDoc(docs: Doc[], name: string, section?: string): string {
  const doc = findDoc(docs, name);
  if (!section) return doc.body;
  const all = headings(doc.body);
  const wanted = section.replace(/^#+\s*/, "").trim();
  const start = all.find((h) => h.title === wanted) ?? all.find((h) => h.title.includes(wanted));
  if (!start) throw new Error(`${doc.name} に見出し「${wanted}」はありません(${all.filter((h) => h.level >= 2).map((h) => h.title).join("、")})`);
  const end = all.find((h) => h.line > start.line && h.level <= start.level);
  return doc.body.split("\n").slice(start.line, end?.line).join("\n").trim();
}

function findDoc(docs: Doc[], name: string): Doc {
  const doc = docs.find((d) => d.name === name.replace(/\.md$/, ""));
  if (!doc) throw new Error(`文書 ${name} はありません(${docs.map((d) => d.name).join(", ")})`);
  return doc;
}

/** Lines that contain every word of the query, with the document and heading they are under. Only in one document when name is given. */
export function searchDocs(docs: Doc[], query: string, name?: string, limit = 30): string {
  if (name) docs = [findDoc(docs, name)];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("query が空です");
  const hits: string[] = [];
  for (const d of docs) {
    const hs = headings(d.body);
    d.body.split("\n").forEach((l, line) => {
      const lower = l.toLowerCase();
      if (!words.every((w) => lower.includes(w))) return;
      const under = hs.filter((h) => h.line <= line).at(-1);
      hits.push(`${d.name}${under && under.level >= 2 ? ` > ${under.title}` : ""}: ${l.trim()}`);
    });
  }
  if (hits.length === 0) return "見つかりませんでした。言葉を変えるか、doc を省いて目次を見てください。";
  return hits.slice(0, limit).join("\n") + (hits.length > limit ? `\n…ほか${hits.length - limit}件` : "");
}
