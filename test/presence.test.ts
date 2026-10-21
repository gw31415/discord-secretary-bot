import { test } from "node:test";
import assert from "node:assert/strict";
import { Presence } from "../src/discord/presence.ts";

function setup() {
  let now = 1_000_000;
  let until: number | undefined;
  const sent: string[] = [];
  const timers: Array<{ fn: () => void; at: number }> = [];
  const presence = new Presence({
    awakeUntil: (t) => (until !== undefined && until > t ? until : undefined),
    send: async (p) => void sent.push(p.status),
    now: () => now,
    log: () => undefined,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void timers.splice(timers.indexOf(timer as never), 1),
  });
  return {
    presence, sent, timers,
    wake: (ms: number) => (until = now + ms),
    advance: (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) t.fn();
    },
  };
}

test("idle while every conversation sleeps, online while one is awake", () => {
  const t = setup();
  t.presence.refresh();
  assert.deepEqual(t.sent, ["idle"]);
  t.wake(5 * 60_000);
  t.presence.refresh();
  t.presence.refresh();
  assert.deepEqual(t.sent, ["idle", "online"]);
  // Back to idle once the last one falls asleep, without anything else happening.
  t.advance(5 * 60_000 + 1000);
  assert.deepEqual(t.sent, ["idle", "online", "idle"]);
  assert.equal(t.timers.length, 0);
});

test("an extended conversation keeps it online", () => {
  const t = setup();
  t.wake(60_000);
  t.presence.refresh();
  t.advance(30_000);
  t.wake(60_000);
  t.presence.refresh();
  t.advance(40_000);
  assert.deepEqual(t.sent, ["online"]);
  assert.equal(t.timers.length, 1);
});

test("a reconnect sends the status again", () => {
  const t = setup();
  t.presence.refresh();
  t.presence.reset();
  t.presence.refresh();
  assert.deepEqual(t.sent, ["idle", "idle"]);
});
