# Python(MicroPython)でモジュールを書く

MicroPython 1.29 です。CPython(ふつうの Python)ではありません。文法は Python 3 とほぼ同じですが、標準ライブラリは小さな組み込みモジュールだけです。`main.py` が入口で、ほかの `.py` は `import util` や `from pkg import helper`(`pkg/__init__.py`・`pkg/helper.py`)で読めます。SDK は `import secretary` です。

各 `.py` は MicroPython のバイトコードにして、Wasm にした MicroPython と一緒に1つのモジュールにします。文法の誤りはコンパイルで見つかりますが、名前の間違いや型の誤りは動かすまで分かりません。

- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません(`open` は OSError)。メモリは64MiB まで(Python のヒープは48MiB まで)
- `print()` と `sys.stdout` はログ(標準エラー出力)に出ます。結果は必ず `secretary.output()` で書きます
- 捕まえなかった例外はトレースバックがログに残り、実行は失敗します。`sys.exit(n)` は終了コード n で終わります

## 使えるモジュール

組み込み: `json`・`re`(match・search・sub・compile)・`math`・`cmath`・`time`・`sys`・`io`(StringIO・BytesIO)・`struct`・`array`・`binascii`・`hashlib`(sha256)・`gc`・`errno`・`micropython`

Python で書かれたもの(micropython-lib。import したものだけがモジュールに入ります): `itertools`(product・permutations・combinations・groupby・zip_longest・islice・batched など全部)・`functools`(partial・reduce・wraps・cache・lru_cache・cmp_to_key・total_ordering)・`collections`(OrderedDict・deque・namedtuple・defaultdict)・`datetime`・`random`(randint・choice・shuffle・sample・choices・gauss など)・`heapq`(nlargest・nsmallest・merge も)・`operator`(itemgetter・attrgetter・methodcaller など)・`string`(Template・capwords と定数)・`base64`・`bisect`・`copy`・`contextlib`・`abc`・`types`・`inspect`・`keyword`・`colorsys`・`fnmatch`・`hmac`・`html`・`logging`・`pprint`・`quopri`・`traceback`・`warnings`

使えないもの: `os`・`typing`・`dataclasses`・`enum`・`textwrap`・`decimal`・`fractions`・`statistics`・`asyncio` など。pip のパッケージも入れられません。要るものは自分で書きます。日時は `datetime`(タイムゾーンは `datetime.timezone.utc` か `timezone(timedelta(hours=9))` のように固定の差で)か `time.gmtime()` / `time.localtime()`(どちらも UTC)です。

CPython との主な違い:

- 整数は大きな数も扱えますが、`float` は倍精度だけです
- f-string・`:=`・型ヒントの書き方は使えます(型ヒントは読み飛ばされます)。`match` 文はありません
- 組み込み関数はキーワード引数を受けないものがあります(`int("ff", 16)` は使えるが `int("ff", base=16)` は使えない)
- 文字列のメソッドは一部です(`format`・`split`・`join`・`strip`・`replace`・`startswith`・`upper` などはある。`casefold`・`zfill` などはない)
- 関数に属性を付けられません(`f.x = 1` はエラー)
- 辞書・集合のキーに文字列を数万個入れるような処理は遅くなります。扱う件数は数千件までを目安にしてください

## SDK

```python
import secretary

secretary.input()                  # 標準入力の JSON(guild, actor, eventName, event, batch, params, state)を dict で
secretary.call({"fn": ...})        # ホスト関数を呼び value を返す。失敗は secretary.HostError
secretary.get(route)               # Discord REST の GET(作成者が読める範囲)
secretary.get(route, {"limit": 1}) # クエリつきの GET
secretary.output(result)           # 標準出力に { steps, state?, reply? } を書く。最後に1回だけ
```

`limit` などのクエリは `secretary.get("/channels/" + id + "/messages", {"limit": 1})` のように渡します(route に `?limit=1` と書いても同じに扱います)。読めるルートと使えるクエリは docs の「読めるルート」を見てください。

## 例: コマンドに返事をする

```python
import secretary

data = secretary.input()
name = "このサーバー"
try:
    name = secretary.get("/guilds/" + data["guild"]).get("name", name)
except secretary.HostError as e:
    print("get failed:", e)
secretary.output({"reply": "ここは %s です" % name, "steps": []})
```

## 例: メッセージを投稿する

```python
import secretary

channel = secretary.input()["event"]["channel_id"]
secretary.output({"steps": [{
    "op": "POST /channels/{channel}/messages",
    "path": {"channel": channel},
    "body": {"content": "こんにちは"},
}]})
```

## 例: state で数える

```python
import secretary

data = secretary.input()
state = data.get("state") or {}
count = state.get("count", 0) + 1
secretary.output({"state": {"count": count}, "reply": "%d 回目です" % count, "steps": []})
```
