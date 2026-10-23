import { test } from "node:test";
import assert from "node:assert/strict";
import { runSandboxed } from "../src/sandbox.ts";
import { checkDecideInput, MAX_DECIDES_PER_RUN, parseAnswers } from "../src/agent/decide.ts";
import type { Answer, Decide, Question } from "../src/agent/decide.ts";

const limits = { wallTimeMs: 2000, memoryBytes: 32 * 1024 * 1024, maxGets: 5 };
const base = { guildId: "g", actor: { kind: "user" as const, userId: "u", via: "rule" as const }, get: async () => ({}) };

const questions: Record<string, Question> = {
  spam: { type: "bool", instructions: "スパムか", criteria: { true: "スパム", false: "違う" } },
  topic: { type: "choice", instructions: "話題", criteria: { game: "ゲーム", music: "音楽" } },
  heat: { type: "score", instructions: "熱量", criteria: ["低い", "普通", "高い"] },
};

test("a chat model's JSON is read into classifier answers, clamped to the questions", () => {
  const answers = parseAnswers('はい\n{"spam":{"probability":1.4},"topic":{"choice":"music","confidence":0.8},"heat":{"score":7,"confidence":0.6}}', questions);
  assert.deepEqual(answers.spam, { type: "bool", probability: 1 });
  assert.deepEqual(answers.topic, { type: "choice", choice: "music", probabilities: { music: 0.8 }, confidence: 0.8 });
  assert.deepEqual(answers.heat, { type: "score", score: 2, confidence: 0.6 });
  assert.throws(() => parseAnswers('{"spam":{"probability":0.1},"topic":{"choice":"art"},"heat":{"score":1}}', questions), /選択肢にありません/);
  assert.throws(() => parseAnswers('{"spam":{"probability":0.1}}', questions), /topic に答えませんでした/);
  assert.throws(() => parseAnswers("わかりません", questions), /読めませんでした/);
});

test("judge input is checked before any model is called", () => {
  assert.doesNotThrow(() => checkDecideInput({ text: "hi" }, questions));
  assert.throws(() => checkDecideInput([1], questions), /オブジェクト/);
  assert.throws(() => checkDecideInput({ text: "x".repeat(30_000) }, questions), /文字まで/);
  assert.throws(() => checkDecideInput({}, { q: { type: "score", instructions: "x", criteria: ["one"] } }), /形が違います/);
  assert.throws(() => checkDecideInput({}, {}), /形が違います/);
});

test("code can judge and rank with the judge model", async () => {
  const calls: Array<{ state: unknown; keys: string[] }> = [];
  const decide: Decide = async (state, qs) => {
    calls.push({ state, keys: Object.keys(qs) });
    const scores: Record<string, Answer> = { item0: { type: "score", score: 1, confidence: 1 }, item1: { type: "score", score: 3, confidence: 1 }, item2: { type: "score", score: 0, confidence: 1 } };
    if (qs.item0) return scores;
    return { spam: { type: "bool", probability: 0.9 } };
  };
  const r = await runSandboxed(
    `const a = judge({ text: "buy now" }, { spam: { type: "bool", instructions: "スパムか", criteria: { true: "はい", false: "いいえ" } } });
     const ranked = rank(["a", "b", "c"], "役に立つ");
     return [a.spam.probability, ranked.map((r) => r.item)];`,
    { ...base, decide },
    limits,
  );
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.value, [0.9, ["b", "a", "c"]]);
  assert.deepEqual(calls[1], { state: { items: ["a", "b", "c"] }, keys: ["item0", "item1", "item2"] });

  const bad = await runSandboxed(`return judge({}, { q: { type: "bool" } })`, { ...base, decide }, limits);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /形が違います/);

  const many = await runSandboxed(`for (let i = 0; i <= ${MAX_DECIDES_PER_RUN}; i++) rank(["x"], "y"); return 1`, { ...base, decide: async () => ({ item0: { type: "score", score: 0, confidence: 1 } }) }, limits);
  assert.equal(many.ok, false);
  assert.match(many.error ?? "", /回までです/);

  // Without a judge model the functions exist (the program is the same for every run) but say why they cannot answer.
  const without = await runSandboxed(`return judge({}, { q: { type: "bool", instructions: "x", criteria: { true: "a", false: "b" } } })`, base, limits);
  assert.equal(without.ok, false);
  assert.match(without.error ?? "", /判定モデル/);
});
