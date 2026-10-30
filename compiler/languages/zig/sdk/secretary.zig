//! The bot's side of the ABI: read the run's input, call the host, write the result.
//! Import it with `const secretary = @import("secretary");`.
const std = @import("std");

extern "secretary" fn call(req: [*]const u8, req_len: u32, resp: [*]u8, resp_cap: u32) i32;

// Only stdin and stdout, so the SDK talks to WASI itself and does not depend on std's I/O layer.
const Iovec = extern struct { ptr: [*]u8, len: usize };
const ConstIovec = extern struct { ptr: [*]const u8, len: usize };
extern "wasi_snapshot_preview1" fn fd_read(fd: i32, iovs: [*]const Iovec, iovs_len: usize, nread: *usize) u16;
extern "wasi_snapshot_preview1" fn fd_write(fd: i32, iovs: [*]const ConstIovec, iovs_len: usize, nwritten: *usize) u16;

/// Memory for the SDK and the program: nothing needs freeing, the run's memory goes away with it.
pub const allocator = std.heap.wasm_allocator;

/// The run's input as JSON text: { guild, actor, eventName, event, batch, params, state }.
pub fn inputText() ![]u8 {
    var list: std.ArrayList(u8) = .empty;
    var buf: [65536]u8 = undefined;
    while (true) {
        var n: usize = 0;
        const iov = [_]Iovec{.{ .ptr = &buf, .len = buf.len }};
        if (fd_read(0, &iov, 1, &n) != 0 or n == 0) break;
        try list.appendSlice(allocator, buf[0..n]);
    }
    return list.toOwnedSlice(allocator);
}

/// The run's input, parsed into T (unknown fields are skipped).
pub fn input(comptime T: type) !T {
    const text = try inputText();
    return std.json.parseFromSliceLeaky(T, allocator, text, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
}

/// The last error message from the host (set when request/get returns error.HostRefused).
pub var last_error: []const u8 = "";

/// Sends one request (such as .{ .@"fn" = "get", .route = "/guilds/1" }) and returns its value.
pub fn request(req: anytype) !std.json.Value {
    const text = try std.json.Stringify.valueAlloc(allocator, req, .{});
    var cap: usize = 65536;
    while (true) {
        const resp = try allocator.alloc(u8, cap);
        const n = call(text.ptr, @intCast(text.len), resp.ptr, @intCast(cap));
        if (n < 0) {
            cap = @intCast(-n);
            continue;
        }
        const res = try std.json.parseFromSliceLeaky(std.json.Value, allocator, resp[0..@intCast(n)], .{});
        if (res.object.get("error")) |e| {
            last_error = if (e == .string) e.string else "error";
            return error.HostRefused;
        }
        return res.object.get("value") orelse .null;
    }
}

/// GETs a Discord route the rule's owner may read.
pub fn get(route: []const u8) !std.json.Value {
    return request(.{ .@"fn" = "get", .route = route });
}

/// GET with a query string, e.g. getQuery("/channels/1/messages", .{ .limit = 1 }).
pub fn getQuery(route: []const u8, query: anytype) !std.json.Value {
    return request(.{ .@"fn" = "get", .route = route, .query = query });
}

/// Writes the result: { steps, state?, reply? }.
pub fn output(result: anytype) !void {
    const text = try std.json.Stringify.valueAlloc(allocator, result, .{ .emit_null_optional_fields = false });
    var done: usize = 0;
    while (done < text.len) {
        var n: usize = 0;
        const iov = [_]ConstIovec{.{ .ptr = text[done..].ptr, .len = text.len - done }};
        if (fd_write(1, &iov, 1, &n) != 0) return error.WriteFailed;
        done += n;
    }
}
