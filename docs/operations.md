# 書き込み操作の一覧

Botが行える書き込みは、下の表の操作だけです。`PATCH /guilds/123/emojis/456` のように、パスにIDを書き込んだ形でも同じ操作として扱います。ほかの操作と、表の本文にないフィールドは拒否します。この表(`src/plan/catalog.ts`)はコードと一緒に置き、手で見直します。

会話の変更案もルールも同じ表で同じように確かめます。

- 操作する人(ルールでは作成者)とBotの両方が、要る権限を持っていること。チャンネルの操作はそのチャンネルの権限で、ほかはサーバーの権限で確かめます。
- ロールやメンバーを対象にする操作は、対象が操作する人とBotの両方より下にあること。
- 権限を渡す操作(ロールの権限・権限の上書き)は、渡す権限を操作する人とBotの両方が持っていること。
- 読み取りの範囲の外のチャンネルを、確認ダイアログに出さないこと。

## 操作

| 操作 | 内容 | 危険度 | 要る権限 |
|---|---|---|---|
| `POST /channels/{channel}/messages` | 投稿(`content`、`files` に画像ID、`components` にボタン・セレクトなど、`flags`) | 書き込み | チャンネルを見る・メッセージを送信 |
| `PATCH /channels/{channel}/messages/{message}` | Botの投稿を編集(`content`・`components`・`flags`) | 書き込み | チャンネルを見る・履歴を読む・メッセージの管理 |
| `DELETE /channels/{channel}/messages/{message}` | メッセージ削除 | 破壊的 | チャンネルを見る・履歴を読む・メッセージの管理 |
| `POST /channels/{channel}/messages/bulk-delete` | メッセージ一括削除(2〜100件、2週間以内) | 破壊的 | 同上 |
| `PUT /channels/{channel}/messages/{message}/reactions/{emoji}/@me` | リアクションを付ける | 書き込み | チャンネルを見る・履歴を読む・リアクションの追加 |
| `DELETE …/reactions/{emoji}/@me` | Botのリアクションを外す | 書き込み | チャンネルを見る・履歴を読む |
| `DELETE …/reactions/{emoji}/{user}` | ほかの人のリアクションを外す | 書き込み | チャンネルを見る・履歴を読む・メッセージの管理 |
| `PUT /channels/{channel}/messages/pins/{message}` | ピン留め | 書き込み | チャンネルを見る・メッセージのピン留め |
| `DELETE /channels/{channel}/messages/pins/{message}` | ピン留め解除 | 書き込み | 同上 |
| `POST /guilds/{guild}/channels` | チャンネル作成 | 書き込み | チャンネルの管理(権限の上書きを付けるならロールの管理も) |
| `PATCH /channels/{channel}` | チャンネル変更 | 書き込み(権限の上書きを変えると破壊的) | チャンネルの管理(権限の上書きならロールの管理も) |
| `DELETE /channels/{channel}` | チャンネル削除 | 破壊的 | チャンネルの管理 |
| `PUT /channels/{channel}/permissions/{overwrite}` | 権限上書きの設定 | 破壊的 | ロールの管理 |
| `DELETE /channels/{channel}/permissions/{overwrite}` | 権限上書きの削除 | 破壊的 | ロールの管理 |
| `POST /channels/{channel}/threads` | スレッド作成(11=公開、12=非公開) | 書き込み | チャンネルを見る(と種類に応じた権限) |
| `POST /guilds/{guild}/roles` | ロール作成 | 書き込み | ロールの管理 |
| `PATCH /guilds/{guild}/roles/{role}` | ロール変更 | 書き込み(権限を変えると破壊的) | ロールの管理 |
| `DELETE /guilds/{guild}/roles/{role}` | ロール削除 | 破壊的 | ロールの管理 |
| `PUT /guilds/{guild}/members/{user}/roles/{role}` | ロール付与 | 書き込み | ロールの管理 |
| `DELETE /guilds/{guild}/members/{user}/roles/{role}` | ロール解除 | 書き込み | ロールの管理 |
| `PATCH /guilds/{guild}/members/{user}` | メンバー変更 | 書き込み | フィールドごと(下の表) |
| `DELETE /guilds/{guild}/members/{user}` | キック | 破壊的 | メンバーをキック |
| `PUT /guilds/{guild}/bans/{user}` | BAN(`delete_message_seconds` 0〜604800) | 破壊的 | メンバーをBAN |
| `DELETE /guilds/{guild}/bans/{user}` | BAN解除 | 書き込み | メンバーをBAN |
| `POST /users/{user}/dm` | DM送信(`content`、`files`) | 破壊的 | サーバー管理 |
| `POST /guilds/{guild}/emojis` | 絵文字の登録(`name`、`image` に画像、`roles`) | 書き込み | エクスプレッションを作成 |
| `PATCH /guilds/{guild}/emojis/{emoji}` | 絵文字の変更(`name`、`roles`) | 書き込み | エクスプレッションを管理 |
| `DELETE /guilds/{guild}/emojis/{emoji}` | 絵文字の削除 | 破壊的 | エクスプレッションを管理 |
| `POST /guilds/{guild}/stickers` | スタンプの登録(`name`、`file` に画像、`tags`、`description`) | 書き込み | エクスプレッションを作成 |
| `PATCH /guilds/{guild}/stickers/{sticker}` | スタンプの変更(`name`、`tags`、`description`) | 書き込み | エクスプレッションを管理 |
| `DELETE /guilds/{guild}/stickers/{sticker}` | スタンプの削除 | 破壊的 | エクスプレッションを管理 |

