import { test } from "node:test";
import assert from "node:assert/strict";
import { idleWorkers, warmWorkers } from "../src/wasm/run.ts";

test("idle threads past the first are stopped after ten minutes unused", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  warmWorkers(3);
  assert.equal(idleWorkers(), 3);
  t.mock.timers.tick(10 * 60_000 - 1);
  assert.equal(idleWorkers(), 3);
  t.mock.timers.tick(1);
  assert.equal(idleWorkers(), 1, "one thread stays for the next run");
  t.mock.timers.tick(60 * 60_000);
  assert.equal(idleWorkers(), 1);
});
