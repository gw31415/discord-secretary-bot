import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { convertImage, forModel, MODEL_IMAGE_SIDE, renderMath } from "../src/media.ts";
import { runSandboxed } from "../src/sandbox.ts";
import type { SandboxBindings } from "../src/sandbox.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const LIMITS = { wallTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maxGets: 1 };

test("TeX becomes a PNG sized by the font size, with ams and mhchem", async () => {
  const small = await renderMath(String.raw`\frac{a}{b} + \ce{H2O}`, { size: 16, padding: 0 });
  const large = await renderMath(String.raw`\frac{a}{b} + \ce{H2O}`, { size: 64, padding: 0 });
  assert.ok(small.subarray(0, 4).equals(PNG_MAGIC));
  const [s, l] = await Promise.all([sharp(small).metadata(), sharp(large).metadata()]);
  assert.ok(Math.abs(l.width / s.width - 4) < 0.5, `${s.width} → ${l.width}`);
  const padded = await sharp(await renderMath("x", { size: 16, padding: 10 })).metadata();
  const bare = await sharp(await renderMath("x", { size: 16, padding: 0 })).metadata();
  assert.equal(padded.width - bare.width, 20);
});

test("a TeX mistake or an extension that is not loaded comes back as an error", async () => {
  await assert.rejects(renderMath(String.raw`\frac{1}{`), /数式を描けません: Missing close brace/);
  await assert.rejects(renderMath(String.raw`\require{html}\href{https://example.com}{x}`), /Undefined control sequence \\require/);
  await assert.rejects(renderMath(String.raw`\def\a{\a}\a`), /数式を描けません/);
  await assert.rejects(renderMath("x", { color: "red;fill:url(#x)" }), /color/);
  await assert.rejects(renderMath(""), /空/);
});

test("images are resized, cropped and re-encoded", async () => {
  const source = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const jpeg = await convertImage(source, { width: 100, format: "jpeg", background: "#ffffff" });
  assert.equal(jpeg.format, "jpeg");
  assert.deepEqual(await sharp(jpeg.data).metadata().then((m) => [m.format, m.width, m.height]), ["jpeg", 100, 50]);
  const cropped = await convertImage(source, { crop: { left: 10, top: 10, width: 50, height: 40 }, rotate: 90 });
  assert.deepEqual(await sharp(cropped.data).metadata().then((m) => [m.format, m.width, m.height]), ["png", 40, 50]);
  await assert.rejects(convertImage(source, { crop: { left: 390, top: 0, width: 20, height: 10 } }), /はみ出し/);
  await assert.rejects(convertImage(Buffer.from("not an image")), /画像として読めません/);
});

test("large images are shrunk before the model sees them; small ones pass untouched", async () => {
  const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#336699" } }).png({ compressionLevel: 0 }).toBuffer();
  const shown = await forModel(big, "image/png");
  assert.equal(shown.mimeType, "image/webp");
  const meta = await sharp(shown.data).metadata();
  assert.equal(meta.width, MODEL_IMAGE_SIDE);
  assert.ok(shown.data.length < big.length);
  const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer();
  assert.deepEqual(await forModel(tiny, "image/png"), { data: tiny, mimeType: "image/png" });
  const junk = Buffer.from("junk");
  assert.deepEqual(await forModel(junk, "image/png"), { data: junk, mimeType: "image/png" });
});

test("sandboxed code calls renderMath and convertImage, and their images count toward the run's limit", async () => {
  const calls: unknown[][] = [];
  const bindings: SandboxBindings = {
    guildId: "1", actor: { kind: "user", userId: "1" }, get: async () => null,
    media: {
      math: async (tex, options, name) => (calls.push(["math", tex, options, name]), `img${calls.length}`),
      convert: async (source, options, name) => (calls.push(["convert", source, options, name]), `img${calls.length}`),
    },
  };
  const result = await runSandboxed(`
    const a = renderMath("e^{i\\\\pi}+1=0", { size: 40 }, "euler");
    const b = convertImage(a, { width: 100, format: "webp" });
    const c = convertImage({ message_id: "9", index: 1 });
    return [a, b, c];
  `, bindings, LIMITS);
  assert.ok(result.ok, result.error);
  assert.deepEqual(result.value, ["img1", "img2", "img3"]);
  assert.deepEqual(calls, [
    ["math", "e^{i\\pi}+1=0", { size: 40 }, "euler"],
    ["convert", "img1", { width: 100, format: "webp" }, ""],
    ["convert", { message_id: "9", index: 1 }, {}, ""],
  ]);
  const tooMany = await runSandboxed(`for (let i = 0; i < 5; i++) renderMath("x"); return 1;`, bindings, LIMITS);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error!, /1回の実行で4枚まで/);
});
