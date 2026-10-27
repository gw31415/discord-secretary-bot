# JavaScript の API

Botのコードはどれも読み取り専用のサンドボックスで動く JavaScript です。エンジンは WASI 向けにビルドした QuickJS-ng で、アップロードされた Wasm と同じサンドボックス・同じ ABI で動きます([Wasm](wasm.md))。外へ出る口は `secretary.call` だけで、ネットワーク・ファイル・タイマーはありません。`Math.random` と `Date` は使えます。

コードを書くのは主にBot(応答のエージェントか、コード用のエージェント)です。この文書は、コードを頼むときやルールのコードを読むときに使います。

## コードの種類

| 種類 | どこで | 返すもの |
|---|---|---|
| 調べるコード | 会話の `run_code` | 何でも(JSON にして返す) |
| 変更案のコード | 会話の `propose_plan` の `code` | `plan(steps)` か `plan(steps, [rule({...}), ...])` |
| ルールのコード | ルールの `code`。イベントのたびに動く | `null` か `plan(steps)` |

どれも関数の本体として書き、`return` で結果を返します。中の関数はすべて同期です(`await` は要りません)。投げたエラーはそのまま実行の失敗になり、メッセージが履歴やBotの返事に出ます。

## 変数

| 変数 | 中身 |
|---|---|
| `guild` | サーバーID |
| `actor` | `{ kind: "user", userId }`。だれの権限で動くか。ルールでは作成者(コマンドでは実行した人)で、`via: "rule"` が付く |
| `event` | 発火したイベント(ルールだけ。ほかは `null`) |
| `eventName` | どのきっかけで動いたか(`"CHANNEL_CREATE"` など。ルールだけ) |
| `batch` | まとめて動いたイベント `[{ eventName, event }]`、古い順(ルールだけ。まとめないときは1件) |
| `params` | ルールの `params`(ルールだけ) |
| `state` | 前回の実行で保存した値。最初は `null`(ルールだけ) |

## 関数

### 読み取り

`discord.get(route, { query })` は Discord の REST の GET を呼び、結果を返します。読める範囲の外や、一覧にないルートは例外を投げます。1回の実行で200回までです。

```js
const roles = discord.get(`/guilds/${guild}/roles`);
const recent = discord.get(`/channels/${event.channel_id}/messages`, { query: { limit: 50 } });
```

`log(...values)` は値を JSON にして1行の記録を残します。ルールでは実行履歴に、会話では `run_code` の結果に出ます(100行まで)。

### 変更のステップ

`call(op, { id, path, query, body })` はステップを1つ作ります。実行はしません。`op` は [書き込み操作の一覧](operations.md) のどれかで、`path` の `guild` は省けます。`id` は省くと自動で付きます(英数字・`-`・`_` の32文字まで)。

`plan(steps)` はステップの並びを、Botが実行する変更にします。前のステップの結果は `{ $ref: "steps.<id>.result.<フィールド>" }` で指せます。

```js
return plan([
  call("POST /guilds/{guild}/channels", { id: "room", body: { name: "📞 部屋", type: 2, parent_id: params.category } }),
  call("PATCH /guilds/{guild}/members/{user}", { path: { user: event.user_id }, body: { channel_id: { $ref: "steps.room.result.id" } } }),
]);
```

1つの変更に入るステップは100件まで、DM は50件までです。