メンバー変更の本文には次のフィールドがあります。

| フィールド | 中身 | 要る権限 |
|---|---|---|
| `nick` | ニックネーム(32文字まで、`null` で消す) | ニックネームの管理 |
| `communication_disabled_until` | タイムアウトの終了時刻(最長28日後、`null` で解除) | メンバーをタイムアウト |
| `mute` / `deaf` | サーバーミュート / スピーカーミュート | メンバーをミュート / スピーカーミュート |
| `channel_id` | ボイスチャンネルの移動先(`null` で切断) | メンバーを移動 |

ロールの上下はニックネームとタイムアウトのときだけ確かめます(Discord と同じ)。

リアクションの `{emoji}` は 👍 のような絵文字か、カスタム絵文字の `名前:ID` です。絵文字の変更・削除の `{emoji}` は絵文字のIDです。投稿と DM の `files` には同じ返事やルールの実行で作った画像のID(`img1` など、10枚まで)を入れます。本文 `content` は2000文字までです。

### 絵文字とスタンプ

絵文字の `image` とスタンプの `file` には、用意した画像のID(`img1` など)か、メッセージに添付された画像 `{ message_id, channel_id?, index? }` を入れます。添付はそのまま使います(GIF は動いたまま)。変更案に使う画像は返事に付ける画像(10枚まで)に数えないので、1つの変更でまとめて登録できます(1回の返答で用意できる画像は100枚まで)。確認ダイアログには最初の10枚を表示します。スタンプの `description` と `tags` は省略でき、省略すると空と名前で送ります。ほかのフィールドは Discord の API のとおりです。削除は画像を残さないので戻せません。

## 確認の決まり

会話の変更案は、確認ダイアログで本人が押して実行します。押し方は操作で変わります。

- 戻せる操作だけなら、「実行」を1回押します。
- 戻せない操作で失うものが大きいときは、対象の名前(1件のとき)か、戻せない操作の件数を入力します。

戻せない操作は、メッセージの削除・一括削除、ほかの人のリアクションを外す、チャンネル削除、ロール削除、キック、メッセージを消す BAN、DM、ボイスチャンネルの移動、絵文字とスタンプの削除です。このうち次のものは1回押すだけで済みます。

- ボイスチャンネルの移動・切断
- 一度もメッセージがないチャンネルの削除
- 1つの変更で3件までのメッセージ削除
- 1つの変更で10件までの DM(本文はダイアログに出ます)

ルールの変更は、登録のときの承認で確認済みとします。実行のたびには聞きません。

1つの変更に入るステップは100件まで、DM は50件まで(1秒に1件ずつ送る)です。

## まとめて送る操作

実行器は隣り合う同じ種類のステップを Discord の一括 API で1回にまとめます。確認・権限・記録はステップごとのままです。

| まとめるもの | 使う API |
|---|---|
| チャンネルの位置・カテゴリ | `PATCH /guilds/{guild}/channels` |
| ロールの位置 | `PATCH /guilds/{guild}/roles` |
| 同じチャンネルの2週間以内のメッセージ削除 | `POST /channels/{channel}/messages/bulk-delete` |
| 同じ `delete_message_seconds` の BAN | `POST /guilds/{guild}/bulk-ban` |
| 同じメンバーのロールの付け外し(3件以上) | `PATCH /guilds/{guild}/members/{user}`(直前に読む) |
| 同じチャンネルの権限上書き(3件以上) | `PATCH /channels/{channel}`(直前に読む) |
| 同じ対象への続けての PATCH | 1回の PATCH |

あとのステップが `$ref` で結果を指すステップは、まとめません。
