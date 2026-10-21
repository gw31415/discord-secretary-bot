# discord-admin-bot

内輪の1サーバー向けの管理者Discord Botです。設計は「管理者Discord Bot 設計書」と「詳細仕様」にあります。

現在は **Phase 1**(読み取り専用の対話と `/llm`)を実装しています。

- **対話モード**: Botをメンションすると、そのチャンネル(スレッドは別扱い)で会話が始まります。メンションやBotへの返信には必ず答え、それ以外の発言は宛先判定モデルで「Bot宛てか」を判定して答えます。自分宛ての発言が5分途切れると眠ります。
- **`/llm`**: 本人にだけ見えるパネルで、APIキー(Claude API / OpenCode Go)と、応答に使うモデル・宛先判定に使うモデルを設定します。どちらのモデルも必須で、自動では選びません。設定が終わっていない人の発言は無視し、メンションされたときだけ設定を促すDMを会話ごとに1回送ります。
- **読み取りの制限**: Botは管理者権限で何でも読めるため、応答に使える情報を「話し手が読めて、かつ今のチャンネルを見られる全員が読めるチャンネル」に決定的に絞ります。読める経路は許可リスト方式で、それ以外は拒否します。
- **ツール**: 履歴の取得(1応答あたり最大500件)、サーバー内メッセージ検索、チャンネル一覧、メンバー検索、読み取り専用サンドボックス(QuickJS/WASM)でのコード実行。Claudeのモデルではサーバー側Web検索も使います(`WEB_SEARCH=off` で無効)。

## 必要なもの

- Node.js 24 以降(22.18 以降でも動きます。TypeScriptは型除去でそのまま実行します)
- Discord Developer Portal で作ったアプリケーション
  - Bot の **Privileged Gateway Intents** で `SERVER MEMBERS INTENT` と `MESSAGE CONTENT INTENT` を有効にする
  - `bot` と `applications.commands` のスコープ、Administrator 権限でサーバーに招待する
- Interactions Endpoint URL は設定しません。すべて Gateway(WebSocket)で受けるので、HTTPポートは開けません。

## 設定

`.env.example` を参考に環境変数を設定します。

| 変数 | 内容 |
|---|---|
| `DISCORD_TOKEN` | Botトークン |
| `DISCORD_APPLICATION_ID` | アプリケーションID |
| `DISCORD_GUILD_ID` | 対象サーバーのID |
| `MASTER_KEY` | APIキーの暗号化に使う32バイトの鍵(`openssl rand -base64 32`)。失うと登録済みのキーは復号できません |
| `DB_PATH` | SQLiteのパス(既定 `data/bot.db`) |
| `WEB_SEARCH` | `off` でClaudeのWeb検索を無効にする |

## 実行

```sh
npm ci
npm start
```

起動時にギルドコマンドを一括で上書き登録します(定義が変わっていなければ省略)。停止時にコマンドは消しません。

常駐させる場合は `deploy/discord-admin-bot.service` を参考に systemd に登録します。

## 開発

```sh
npm run check   # 型チェック
npm test        # テスト
```
