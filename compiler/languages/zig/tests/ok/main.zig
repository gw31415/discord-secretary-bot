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
