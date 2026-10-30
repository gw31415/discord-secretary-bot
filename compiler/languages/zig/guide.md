# Zig でモジュールを書く

Zig 0.17 の `wasm32-wasi` です(バックエンドは既定のまま)。`main.zig` の `pub fn main() !void` が入口で、ほかの `.zig` は `@import("util.zig")` で読めます。SDK は `@import("secretary")`。build.zig・build.zig.zon は書けず、使えるのは標準ライブラリと SDK だけです。

- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません。メモリは64MiBまで、スタックは1MiB
- メモリは `secretary.allocator` から取り、解放しなくてかまいません(実行が終わると消えます)
- 標準入出力は SDK を通してください(`std.Io` などは使わなくて済みます)

## SDK

```zig
secretary.input(T) !T                    // 標準入力の JSON を T に(知らないフィールドは無視)
secretary.inputText() ![]u8              // 標準入力の JSON をそのまま
secretary.request(req) !std.json.Value   // .{ .@"fn" = ..., ... } を送り value を返す
secretary.get(route) !std.json.Value     // Discord REST の GET(作成者が読める範囲)
secretary.getQuery(route, query) !std.json.Value  // クエリつきの GET(query は .{ .limit = 1 } など)
secretary.output(result) !void           // 標準出力に { steps, state?, reply? }(null の optional は省く)
secretary.last_error                     // request・get が error.HostRefused を返したときの理由
```

`limit` などのクエリは `secretary.getQuery(route, .{ .limit = 1 })` のように渡します(route に `?limit=1` と書いても同じに扱います)。読めるルートと使えるクエリは docs の「読めるルート」を見てください。

## 例: コマンドに返事をする

```zig
const std = @import("std");
const secretary = @import("secretary");

const Input = struct { guild: []const u8 };

pub fn main() !void {
    const in = try secretary.input(Input);
    const route = try std.fmt.allocPrint(secretary.allocator, "/guilds/{s}", .{in.guild});
    var name: []const u8 = "このサーバー";
    if (secretary.get(route)) |g| {
        if (g == .object) if (g.object.get("name")) |n| if (n == .string) {
            name = n.string;
        };
    } else |_| {}
    const reply = try std.fmt.allocPrint(secretary.allocator, "ここは {s} です", .{name});
    try secretary.output(.{ .reply = reply, .steps = .{} });
}
```

## 例: メッセージを投稿する

```zig
const secretary = @import("secretary");

const Input = struct { event: struct { channel_id: []const u8 } };

pub fn main() !void {
    const in = try secretary.input(Input);
    try secretary.output(.{ .steps = .{.{
        .op = "POST /channels/{channel}/messages",
        .path = .{ .channel = in.event.channel_id },
        .body = .{ .content = "こんにちは" },
    }} });
}
```
