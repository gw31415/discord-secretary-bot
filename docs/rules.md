# ルール

ルールは「決まったことが起きたら、決まった範囲の変更をする」自動化です。きっかけ(イベント・時刻・起動・スラッシュコマンド)が来るたびに、登録したコード(JavaScript か Wasm)がサンドボックスで動き、変更の並びを返します。変更は作成者の権限で(スラッシュコマンドは実行した人の権限で)、許す操作(allow)の範囲だけ、確認なしに実行されます。ルールの実行に LLM は使いません(コードが `judge()`・`rank()` を呼んだときだけ判定モデルを使います)。

## 作り方

ルールを作る専用のコマンドはありません。会話で「〜したら〜して」と頼みます。

1. Botが要る変更(チャンネルを作るなど)とルールをまとめて1つの変更案にします。1つの案に入るルールは5件までです。
2. 案を出す前に、ルールごとにドライランをします([ドライラン](#ドライラン))。
3. 確認ダイアログに、ルールの要約・許す操作・コード・ドライランの結果が出ます。要約は、依頼を見ていない別のAIがコードだけを読んで書きます。
4. 本人が「実行」を押すと、変更のステップを実行してからルールを登録します。

承認したルールは、そのバージョンのまま動きます。中身を少しでも変えると新しいバージョンになり、もう一度承認します。直したいときも会話で頼みます(Botが `replaces_rule` に今のルールのIDを入れて案を出します)。

## ルールの項目

Botが変更案に書く項目です。会話で頼めばBotが決めますが、細かく指定することもできます。

| 項目 | 中身 |
|---|---|
| `name` | 短い名前(60文字まで) |
| `trigger_event` | きっかけ([きっかけの一覧](#きっかけの一覧)) |
| `more_trigger_events` | 同じルールを動かすほかのきっかけ。合わせて5種類まで |
| `include_bot_origin` | Bot自身が起こしたイベントでも動くか(`true`・`false`・`"other_rules"`) |
| `run_as` | コマンド・ボタン・リアクションのルールをだれとして動かすか。既定は動かした人、`"owner"` で作成者([だれとして動くか](#だれとして動くかrun_as)) |
| `schedule` / `timezone` | `SCHEDULE` の cron と時間帯(既定 `Asia/Tokyo`) |
| `debounce_seconds` | 最後のイベントから何秒待ってまとめて1回動くか(1〜300) |
| `serial_by` | 実行を順番にする単位(`"rule"` かイベントの項目のパス) |
| `limits` | `{ per_minute, max_consecutive_failures }` |
| `command` | `COMMAND` のときのスラッシュコマンド([コマンド](#コマンド)) |
| `allow` | 許す操作(10個まで、[許す操作](#許す操作allow)) |
| `code` | JavaScript の関数本体(8000文字まで、[JavaScript の API](js-api.md#ルールだけの関数)) |
| `wasm` | `code` の代わりに動かす Wasm モジュール(自分のモジュール名か、同じサーバーの人のモジュールの sha256 12文字以上) |
| `params` | コードが `params` として読む値 |
| `sample_event` | ドライランに使うイベントの例 |
| `replaces_rule` | 直す既存のルールのID |

## きっかけの一覧

コードは発火したイベントを `event` で、どのきっかけかを `eventName` で読みます。下の「event の主な項目」は Discord の Gateway のイベントの中身です。

| きっかけ | いつ | event の主な項目 |
|---|---|---|
| `MESSAGE_CREATE` | メッセージが投稿された | id, channel_id, guild_id, content, author { id, username, global_name, bot }, member { roles, nick }, mentions[], mention_roles[], attachments[], message_reference, timestamp |
| `MESSAGE_UPDATE` | メッセージが編集された | 上と同じ、と edited_timestamp |
| `MESSAGE_DELETE` | メッセージが削除された | id, channel_id, guild_id(本文と投稿者はない) |
| `MESSAGE_REACTION_ADD` | リアクションが付いた | user_id, channel_id, message_id, guild_id, member { roles, user }, emoji { id, name }, message_author_id |
| `MESSAGE_REACTION_REMOVE` | リアクションが外れた | user_id, channel_id, message_id, guild_id, emoji { id, name } |
| `GUILD_MEMBER_ADD` | メンバーが参加した | guild_id, user { id, username, global_name, bot }, roles[], nick, joined_at, communication_disabled_until |
| `GUILD_MEMBER_UPDATE` | ロールやニックネームが変わった | 上と同じ(変更前の値はない) |
| `GUILD_MEMBER_REMOVE` | メンバーが抜けた | guild_id, user { … } |
| `GUILD_BAN_ADD` / `GUILD_BAN_REMOVE` | BAN された / 解除された | guild_id, user { … } |
| `CHANNEL_CREATE` | チャンネルが作られた | id, guild_id, name, type, parent_id, topic, permission_overwrites[] |
| `CHANNEL_UPDATE` | チャンネルが変わった | 上と同じ(変更前の値はない) |
| `CHANNEL_DELETE` | チャンネルが削除された | id, guild_id, name, type, parent_id |
| `THREAD_CREATE` | スレッドが作られた | id, guild_id, name, type, parent_id, owner_id, newly_created |
| `GUILD_ROLE_CREATE` / `GUILD_ROLE_UPDATE` | ロールが作られた / 変わった | guild_id, role { id, name, permissions, position, color } |
| `GUILD_ROLE_DELETE` | ロールが削除された | guild_id, role_id |
| `GUILD_UPDATE` | サーバーの設定が変わった | id(サーバーID), name, icon, owner_id, system_channel_id, rules_channel_id, afk_channel_id |
| `VOICE_STATE_UPDATE` | ボイスチャンネルに入った・出た・移った | guild_id, user_id, channel_id(抜けたら null), before_channel_id, member { roles, user }, self_mute, self_deaf |
| `SCHEDULE` | 決まった時刻になった | guild_id, scheduled_at(発火した分の ISO 時刻), schedule, timezone |
| `BOT_READY` | Botが起動・再接続してサーバーの情報を受け取った | guild_id |
| `COMMAND` | ルールのスラッシュコマンドが実行された | guild_id, channel_id, command, user { id, username, global_name }, member { roles, nick }, options |
| `INTERACTION_CREATE` | Botのメッセージのボタン・セレクトが押された、フォームが送信された | Discord のインタラクションのまま(`token` を除く): id, type(3 ボタン・セレクト、5 フォーム送信), guild_id, channel_id, member, message, data { custom_id, component_type, values, components } |
| `TIMER` | コードが `later()` で予約した時刻になった([あとで動かす](#あとで動かすlater))。きっかけには書かない | guild_id, due_at, chain, message |

`BOT_READY` は、Botが止まっていた間の変化をまとめて反映するのに使います。`VOICE_STATE_UPDATE` の `before_channel_id` はBotが足した項目です。

チャンネルで起きたイベントは、作成者がそのチャンネルを見られるときだけルールを動かします(コマンド・ボタン・リアクションは、動かした人で判断します。[run_as](#だれとして動くかrun_as))。非公開スレッドのイベントは、作成者がそのスレッドに入っているか、スレッドの管理権限を持つときだけです。スレッドの権限は親チャンネルと同じなので、親チャンネルを見られるだけでは足りません。チャンネルのないイベント(メンバー・ロール・サーバー)はサーバー全体のものとして扱います。

### Botが起こしたイベント

Bot自身の変更で起きたイベントでは、既定でルールは動きません。ルールが自分の結果でまた動き続けるのを防ぐためです。

| `include_bot_origin` | 動くイベント |
|---|---|
| なし・`false` | Bot由来のイベントでは動かない |
| `"other_rules"` | ほかのルールや会話からの変更では動く。このルール自身の変更と、Botの投稿・リアクション(だれの変更か区別できない)では動かない |
| `true` | Botの変更すべてで動く |

何度動いても結果が同じになるルールにだけ付けます。ほかのルールの結果に合わせて直すルール(並べ替えのあとに一覧を作り直すなど)は `"other_rules"` にします。

Bot由来かどうかは、Botが直前15秒に書いた対象かで決めます。

### 時刻(SCHEDULE)

`schedule` に cron の5つの欄「分 時 日 月 曜日」を書きます。

- 書ける形は `*`、`,` の並び、`-` の範囲、`/` の間隔です。曜日は0〜7(0と7が日曜)。
- `@hourly`・`@daily`・`@weekly`・`@monthly` も使えます。
- 日と曜日の両方を指定すると、どちらかに合えば動きます(ふつうの cron と同じ)。
- `timezone` は IANA の名前(`Asia/Tokyo` など)です。

例: 毎朝4時は `0 4 * * *`、10分おきは `*/10 * * * *`。`SCHEDULE` はほかのきっかけと一緒に使えます(チャンネルの作成・変更と、毎日4時の作り直しなど)。

## まとめて実行(debounce と batch)

`debounce_seconds` を付けると、最後のイベントからその秒数だけ待ち、その間に来たイベントをまとめて1回で動かします。並べ替えで `CHANNEL_UPDATE` が何件も届くときなどに使います。

- コードはその間のイベントを `batch`(古い順の `[{ eventName, event }]`、50件まで)で読みます。`event` は最後のものです。
- イベントが続いても、最初のイベントから `debounce_seconds` の5倍たてば動きます。
- `batch` はいつもあります。まとめないルールでは1件です。

## 実行の順番(serial_by)

同じルールの実行は既定で並行に動きます。次のルールは自動で1回ずつ順番に動きます。

- `debounce_seconds` があるルール
- state を書くルール(JavaScript で `setState` を呼ぶもの。Wasm は書くかどうか分からないので、いつも順番)

前の実行の結果を前提にするときは `serial_by` を付けます。

| `serial_by` | 順番にする単位 |
|---|---|
| `"rule"` | このルールの実行すべて |
| イベントの項目のパス(`user_id`、`member.user.id` など) | その値が同じ実行どうし。値がなければルール全体 |

例: ボイスチャンネルに入ったら部屋を作り、出たら消すルールは、同じ人の入室と退室が入れ替わらないように `serial_by: "user_id"` にします。部屋の番号や掃除がほかの人の実行とぶつかるなら `"rule"` にします。

## 回数の上限と自動停止

| 項目 | 既定 | 上限 |
|---|---|---|
| `per_minute`(1分の実行回数) | 10 | 60 |
| `max_consecutive_failures`(続けて失敗したら止める回数) | 3 | 20 |

1分の回数を超えたイベントは捨てずに取っておき、枠が空いたときにまとめて1回で動かします(`batch` に入ります)。実行履歴には「回数制限」として1分に1行だけ残ります。コマンドでは、超えると実行した人に「少し待ってから」と返します。

続けて失敗すると、ルールは自分で止まり、作成者にDMで知らせます。直したら `/settings` の「ルール」から有効にします。作成者がサーバーを抜けると、その人のルールはすべて止まります。

## 許す操作(allow)

ルールが出せる変更を決める一覧です。コードが出したステップは、どれか1つの項目に合わないと実行されません。コードが何をしても、この一覧を広げることはできません。

各項目は次の形です。値はどれも JSON Schema です。

```json
{
  "op": "POST /channels/{channel}/messages",
  "path": { "channel": { "enum": ["123456789012345678"] } },
  "body": { "properties": { "content": { "type": "string", "maxLength": 200 } }, "required": ["content"], "additionalProperties": false },
  "max_steps_per_run": 1
}
```

| 項目 | 中身 |
|---|---|
| `op` | 操作([書き込み操作の一覧](operations.md)) |
| `path` | パスパラメータごとの条件。`guild` は書かない |
| `body` | 本文の条件 |
| `target` | 対象(チャンネル・ロール・メンバーなど)の、実行直前の状態の条件。例: 名前が📞で始まるチャンネルだけ消す `{ "properties": { "name": { "pattern": "^📞" } }, "required": ["name"] }` |
| `channel` | ステップが働くチャンネル(投稿・メッセージ削除・リアクションの場所)の、実行直前の状態の条件。例: あるカテゴリの中だけに投稿させる `{ "properties": { "parent_id": { "const": "<カテゴリID>" } }, "required": ["parent_id"] }` |
| `max_steps_per_run` | この項目に合うステップを1回に何件まで出せるか(1〜100)。ないときは1回の上限の100件 |

できるだけ狭くします。チャンネルやロールが決まっていれば `enum` で固定し、本文は使うフィールドだけを書いて `additionalProperties: false` にします。投稿に画像を付けるルールは、`body` に `files: { "type": "array", "maxItems": 4 }` を足します。

`target` と `channel` は実行の直前に REST で状態を読んで確かめます。`target` を付けられる操作と `channel` を付けられる操作は決まっていて、付けられない操作に付けると案が通りません。一覧全体は JSON で6000文字までです。

### 同じ回に作ったもの(madeInRun)

ルールのコードが同じ回の前のステップで作ったもの(作った部屋へ人を移すときの `channel_id` など)は、IDが前もって分かりません。このフィールドは `{ "madeInRun": true }` にします。コードの中で `$ref` を使って前のステップを指したときだけ通ります。

```json
{ "op": "PATCH /guilds/{guild}/members/{user}",
  "body": { "properties": { "channel_id": { "madeInRun": true } }, "required": ["channel_id"], "additionalProperties": false } }
```

### 権限

ルールは作成者の権限で動きます。登録のとき、作成者が allow の最悪の場合に要る権限をすべて持っているかを確かめます(チャンネルを `enum` で固定した項目は、そのチャンネルでの権限で確かめます)。実行のたびに、作成者が allow に要る権限をまだすべて持っているか(登録のときと同じ確かめ方)と、実際の値での権限とロールの上下を、もう一度確かめます。作成者が権限を失えば、その回はコードを動かさずに拒否され、続けて失敗した回に数えます。イベントを待ってまとめて動くルールや順番待ちのルールは、動き出すときに、作成者がまだそのイベントの場所を見られるかも確かめ直し、見られなくなったイベントは渡しません。

スラッシュコマンドのルールだけは、実行した人の権限で動きます。allow は上限として残り、実際にできるのは「allow の範囲」かつ「実行した人が持つ権限」の共通部分です。たとえば allow がチャンネルの作成を許していても、Manage Channels を持たない人が実行すれば、そのステップは拒否されます。作成者も、allow に要る権限を持ち続けている必要があります。作成者が権限を失うと、だれが実行してもその回は拒否されます([コマンド](#コマンド))。

ステップが働くチャンネル(投稿先・変更するチャンネル・作るチャンネルのカテゴリなど)は、実行した人とルールの作成者の両方が見られるチャンネルでなければなりません(非公開スレッドはそのメンバーか、スレッドの管理の権限を持つ人)。そうでないステップは、そのことだけを理由に拒否します。存在しないチャンネルも同じ理由です。allow の `target`・`channel` の条件は、これを通ってから対象の今の状態で確かめます。拒否の理由は実行履歴に残るので、見られないチャンネルの名前や状態が理由の違いから分からないようにするためです。

## params と $ref

`params` はコードが `params` として読む値です。ルールと一緒に作るもの(チャンネルなど)のIDは、変更案のステップの結果を `{ "$ref": "steps.<id>.result.id" }` で書きます。登録のときに実際のIDになります。`allow` の中でも同じように書けます。

```json
{
  "steps": [{ "id": "s1", "op": "POST /guilds/{guild}/channels", "body": { "name": "ログ" } }],
  "rules": [{
    "name": "入室のログ",
    "trigger_event": "GUILD_MEMBER_ADD",
    "params": { "log": { "$ref": "steps.s1.result.id" } },
    "allow": [{ "op": "POST /channels/{channel}/messages", "path": { "channel": { "enum": [{ "$ref": "steps.s1.result.id" }] } }, "max_steps_per_run": 1 }],
    "code": "return plan([call(\"POST /channels/{channel}/messages\", { path: { channel: params.log }, body: { content: `<@${event.user.id}> が参加しました` } })]);"
  }]
}
```

`madeInRun` は「実行のたびに、その回に作るもの」、変更案の `$ref` は「登録のときに一度だけ決まるもの」です。別物なので混ぜません。

## state

ルールごとに、次の実行へ値を持ち越せます。

- コードは前回の値を `state`(最初は `null`)で読み、`setState(値)` で次の値を決めます。Wasm は出力の `state` に書きます([Wasm](wasm.md#出力))。
- 保存するのは、実行が通ったとき(変更なし・実行済み)だけです。失敗した回は前の値のままなので、同じ状態からやり直せます。
- 書かなければ変わりません。JSON で16,000文字までです。
- `/settings` の「ルール」で中身を見たり消したりできます。

使い道: 前回作った一覧を覚えて差分だけ直す、回数を数える、最後に処理したメッセージIDを覚える。

## あとで動かす(later)

コードが `later(秒)` を呼ぶと、その秒数のあとに同じルールがもう一度動きます(Wasm は出力の `later`、[Wasm](wasm.md#出力))。「返事のボタンを10分後に外す」「申請を24時間後に締め切る」のように使います。

- そのときの `eventName` は `"TIMER"`、`event` は `{ guild_id, due_at(予定の時刻), chain, message? }` です。きっかけに `TIMER` は書きません。どのきっかけのルールでも使えるので、コードは `eventName` を見て分けます。
- 何のために起きたか(どのメッセージのボタンを外すか、どの申請を締め切るかなど)は、予約するときにコードが自分で [state](#state) に書いておきます。起きたら state を見て、時刻が来たものを処理し、済んだものを消します。
- `COMMAND` の実行で予約し、返事が全員に見えるときは、`event.message` `{ channel_id, id }` がその返事のメッセージです。本人だけに見える返事は Discord の API で書き換えられないので入りません。
- 予約した実行と同じ人として動きます。コマンドは実行した人、ボタン・リアクションは押した人・付けた人、時刻やほかのイベントと `run_as: "owner"` のルールは作成者です。予約したあと、ほかの人の権限で動くことはありません。
- 予約を保存するのは、実行が通ったとき(変更なし・実行済み)だけです。予約はデータベースに残るので、Botが再起動しても消えません。
- 時刻は1分ごとに確かめるので、最大1分ほど遅れます。止まっていた間に来た予約は、起動したあとに動きます。
- ルールを止めたり消したりすると、待っている予約は動かずに消えます。サーバーの全ルールが止められている間に来た予約も消えます。予約したあとにルールを直したときは、新しいバージョンのコードが動きます。
- 1分あたりの回数制限を超えたときは、1分後にもう一度試します。

無限に続かないように、上限があります。

| 項目 | 上限 |
|---|---|
| 秒数 | 60〜604,800(7日) |
| 1回の実行で予約できる数 | 10件 |
| ルールごとの待っている予約 | 100件 |
| 予約から動いた実行が、続けてまた予約できる回数 | 10回。`event.chain` は続いた回数(最初は1)で、`chain` が10の実行で `later()` を呼ぶとその回は失敗します |

決まった間隔でずっと繰り返す処理は、`later()` ではなく [SCHEDULE](#時刻schedule) で書きます。

## コマンド

`trigger_event` を `COMMAND` だけにして `command` を付けると、ルールがそのサーバーのスラッシュコマンドになります。`COMMAND` はほかのきっかけと一緒にできず、`debounce_seconds` も付けられません。

```json
{
  "name": "hello",
  "description": "あいさつを返す",
  "options": [{ "name": "who", "description": "相手", "type": "user", "required": true }],
  "permissions": ["ManageChannels"],
  "visibility": "public"
}
```

| 項目 | 中身 |
|---|---|
| `name` | 小文字・数字・`-`・`_` の32文字まで。`settings` と、同じサーバーのほかのルールのコマンド名は使えない |
| `description` | 1〜100文字 |
| `options` | 10個まで。`type` は `string`・`integer`・`number`・`boolean`・`user`・`channel`・`role`。必須のものを先に並べる。`choices`(1〜25個の `{ name, value }`)は `string`・`integer`・`number` だけ |
| `permissions` | 実行する人に要る Discord の権限名(`ManageChannels` など)。持っていない人にはコマンドが表示されず、実行のときにも確かめる |
| `visibility` | 返事を見せる相手。`auto`(既定)は返事ごとに実行した人の判定モデルが決め、迷えば本人だけ。`private` は本人だけ、`public` はチャンネルの全員 |

返事にボタンなどを付けるときは、`respond({ type: 4, data: { components: [...] } })` を呼びます。`data` のフィールドは Discord の形のまま返事に加わります(`flags` と `allowed_mentions` は除く)。`data.flags` に `64` を入れると、返事が公開のコマンドでも、その返事は実行した人だけに見えます(エラーの知らせなどに使います)。実行が失敗したときの返事も、実行した人だけに見えます。押されたときの処理は [ボタンとフォーム](#ボタンとフォーム) のルールで書きます。

実行されると、コードは `event.options`(名前から値。`user`・`channel`・`role` はID、省いたオプションは入らない)と、実行した人の `event.user`・`event.member` を読みます。`reply("文")` で返事をします(合わせて1900文字まで)。画像を作れば返事に付きます。

コマンドは、作成者ではなく実行した人として動きます(`run_as: "owner"` を付けたときは作成者として。[だれとして動くか](#だれとして動くかrun_as))。

- 変更は、allow の範囲で、さらに実行した人が持つ権限の分だけ実行します。権限が足りないステップは拒否され、その理由が返事に出ます。`permissions` を付けると、その権限がない人にはコマンドが出ず、実行もできません。
- 読み取りは、そのチャンネルを見られる全員が読めるもの(実行した人が読めるものの範囲)に限ります。返事がそのチャンネルに出るためです。
- コードの `judge()`・`rank()` と、`visibility` が `auto` のときの判定は、実行した人の判定モデル(なければ言語モデル)とキーを使います。
- 実行した人が判定モデルを設定していなくても、LLM を使わない部分はそのまま動きます。コードが `judge()`・`rank()` を呼ぶとその回はエラーになり、返事で設定を促します。`auto` の返事は本人だけに見せます。
- 実行した人の権限不足や判定モデルの未設定で失敗した回は、「続けて失敗したら自動で止める」回数に数えません。ほかの人がルールを止められないようにするためです。
- 作成者が allow に要る権限を失ったときは、だれが実行してもその回は拒否され、続けて失敗した回に数えます。ルールそのものの問題だからです。
- `state` はルールに1つで、実行した人ごとには分かれません。
- 1分あたりの回数制限は、実行した人ごとではなくルール全体で数えます。
- 変更をせず返事だけのコマンドは `allow` を空にできます。
- 確認ダイアログで返事を見せる相手を3つから選べます。指定がなければ、判定モデルがドライランの返事から既定値を選びます。あとから `/settings` の「コマンド」でも変えられます。

コマンドは、ルールが変わるたびにサーバーへ登録し直します。1つのサーバーで50個までです。

## だれとして動くか(run_as)

人が起こすイベントのルールは、既定でその人として動きます。対象は `COMMAND`(実行した人、[コマンド](#コマンド))、`INTERACTION_CREATE`(押した人)、`MESSAGE_REACTION_ADD`・`MESSAGE_REACTION_REMOVE`(付けた人・外した人)です。権限の強い作成者のルールを、ほかの人がボタンやリアクションで動かして悪用できないようにするためです。

- 変更は allow の範囲で、さらにその人が持つ権限の分だけ実行します。読み取りはその人の範囲(ボタンはそのチャンネルを見られる全員が読めるもの)で、`judge()`・`rank()` はその人の判定モデルです。
- その人の権限不足や判定モデルの未設定で失敗した回は、続けて失敗した回に数えません。
- その人がイベントのチャンネルを見られないときは動きません。
- まとめて実行するルールは、最後のイベントを起こした人として動きます。その人が見られないイベントは `batch` から除きます。
- Bot自身のリアクションでは作成者として動きます。

その人にない権限が要るとき(リアクションでロールを付ける、申請を押した人が見られない管理チャンネルに投稿する、コマンドの返事のボタンを `later()` であとから外すなど)は、`run_as: "owner"` で作成者として動かします。コマンドでは、実行できる人やチャンネルを見られるかは今までどおり実行した人で確かめ、変更・読み取り・判定モデルが作成者のものになります。確認画面とルールの画面には ⚠️ が出ます。`run_as` はほかのきっかけには付けられません。

## ボタンとフォーム

Botの投稿にボタンやセレクトを付け、押した人だけにフォーム(モーダル)を出し、送信された内容をルールで受け取れます。

1. 投稿のステップの `body.components` に、Discord のコンポーネントをそのまま書きます([書き込み操作](operations.md))。Botの投稿のボタンを変えるときは `PATCH /channels/{channel}/messages/{message}` の `components` です。
2. 押されたときの処理を、きっかけ `INTERACTION_CREATE` のルールにします。

```js
const d = event.data;
if (event.type === 3 && d.custom_id === "apply:open") {
  // 押した人だけにフォームを出す
  respond({ type: 9, data: { custom_id: "apply:form", title: "参加申請", components: [
    { type: 1, components: [{ type: 4, custom_id: "why", label: "理由", style: 2, required: true }] },
  ] } });
  return null;
}
if (event.type === 5 && d.custom_id === "apply:form") {
  const why = d.components.flatMap((row) => row.components ?? [row.component]).find((c) => c.custom_id === "why").value;
  respond({ type: 4, data: { content: "受け付けました", flags: 64 } });
  return plan([call("POST /channels/{channel}/messages", { path: { channel: params.staff }, body: { content: `<@${event.member.user.id}> の申請: ${why}` } })]);
}
return null;
```

- 押されるたびに、サーバーの `INTERACTION_CREATE` のルールがすべて動きます。コードは `event.data.custom_id` で自分のボタンか確かめ、違えば `null` を返します。フォームの送信(`event.type` 5)も同じルールに届きます。
- ルールは既定で押した人として動きます。コマンドと同じく、変更は allow の範囲で押した人が持つ権限の分だけ、読み取りはそのチャンネルを見られる全員が読めるもの、`judge()`・`rank()` は押した人の判定モデルです。押した人にない権限が要るときは `run_as`([だれとして動くか](#だれとして動くかrun_as))を `"owner"` にします。押した人は `event.member` で分かります。
- `respond({ type, data })` で押した人に応答します。`type` と `data` は Discord のインタラクション応答のままです。`9` はフォーム(押した人だけに出る)、`4` はメッセージ(`data.flags` に `64` で押した人だけ)、`7` はボタンのメッセージの書き換え、`6` は何も変えずに受け付けるだけです。応答のメンションは通知しません。
- Discord は3秒以内の応答を求め、フォームは最初の応答でしか出せません。そのためフォームはコードが返ってすぐに出し、ほかの応答は変更を実行したあとに出します。変更が失敗したときは、応答の代わりに「ルール「…」の実行に失敗しました」を押した人だけに出します。
- 2.5秒たっても応答がないときは、何も変えずに受け付けます。そのあとの `4` は追加のメッセージ、`7` はボタンのメッセージの書き換えになります。フォームは出せず、その回は失敗として記録します。`judge()` などで時間がかかるときは、フォームを先に出す作りにします。
- 動くルールがないときは「これに応えるルールは今はありません」を押した人だけに出します。
- `custom_id` は `llm`・`rule`・`plan`・`widen`・`wasm` で始めないでください。Botの画面が使っています。ほかのルールと重ならない名前にします。
- `debounce_seconds` は付けられません。押されるたびに1回ずつ動き、1分あたりの回数を超えた分は動かさず「混み合っています」と出します。
- 応答だけで変更をしないルールは `allow` を空にできます。

## 読み取りの範囲

イベント・時刻・ボタンのルールのコードが読めるのは、作成者とBotの両方が読めるものです。コマンドのルールは、そのチャンネルを見られる全員(と実行した人)が読めるものです。読めるルートは [JavaScript の API](js-api.md#読めるルート) にあります。

## ドライラン

案を出すときと、管理画面の「ドライラン」で、ルールのコードを1回動かします。何も変更せず、state も保存しません。使うイベントは次の順に選びます。

| きっかけ | 試すイベント |
|---|---|
| `COMMAND` | 依頼者がこのチャンネルで実行したとき(オプションは `sample_event.options`、なければ選択肢の最初か仮の値) |
| `SCHEDULE`・`BOT_READY` | いま発火したとしたときのイベント |
| `MESSAGE_CREATE`・`MESSAGE_UPDATE` | このチャンネルの直近の(人の)メッセージ |
| `GUILD_MEMBER_ADD`・`GUILD_MEMBER_UPDATE` | 依頼者のメンバー情報 |
| そのほか | `sample_event` |

試せるイベントがなく `sample_event` もないときは、案が通りません(Botが例のイベントを付けて出し直します)。ドライランは、出したステップが allow と権限に合うかも確かめます。合わなければ案は通りません。ルールと一緒に作るものの値(`$ref`)を使うルールは、登録まで試せないので、コードがエラーにならないことだけを確かめます。

## 実行の結果

実行履歴の結果は次のどれかです。

| 結果 | 意味 |
|---|---|
| `no_change` | 変更なし(コードが何も返さなかった、または空の `plan([])`) |
| `executed` | 実行した |
| `rejected` | allow・権限・形の検査で拒否した |
| `failed` | コードのエラー、時間切れ、実行の失敗など |
| `rate_limited` | 回数制限で後回しにした |

会話でBotに「ルールが動かない」と聞くと、Botが `list_rules`・`rule_runs` で中身と履歴を読んで調べます。

## 管理画面

`/settings` の「ルール」で開きます。ルールを選ぶと概要が出て、「詳しく見る」から許す操作・コード・実行履歴に移れます。

| できること | だれが |
|---|---|
| 自分のルールを見る・有効にする・止める・削除する・ドライラン・state を消す | 作成者 |
| ほかの人のルールと、サーバー全体の監査ログを見る | 監査ログ表示(View Audit Log)の権限を持つ人 |
| ほかの人のルールを止める | サーバー管理(Manage Server)と、そのルールの allow に要る権限をすべて持つ人 |
| 全ルールの緊急停止・再開 | サーバー管理の権限を持つ人。すぐに効く |

一覧の下に「変更の履歴」(Planの履歴)と「監査ログ」もあります。削除しても実行履歴と監査ログは残ります。
