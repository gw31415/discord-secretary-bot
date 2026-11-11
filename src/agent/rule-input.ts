import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { MAX_ALLOW_ENTRIES } from "../rules/allow.ts";
import { MAX_OPTIONS, OPTION_TYPES } from "../rules/command.ts";
import type { CommandSpec } from "../rules/command.ts";
import { MAX_DEBOUNCE_SECONDS, MAX_TRIGGER_EVENTS } from "../rules/triggers.ts";
import { MAX_LIMITS } from "../rules/types.ts";
import type { RuleProposal } from "../rules/types.ts";

const AllowSchema = Type.Object({
  op: Type.String(),
  path: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), { description: "パスパラメータ名 → JSON Schema。例: { channel: { enum: [\"123\"] } }" })),
  body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "本文の JSON Schema" })),
  target: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "対象(チャンネル・ロール・メンバーなど)の実行直前の状態が満たすべき JSON Schema" })),
  channel: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "ステップが働くチャンネル(投稿先など)の実行直前の状態が満たすべき JSON Schema" })),
  max_steps_per_run: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const RULE_FIELDS = {
  name: Type.String({ minLength: 1, maxLength: 60, description: "ルールの短い名前" }),
  trigger_event: Type.String(),
  more_trigger_events: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_TRIGGER_EVENTS - 1, description: "同じルールを動かすほかのきっかけ" })),
  include_bot_origin: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("other_rules")])),
  run_as: Type.Optional(Type.Union([Type.Literal("presser"), Type.Literal("owner")], { description: "COMMAND・INTERACTION_CREATE・リアクションだけ。既定は実行した人・押した人" })),
  schedule: Type.Optional(Type.String({ maxLength: 100, description: "SCHEDULE の cron(分 時 日 月 曜日)" })),
  timezone: Type.Optional(Type.String({ maxLength: 64 })),
  debounce_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DEBOUNCE_SECONDS })),
  serial_by: Type.Optional(Type.String({ maxLength: 64, description: "\"rule\" か、イベントの項目のパス(user_id など)" })),
  limits: Type.Optional(
    Type.Object({
      per_minute: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMITS.perMinute })),
      max_consecutive_failures: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMITS.maxConsecutiveFailures })),
    }),
  ),
  allow: Type.Array(AllowSchema, { maxItems: MAX_ALLOW_ENTRIES, description: "COMMAND で返事だけ、INTERACTION_CREATE で応答だけのときは空でかまいません" }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sample_event: Type.Optional(Type.Unknown()),
  replaces_rule: Type.Optional(Type.String()),
  wasm: Type.Optional(Type.String({ description: "コードの代わりに動かすアップロード済みWasmモジュール(話し手のモジュール名か sha256)" })),
  command: Type.Optional(
    Type.Object(
      {
        name: Type.String({ maxLength: 32, description: "コマンド名(小文字・数字・-・_)" }),
        description: Type.String({ maxLength: 100 }),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({ maxLength: 32 }),
              description: Type.String({ maxLength: 100 }),
              type: Type.Union(Object.keys(OPTION_TYPES).map((k) => Type.Literal(k))),
              required: Type.Optional(Type.Boolean()),
              choices: Type.Optional(Type.Array(Type.Object({ name: Type.String(), value: Type.Union([Type.String(), Type.Number()]) }), { maxItems: 25 })),
            }),
            { maxItems: MAX_OPTIONS },
          ),
        ),
        permissions: Type.Optional(Type.Array(Type.String(), { description: "実行する人に必要な Discord 権限名(例: ManageChannels)" })),
        visibility: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("private"), Type.Literal("public")], { description: "返事を見せる相手。auto(既定)は返事ごとに判定用のモデルが決め、private は実行した人だけ、public はチャンネルの全員" })),
      },
      { description: "trigger_event が COMMAND のときのスラッシュコマンド" },
    ),
  ),
};
export const RuleSchema = Type.Object({ ...RULE_FIELDS, code: Type.Optional(Type.String({ maxLength: 8000 })) });
export type RuleInput = Static<typeof RuleSchema>;
/** With a coding model, the agent describes each rule's code and the coder writes it. */
export const CodedRuleSchema = Type.Object({
  ...RULE_FIELDS,
  code_task: Type.Optional(Type.String({ maxLength: 4000, description: "イベントごとに何を確かめて何をするコードか(wasm のときは不要)" })),
});
export type CodedRuleInput = Static<typeof CodedRuleSchema>;

