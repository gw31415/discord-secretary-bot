import { test } from "node:test";
import assert from "node:assert/strict";
import { docsIndex, loadDocs, readDoc, searchDocs } from "../src/agent/docs.ts";
import { readTools } from "../src/agent/tools.ts";

test("loads every document in docs/ except the index", async () => {
  const docs = await loadDocs();
  assert.deepEqual(docs.map((d) => d.name), ["conversation", "js-api", "languages", "operations", "rules", "settings", "wasm"]);
  assert.equal(docs.find((d) => d.name === "wasm")!.title, "Wasm モジュール");
});

test("the index lists documents with their headings, nested by level", async () => {
  const index = docsIndex(await loadDocs());
  assert.match(index, /^wasm: Wasm モジュール$/m);
  assert.match(index, /^- ABI\n {2}- モジュールの形$/m);
});

test("reads a section with its subsections and stops at the next heading of the same level", async () => {
  const docs = await loadDocs();
  const abi = readDoc(docs, "wasm.md", "ABI");
  assert.match(abi, /^## ABI/);
  assert.match(abi, /### secretary\.call/);
  assert.doesNotMatch(abi, /## 制限/);
  assert.match(readDoc(docs, "wasm", "### 入力"), /^### 入力/);
  assert.throws(() => readDoc(docs, "wasm", "ない見出し"), /見出し「ない見出し」はありません/);
  assert.throws(() => readDoc(docs, "nothing"), /文書 nothing はありません/);
});

test("search returns lines with every word, labelled by document and heading", () => {
  const docs = [{ name: "a", title: "A", body: "# A\n\n## 一\n\nfoo bar\nfoo\n\n## 二\n\nBar Foo" }, { name: "b", title: "B", body: "# B\nfoo bar" }];
  assert.equal(searchDocs(docs, "foo bar"), "a > 一: foo bar\na > 二: Bar Foo\nb: foo bar");
  assert.equal(searchDocs(docs, "foo bar", "b"), "b: foo bar");
  assert.match(searchDocs(docs, "baz"), /見つかりませんでした/);
});

test("the agent has read_docs", async () => {
  const tools = readTools({ guild: { id: "1" }, scope: { speakerId: "1", channelId: "10" } } as never, { images: false });
  const docs = tools.find((t) => t.name === "read_docs")!;
  const out = async (params: object) => ((await docs.execute("t", params as never)).content[0] as { text: string }).text;
  assert.match(await out({}), /^conversation: 会話の使い方/m);
  assert.match(await out({ doc: "rules", section: "コマンド" }), /^## コマンド/);
  assert.match(await out({ query: "secretary.call" }), /^wasm > /m);
});
