# ドキュメント

使う人向けの説明と、コードを書く人向けの仕様です。書いてある値は `main` のコードから取っています。

| 文書 | 中身 |
|---|---|
| [会話の使い方](conversation.md) | 話しかけ方、Botが答える条件、変更案と確認ダイアログ、読み取りの範囲、Botが使う道具 |
| [設定(/settings)](settings.md) | APIキー、モデル、ハーネス、ルール・コマンド・Wasm の画面 |
| [ルール](rules.md) | きっかけ、許す操作(allow)、params、state、まとめて実行、順番、コマンド、ドライラン、管理 |
| [JavaScript の API](js-api.md) | 会話のコードとルールのコードで使える変数と関数、読めるルート、画像、判定 |
| [Wasm モジュール](wasm.md) | ABI(WASI と `secretary.call`)、入出力の JSON、ホスト関数、制限、登録と `run_wasm` |
| [言語と SDK](languages.md) | コンパイラが対応する言語(C/C++・Go・Rust・MoonBit・Nim・Zig)、各言語の SDK、コンパイラの API |
| [書き込み操作の一覧](operations.md) | Botが行える書き込み、それぞれの危険度と要る権限、確認の決まり |

入れ方と運用は [README](../README.md)、コンパイラの入れ方と隔離は [compiler/README.md](../compiler/README.md) にあります。
