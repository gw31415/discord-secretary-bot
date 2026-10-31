# wasm-compiler

Bot から渡されたソースを、ルールで動かせる Wasm モジュール(WASI preview 1 のコマンド、[ABI](../docs/wasm.md#abi) は `secretary/1`)にする別サービスです。Bot のことは何も知らず、Bot とは Unix ソケット上の HTTP+JSON だけでつながります。

| | |
|---|---|
| `GET /v1/health` | 動いているか |
| `GET /v1/languages` | 言語の一覧(用意できているかの `ready` つき) |
| `GET /v1/languages/<id>/guide` | 書き方の案内(Markdown) |
| `POST /v1/compile` | `{language, files: [{path, content}], optimize: "size"\|"speed"}` → `{ok: true, wasm(base64)}` か `{ok: false, stage, diagnostics: [{file, line, col, severity, message}]}` |

一度に1件ずつビルドし、待ちは8件まで。同じ言語・同じソースの結果は覚えておきます。

## 隔離

ビルドの中身(build.rs、マクロ、`#include` など)は信用しません。

- サービスは専用ユーザー `wasmc` で、systemd の制限(`PrivateNetwork`・`ProtectSystem=strict`・`ProtectHome` など、[deploy/wasm-compiler.service](../deploy/wasm-compiler.service))の下で動きます。ソケットに触れるのは `wasm-compiler-clients` グループだけです。
- ビルドは1回ごとに bubblewrap の使い捨ての箱で動きます。
  - user・PID・ネットワーク・IPC・UTS・cgroup の名前空間は箱専用です。ネットワークはループバックだけで、ほかのプロセスは見えません。
  - ルートはその言語用の読み取り専用のルートファイルシステムで、ホストのものではありません。ほかに見えるのはツールチェーンと言語のディレクトリ(どちらも読み取り専用)、その回の `/work`、256MB の `/tmp` だけです。
  - 環境変数は空になり、新しい user 名前空間は作れません。seccomp で ptrace・mount・unshare・bpf・io_uring などを拒否します。
  - prlimit で書けるファイルを64MBまでにし、時間切れのときはプロセスグループごと止めます。
- Ubuntu は AppArmor で、ふつうのプログラムが作る user 名前空間から権限をすべて取り上げます。そのため、サービス専用にコピーした `/opt/wasm-compiler/bin/bwrap` にだけ、名前空間を作ってよいプロファイル([deploy/apparmor/wasm-compiler-bwrap](../deploy/apparmor/wasm-compiler-bwrap))を当てます。システムの `/usr/bin/bwrap` は変えません。
- 渡せるのはソースだけです。ツールチェーンと依存はセットアップのときにだけ取ってきます(このときはネットワークを使います)。

`botctl compiler selftest` は、サービスと同じ制限をつけた systemd のユニットとして動き、箱の中から次を確かめます。ネットワークがないこと、`/home` と環境変数が空なこと、ルートとツールチェーンに書けないこと、user 名前空間と DNS が使えないこと。続けて、用意できている各言語の `tests/ok` がビルドでき、`tests/bad` が行番号つきのエラーで失敗することを確かめます。

## 入れ方(VPS)

```sh
botctl compiler install        # ユーザー・グループ・/opt/wasm-compiler・systemd ユニット
botctl compiler rootfs         # mmdebstrap で rootfs/base を作る
botctl compiler setup c rust go moonbit zig nim python
botctl compiler selftest
botctl compiler status
```

Bot は `/run/wasm-compiler/compiler.sock` があれば自動で使います(`WASM_COMPILER_SOCKET` で変更でき、空にすると使いません)。Bot を動かすユーザーを `wasm-compiler-clients` に入れたあとは、Bot の再起動が要ります。

## 言語を足す

1言語は `languages/<id>/` の1ディレクトリです。サービス本体は言語のことを知らないので、言語を足すのにサービスのコードは変えません。

| ファイル | 中身 |
|---|---|
| `language.json` | id・名前・版・受け付けるパス(正規表現)・入口のファイル・ファイル数・時間・環境変数・同梱のライブラリ、使うツールチェーンと rootfs |
| `setup.sh` | ツールチェーンを `$DEST` に用意する(ネットワークあり、箱の外) |
| `prewarm.sh` | 依存やキャッシュを前もってビルドする(箱の中、ネットワークなし、`/toolchain` だけ書ける) |
| `build.sh` | 箱の中で `/work/src` のソースを `/work/out/module.wasm` にする。エラーは `file:line:col: error: …` の形で出す |
| `env.sh`・`sdk/`・`template/` | build.sh が使う設定・ソースの隣に置く SDK・固定のビルド設定 |
| `guide.md` | 書く人(主に AI)向けの書き方と例 |
| `tests/ok`・`tests/bad` | selftest でビルドするソース |

ディレクトリの中身(guide.md と tests を除く)のハッシュが結果のキャッシュのキーに入るので、ビルドの仕方を変えると古い結果は使われません。