`rule(def)` は変更案のコードの中でルールを作ります。`def` の項目は [ルールの項目](rules.md#ルールの項目) と同じで、`plan(steps, [rule(...)])` の2つ目に並べます。ルールのコードの中では使えません。

### ルールだけの関数

| 関数 | 働き |
|---|---|
| `setState(value)` | 次の実行の `state` を決める。JSON の写しを取るので、あとでオブジェクトを変えても残らない。実行が通ったときだけ保存する |
| `reply(text)` | コマンドの返事を足す。呼ぶたびに改行でつなぐ。`COMMAND` のルールだけ |

ルールのコードが `plan([...])`・`null`・`undefined` のほかを返すと、実行は失敗します。

### 判定(judge と rank)

判定モデルを持つ人のコードで使えます(ルールでは作成者の、コマンドでは実行した人の判定モデル、なければ言語モデル)。分類、条件に合うかの見分け、並べ替えなど、決まった規則で書けない判断に使います。

`judge(state, questions)` は `state`(データのオブジェクト、JSON で20,000文字まで)について、`questions`(`{ キー: 質問 }`、20個まで)にまとめて答えます。

| 質問 | 形 | 答え |
|---|---|---|
| はい・いいえ | `{ type: "bool", instructions, criteria: { true, false } }` | `{ probability }`(true である確率 0〜1) |
| 選ぶ | `{ type: "choice", instructions, criteria: { キー: 説明, ... } }`(2〜20個) | `{ choice, confidence }` |
| 点数 | `{ type: "score", instructions, criteria: [低い段階の説明, ..., 高い段階の説明] }`(2〜10段階) | `{ score, confidence }`(段階の番号、小数あり) |

`rank(items, instructions, levels?)` は `items`(20件まで)を基準で点数付けし、高い順に `[{ item, score }]` で返します。`levels` を省くと「まったく当てはまらない」から「とてもよく当てはまる」の5段階です。

```js
const a = judge({ text: event.content }, {
  spam: { type: "bool", instructions: "宣伝や詐欺の投稿か", criteria: { true: "宣伝・詐欺", false: "ふつうの発言" } },
});
if (a.spam.probability < 0.9) return null;
```

`judge` と `rank` は合わせて1回の実行で10回までです。

### Wasm を動かす(runWasm)

`runWasm(module, { input, stdin })` は登録済みの Wasm モジュールを1回動かし、`{ exitCode, stdout, logs }` を返します。会話の `run_wasm` と同じことを、コードの中からします。会話の `run_code`・変更案のコード・ルールのコードのどれでも使えます。

- `module` はモジュールの名前(自分のもの)か、同じサーバーの人が上げたモジュールの sha256(12文字以上)です。ルールとコマンドでは、名前はルールの作成者のモジュールから探します。名前は動くたびに引くので、同じ名前で上げ直すと次の実行から新しいほうが動きます。変わらないようにするなら sha256 で書きます。
- 標準入力は `run_wasm` と同じ `{ guild, actor, eventName: null, event: input, batch: null, params: null, state: null }` の JSON か、`stdin` に渡した文字列そのものです。
- モジュールの `secretary.call` は、呼んだコードと同じ読み取り範囲・判定モデル・画像で答えます。`discord.get` などの回数と実行時間は、呼んだコードと合わせて数えます。動かしたモジュールから `runWasm` はできません。
- `stdout` の `steps` は実行されません。使うなら、コードが自分の `plan(...)` に入れて返します。そのときも allow と権限の確かめはいつもどおりです。

```js
const r = runWasm("summarize", { input: { messages: discord.get(`/channels/${event.channel_id}/messages`, { query: { limit: 20 } }) } });
if (r.exitCode !== 0) throw new Error(r.logs.at(-1) ?? "失敗しました");
return plan(JSON.parse(r.stdout).steps);
```

### 画像

会話の `run_code`、変更案のコード、ルールのコードで使えます。変更案のコードで作った画像は、ステップ(投稿の `files`、絵文字の `image`、スタンプの `file`)にIDで入れられます。どの関数も画像のID(`"img1"` など)を返します。作れる枚数は、会話では1回の返答で合わせて100枚まで(返事に付くのは10枚まで)、ルールでは1回の実行で4枚までです。

| 関数 | 働き |
|---|---|
| `createCanvas(width, height)` / `attachImage(canvas, name)` | Canvas 2D で描いて PNG にする |
| `renderMath(tex, options, name)` | TeX の数式を SVG にする |
| `convertImage(source, options, name)` | 画像の大きさ・形式などを変える |

作った画像は次のところに付きます。

- 会話: 返事に付きます(1回の返事で10枚まで)。変更案の投稿・絵文字・スタンプに使った画像は返事には付きません。
- ルール: 投稿の `body.files` に ID を入れると添付されます(allow の `body` に `files` を足します)。コマンドでは作るだけで返事に付きます。

#### createCanvas

`createCanvas(幅, 高さ)` はブラウザの Canvas に似たものを返します。`getContext("2d")` で描き、`attachImage(canvas, "名前")` で画像にします。縦横1〜2048px です。

使えるメソッド: `fillRect` `strokeRect` `clearRect` `beginPath` `closePath` `moveTo` `lineTo` `arc` `arcTo` `ellipse` `rect` `roundRect` `quadraticCurveTo` `bezierCurveTo` `fill` `stroke` `clip` `fillText` `strokeText` `save` `restore` `translate` `rotate` `scale` `transform` `setTransform` `resetTransform` `setLineDash` `measureText`

使えるプロパティ: `fillStyle` `strokeStyle` `lineWidth` `lineCap` `lineJoin` `miterLimit` `lineDashOffset` `font` `textAlign` `textBaseline` `direction` `globalAlpha` `globalCompositeOperation` `shadowBlur` `shadowColor` `shadowOffsetX` `shadowOffsetY` `imageSmoothingEnabled`

- 引数は数・文字列(2000文字まで)・真偽値だけです。グラデーションや画像の読み込みはありません。
- 命令は1枚50,000個までです。
- `font` に書いたフォントのあとに、日本語と絵文字のフォント(Noto Sans CJK JP・Noto Color Emoji)を足して描きます。

```js
const c = createCanvas(400, 120);
const ctx = c.getContext("2d");
ctx.fillStyle = "#1e1f22"; ctx.fillRect(0, 0, 400, 120);
ctx.fillStyle = "#fff"; ctx.font = "32px sans-serif";
ctx.fillText(`参加者 ${n} 人`, 20, 70);
const id = attachImage(c, "count");
```

#### renderMath

`renderMath("TeX", options, "名前")` は MathJax で数式を SVG にします。Discord に送るときは PNG になります。TeX は `$` で囲まず、2000文字までです。使えるパッケージは base・ams・newcommand・boldsymbol・color・cancel・mhchem(`\ce`)です。

| オプション | 中身 |
|---|---|
| `display` | 別行立て(既定 `true`)。`false` で文中の小さな形 |
| `size` | 文字の大きさ(px、8〜200、既定32) |
| `color` / `background` | `#RRGGBB`・色の名前・`rgb()`。背景は既定で透明 |
| `padding` | 周りの余白(px、0〜200) |

#### convertImage

`convertImage(source, options, "名前")` は画像を変えて新しい画像を作ります。`source` は、この実行で作った画像のID(`"img1"`、SVG も可)か、メッセージの画像 `{ message_id, channel_id, index }`(読める範囲のメッセージだけ、20MBまでの PNG・JPEG・GIF・WebP)です。

| オプション | 中身 |
|---|---|
| `format` | `png`・`jpeg`・`webp`。既定は元の形式(なければ PNG) |
| `width` / `height` | 1〜4096px |
| `fit` | `inside`(既定、収める)・`cover`(切り抜いて埋める)・`contain`(余白を足して収める)・`fill`(引き伸ばす)・`outside` |
| `crop` | 大きさを変える前に切り抜く範囲 `{ left, top, width, height }`(元の画像の px) |
| `rotate` | 時計回りの角度(90の倍数) |
| `flip` / `flop` | 上下反転 / 左右反転 |
| `grayscale` | 白黒にする |
| `trim` | 四隅と同じ色の余白を削る |
| `background` | 透明な部分と `contain` の余白の色 |
| `quality` | JPEG・WebP の画質(1〜100、既定85) |

できあがりが4096px を超えるとエラーになります。

## 読めるルート

`discord.get` で読めるのは次のルートだけです。結果は読み取りの範囲([会話](conversation.md#読み取りの範囲)・[ルール](rules.md#読み取りの範囲))に絞られます。

| ルート | 中身 |
|---|---|
| `/guilds/{guild}` | サーバー |
| `/guilds/{guild}/roles` | ロール |
| `/guilds/{guild}/members`、`/members/search`、`/members/{user}` | メンバー |
| `/guilds/{guild}/emojis`、`/stickers`(`/{id}` で1件) | 絵文字・スタンプ |
| `/guilds/{guild}/scheduled-events` | イベント(読める範囲のチャンネルのものと、場所がチャンネルでないもの) |
| `/guilds/{guild}/channels` | 読める範囲のチャンネル |
| `/guilds/{guild}/voice-states` | ボイスチャンネルにいる人 `[{ user_id, channel_id }]` |
| `/guilds/{guild}/threads/active` | 動いているスレッド |
| `/guilds/{guild}/messages/search` | メッセージ検索。`{ messages, threads, has_more }` を返し、総数(`total_results`)は返さない。`offset` + `limit` は200まで |
| `/channels/{channel}` | チャンネル |
| `/channels/{channel}/messages`、`/messages/{message}` | メッセージ |
| `/channels/{channel}/messages/{message}/reactions/{emoji}` | その絵文字を付けた人(絵文字は 👍 か `名前:ID`) |
| `/channels/{channel}/messages/pins` | ピン留め |
| `/channels/{channel}/threads/archived/public` | アーカイブされた公開スレッド |

次のルートは、読む人たち(会話ではチャンネルを見られる全員)が権限を持つときだけ読めます。

| ルート | 要る権限 |
|---|---|
| `/guilds/{guild}/audit-logs` | 監査ログ表示 |
| `/guilds/{guild}/bans`、`/bans/{user}` | メンバーをBAN |
| `/guilds/{guild}/invites`、`/auto-moderation/rules` | サーバー管理 |

## 制限

| 項目 | 上限 |
|---|---|
| 実行時間 | 1回30秒(順番待ちと、ホストの答えを待つ時間を含む) |
| メモリ | 64MiB |
| 同時実行 | Bot全体で4つまで。ほかは順番を待つ |
| `discord.get` | 1回の実行で200回 |
| 画像 | 1回の実行で4枚 |
| `judge`・`rank` | 合わせて1回の実行で10回 |
| ルールのコード | 8000文字 |
| `setState` の値 | JSON で16,000文字 |

ルールのコードは登録のとき(と起動のとき)に QuickJS のバイトコードにして保存します。2回目からは読み込むだけで動きます。
