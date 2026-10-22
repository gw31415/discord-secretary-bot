import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCanvas } from "../src/canvas.ts";
import { runSandboxed } from "../src/sandbox.ts";
import type { SandboxBindings } from "../src/sandbox.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const LIMITS = { wallTimeMs: 5_000, memoryBytes: 64 * 1024 * 1024, maxGets: 1 };

function bindings(attached: Array<{ png: Buffer; name: string }>): SandboxBindings {
  return {
    guildId: "1", actor: { kind: "user", userId: "1" }, get: async () => null,
    attach: (png, name) => (attached.push({ png, name }), `img${attached.length}`),
  };
}

test("code draws on a recording canvas and the host replays it into a PNG", async () => {
  const attached: Array<{ png: Buffer; name: string }> = [];
  const result = await runSandboxed(`
    const c = createCanvas(320, 120);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.save(); ctx.fillStyle = "tomato"; ctx.beginPath(); ctx.arc(60, 60, 40, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.setLineDash([4, 2]); ctx.strokeRect(120, 20, 80, 80);
    ctx.font = "20px sans-serif";
    const width = ctx.measureText("メンバー").width;
    ctx.fillText("メンバー", 220, 60);
    return { id: attachImage(c, "chart"), width, fill: ctx.fillStyle };
  `, bindings(attached), LIMITS);
  assert.ok(result.ok, result.error);
  const value = result.value as { id: string; width: number; fill: string };
  assert.equal(value.id, "img1");
  assert.ok(value.width > 0);
  // restore() brings back the style that was set before save().
  assert.equal(value.fill, "#fff");
  assert.equal(attached[0]!.name, "chart");
  assert.ok(attached[0]!.png.subarray(0, 4).equals(PNG_MAGIC));
});

test("only listed drawing calls with plain arguments exist, and sizes and counts are capped", async () => {
  const attached: Array<{ png: Buffer; name: string }> = [];
  const run = (code: string) => runSandboxed(code, bindings(attached), LIMITS);
  assert.match((await run(`createCanvas(10, 10).getContext("2d").drawImage("x", 0, 0); return 1;`)).error!, /not a function/);
  assert.match((await run(`createCanvas(10, 10).getContext("webgl"); return 1;`)).error!, /"2d" だけ/);
  assert.match((await run(`return attachImage(createCanvas(5000, 10));`)).error!, /2048/);
  assert.match((await run(`for (let i = 0; i < 5; i++) attachImage(createCanvas(4, 4)); return 1;`)).error!, /4回まで/);
  // Without the binding, there is no canvas at all (rules, plan code).
  const plain = await runSandboxed(`return typeof createCanvas;`, { guildId: "1", actor: { kind: "user", userId: "1" }, get: async () => null }, LIMITS);
  assert.equal(plain.value, "undefined");
  // The host checks the record itself, not only the guest's helpers.
  assert.throws(() => renderCanvas(10, 10, [["drawImage", "x", 0, 0]]), /使えません/);
  assert.throws(() => renderCanvas(10, 10, [["fillRect", { toString: 1 }, 0, 1, 1]]), /数値か文字列/);
  assert.throws(() => renderCanvas(10, 10, [["=", "__proto__", 1]]), /数値か文字列/);
  assert.ok(renderCanvas(10, 10, [["fillRect", 0, 0, 10, 10]]).subarray(0, 4).equals(PNG_MAGIC));
});
