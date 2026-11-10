import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordAPIError } from "@discordjs/rest";
import { auditActionLabel, discordErrorText, fieldLabel, permissionLabel, permissionList, permissionQuoted, PLAN_STATUS_LABEL, settingsCommand } from "../src/discord/labels.ts";
import { PERMISSION_NAMES } from "../src/plan/catalog.ts";
import { sentence } from "../src/text.ts";

test("every permission the bot names has a Japanese name; an unknown one is shown as it is", () => {
  for (const [name] of PERMISSION_NAMES) assert.notEqual(permissionLabel(name), name, name);
  assert.equal(permissionLabel("ManageEmojisAndStickers"), permissionLabel("ManageGuildExpressions"));
  assert.equal(permissionLabel("SomethingNew"), "SomethingNew");
  assert.equal(permissionLabel("toString"), "toString");
  assert.equal(permissionList(["ManageChannels", "ManageRoles"]), "チャンネルの管理・ロールの管理");
  assert.equal(permissionQuoted(["ManageChannels", "ManageRoles"]), "「チャンネルの管理」「ロールの管理」");
});

test("audit actions and change fields have names; others are shown as they are", () => {
  assert.equal(auditActionLabel("plan.approve"), "実行");
  assert.equal(auditActionLabel("llm.read_scope.set"), "読み取りの範囲の変更");
  assert.equal(auditActionLabel("some.new_action"), "some.new_action");
  assert.equal(fieldLabel("communication_disabled_until"), "タイムアウトの終了時刻");
  assert.equal(fieldLabel("video_quality_mode"), "video_quality_mode");
});

test("the common Discord errors are said in Japanese, from the error or the text kept of it", () => {
  const error = (code: number, message: string) => new DiscordAPIError({ code, message }, code, 403, "PUT", "/x", {});
  assert.equal(discordErrorText(error(50013, "Missing Permissions")), "権限が足りません");
  assert.equal(discordErrorText(error(30013, "Maximum number of guild channels reached (500)")), "Discord の上限に達しました");
  assert.equal(discordErrorText(error(50007, "Cannot send messages to this user")), "Cannot send messages to this user");
  assert.equal(discordErrorText("Unknown Message"), "メッセージがありません");
  assert.equal(discordErrorText("Invalid Form Body\nname[BASE_TYPE_REQUIRED]: This field is required"), "内容が Discord の形に合いません");
  assert.equal(discordErrorText("Maximum number of guild roles reached (250)"), "Discord の上限に達しました");
  assert.equal(discordErrorText("Missing Permissions here"), "Missing Permissions here");
  assert.equal(discordErrorText(new Error("BANできませんでした")), "BANできませんでした");
});

test("a plan's status reads as its dialog says it, and /settings links when its id is known", () => {
  assert.equal(PLAN_STATUS_LABEL.pending_approval, "実行待ち");
  assert.equal(PLAN_STATUS_LABEL.approved, "実行中");
  assert.equal(settingsCommand("42"), "</settings:42>");
  assert.equal(settingsCommand(undefined), "`/settings`");
});

test("a reason after another sentence ends with 。 unless it already ends or was cut", () => {
  assert.equal(sentence("権限が足りません"), "権限が足りません。");
  assert.equal(sentence("権限が足りません。"), "権限が足りません。");
  assert.equal(sentence("長い理由…"), "長い理由…");
  assert.equal(sentence(""), "");
});
