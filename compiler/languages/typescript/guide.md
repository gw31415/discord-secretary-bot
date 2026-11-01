# TypeScript(scriptc)でモジュールを書く

[scriptc](https://scriptc.dev) 0.4.7(Vercel Labs、試験的)で TypeScript をネイティブの Wasm にします。JavaScript エンジンは入りません。型検査は本物の TypeScript で、型の誤りはコンパイルで見つかります。`main.ts` が入口で、最上位に書いたコードがそのまま1回動きます。ほかの `.ts` は `import { f } from "./util"` で読めます。SDK は `import { input, get, output } from "./secretary"` です(`secretary.ts` は自動で隣に置かれます)。

- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません。メモリは64MiB まで
- `console.log`・`console.error` はログ(標準エラー出力)に出ます。結果は必ず `output()` で書きます
- 捕まえなかった例外はそのメッセージ(`Uncaught RangeError: …`)が失敗の理由になります
- npm のパッケージ・tsconfig.json は使えません。使えるのは標準の API(scriptc が対応するもの)と SDK だけです
- できるモジュールは300〜600KB です

## 書けないもの

ライブラリとしてビルドするので、次のものはコンパイルエラー(`SC4005`)になります。ホスト関数は同期なので、なくても困りません。

- `async`・`await`・`Promise`・ジェネレーターの `yield` を待つ形
- `setTimeout`・`setInterval` などのタイマー

標準ライブラリの型にはあっても scriptc がまだ対応していないものは `SC2020`(例: `Function.name`・`this.constructor.name`、深さの違う配列の `.flat()`)になります。エラーの hint に従って書き換えてください。

## 型と JSON

`unknown` の値を `as` で型にすると、動くときに中身を確かめます。合わないと `TypeError: expected array at $.seen, got undefined` のように場所つきで失敗します。

- 来ないかもしれないフィールドは `?`(`seen?: string[]`)か `| null` にします。最初の実行の `state` は `null` です
- `JSON.parse(s) as T`・`get(...) as Role[]` のように受け取った JSON に型を付けて使います。余分なフィールドは無視されます
- 型を決めにくいところは `unknown` のままにし、`typeof` で分けます

class・継承・abstract・ジェネリクス・`enum`・ユニオン型・`Map`・`Set`・分割代入・スプレッド・オプショナルチェーン・正規表現・`Date`・`BigInt`・テンプレート文字列・`try/catch/finally` は使えます。文字列は UTF-8 で持ちます(`[...s].length` は文字数)。

## SDK

```ts
import { input, call, get, output, HostError } from "./secretary";

input(): Input                // 標準入力の JSON { guild, actor, eventName, event, batch, params, state }
call(request): unknown        // { fn: ..., ... } を送り value を返す。失敗は HostError を投げる
get(route, query?): unknown   // Discord REST の GET(作成者が読める範囲)。query は { limit: 1 } など
output(result: Output): void  // 標準出力に { steps?, state?, reply?, response?, later? }。最後に1回だけ
inputRaw(): string            // 標準入力そのまま
callRaw(request: string): string  // 生の要求と応答({ value } か { error })
```

`Input` の `event`・`params`・`state` は `unknown` です。自分の型を作って `as` で付けます。`limit` などのクエリは `get("/channels/" + id + "/messages", { limit: 1 })` のように渡します(route に `?limit=1` と書いても同じに扱います)。読めるルートと使えるクエリは docs の「読めるルート」を見てください。

## 例: コマンドに返事をする

```ts
import { input, get, output, HostError } from "./secretary";

interface Guild { name: string }

const data = input();
let name = "このサーバー";
try {
  name = (get(`/guilds/${data.guild}`) as Guild).name;
} catch (e) {
  if (!(e instanceof HostError)) throw e;
  console.log("get failed:", e.message);
}
output({ reply: `ここは ${name} です`, steps: [] });
```

## 例: メッセージを投稿する

```ts
import { input, output } from "./secretary";

interface MessageEvent { channel_id: string }

const event = input().event as MessageEvent;
output({ steps: [{
  op: "POST /channels/{channel}/messages",
  path: { channel: event.channel_id },
  body: { content: "こんにちは" },
}] });
```

## 例: state で数える

```ts
import { input, output } from "./secretary";

interface State { count: number }

const state = (input().state ?? { count: 0 }) as State;
const count = state.count + 1;
output({ state: { count }, reply: `${count} 回目です`, steps: [] });
```

## 例: params とホスト関数

```ts
import { input, call, output } from "./secretary";

interface Params { words?: string[] }

const params = (input().params ?? {}) as Params;
const ranked = call({ fn: "rank", items: params.words ?? [], instructions: "楽しそうな順" }) as { item: string; score: number }[];
output({ reply: ranked.map((r) => r.item).join("、"), steps: [] });
```