/** The rule's own settings go with its task, so the coder knows what it may do. */
export function ruleTask(r: CodedRuleInput & { code_task: string }): string {
  return [
    r.code_task,
    "",
    `きっかけ: ${[r.trigger_event, ...(r.more_trigger_events ?? [])].join("、")}${r.more_trigger_events?.length ? "(どれで動いたかは eventName で分かります)" : ""}`,
    ...(r.schedule ? [`時刻: cron ${r.schedule}(${r.timezone ?? "Asia/Tokyo"})`] : []),
    ...(r.command ? [`スラッシュコマンド: ${JSON.stringify(r.command)}(オプションは event.options、返事は reply("文"))`] : []),
    ...(r.debounce_seconds ? [`まとめて実行: 最後のイベントから${r.debounce_seconds}秒待って1回だけ動きます。その間のイベントは batch(古い順の [{ eventName, event }])で全部読め、event は最後のものです`] : []),
    `params: ${JSON.stringify(r.params ?? null)}`,
    `許す操作: ${JSON.stringify(r.allow)}`,
    ...(r.replaces_rule ? [`直すルール: ${r.replaces_rule}(list_rules・rule_runs で今のコードと実行履歴を見られます)。依頼で言われていない返事の形(文面の書き方・画像・ボタン)は前の版のまま変えないでください。`] : []),
    ...(r.sample_event !== undefined ? [`イベントの例: ${JSON.stringify(r.sample_event).slice(0, 2000)}`] : []),
  ].join("\n");
}

export function toProposal(r: RuleInput): RuleProposal {
  return {
    name: r.name.slice(0, 60),
    trigger: {
      event: r.trigger_event,
      ...(r.more_trigger_events?.length ? { events: r.more_trigger_events.filter((e) => e !== r.trigger_event) } : {}),
      ...(r.include_bot_origin ? { includeBotOrigin: r.include_bot_origin } : {}),
      ...(r.run_as === "owner" ? { runAs: "owner" as const } : {}),
      ...(r.schedule !== undefined ? { schedule: r.schedule } : {}),
      ...(r.timezone !== undefined ? { timezone: r.timezone } : {}),
      ...(r.debounce_seconds ? { debounceSeconds: r.debounce_seconds } : {}),
      ...(r.serial_by ? { serialBy: r.serial_by } : {}),
      ...(r.command ? { command: r.command as CommandSpec } : {}),
    },
    ...(r.limits
      ? { limits: { ...(r.limits.per_minute ? { perMinute: r.limits.per_minute } : {}), ...(r.limits.max_consecutive_failures ? { maxConsecutiveFailures: r.limits.max_consecutive_failures } : {}) } }
      : {}),
    allow: r.allow.map((a) => ({
      op: a.op,
      ...(a.path ? { path: a.path } : {}),
      ...(a.body ? { body: a.body } : {}),
      ...(a.target ? { target: a.target } : {}),
      ...(a.channel ? { channel: a.channel } : {}),
      ...(a.max_steps_per_run ? { maxStepsPerRun: a.max_steps_per_run } : {}),
    })),
    program: r.wasm ? { kind: "wasm", module: r.wasm } : { kind: "js", code: r.code ?? "" },
    ...(r.params ? { params: r.params } : {}),
    ...(r.sample_event !== undefined ? { sampleEvent: r.sample_event } : {}),
    ...(r.replaces_rule ? { replaces: r.replaces_rule } : {}),
  };
}

/** Rules returned from plan code, checked like the tool's own parameter. */
export function rulesFromCode(value: unknown): RuleProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("plan(steps, rules) の rules は配列にしてください");
  return value.map((r, i) => {
    if (!Value.Check(RuleSchema, r)) {
      const problems = [...Value.Errors(RuleSchema, r)].slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`);
      throw new Error(`rules[${i}] の形が違います: ${problems.join("; ")}`);
    }
    return toProposal(r);
  });
}
