"""Renames one function import of a Wasm module: rename_import.py in out module name new_module new_name.

A module without that import is copied as it is. build.sh moves scriptc's wasi fd_write to scriptc.fd_write, so the adapter
(adapter.wat) can send the program's own stdout (console.log) to stderr.
"""
import sys


def leb(data, i):
    result = shift = 0
    while True:
        b = data[i]
        i += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if b < 0x80:
            return result, i


def enc(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def name(s):
    b = s.encode()
    return enc(len(b)) + b


def main():
    src, dst, module, field, new_module, new_field = sys.argv[1:7]
    data = open(src, "rb").read()
    assert data[:8] == b"\0asm\1\0\0\0", "not a Wasm module"
    i = 8
    out = bytearray(data[:8])
    renamed = 0
    while i < len(data):
        sid = data[i]
        size, body = leb(data, i + 1)
        end = body + size
        if sid != 2:
            out += data[i:end]
            i = end
            continue
        count, j = leb(data, body)
        section = bytearray(enc(count))
        for _ in range(count):
            n, j = leb(data, j)
            m = data[j:j + n].decode()
            j += n
            n, j = leb(data, j)
            f = data[j:j + n].decode()
            j += n
            start = j
            kind = data[j]
            j += 1
            if kind == 0:  # function: type index
                _, j = leb(data, j)
            elif kind == 1:  # table: reftype, limits
                j += 1
                flags, j = leb(data, j)
                _, j = leb(data, j)
                if flags & 1:
                    _, j = leb(data, j)
            elif kind == 2:  # memory: limits
                flags, j = leb(data, j)
                _, j = leb(data, j)
                if flags & 1:
                    _, j = leb(data, j)
            elif kind == 3:  # global: valtype, mutability
                j += 2
            else:
                raise SystemExit(f"unknown import kind {kind}")
            if kind == 0 and (m, f) == (module, field):
                m, f = new_module, new_field
                renamed += 1
            section += name(m) + name(f) + data[start:j]
        assert j == end, "bad import section"
        out += bytes([2]) + enc(len(section)) + section
        i = end
    if renamed > 1:
        raise SystemExit(f"{module}.{field}: imported {renamed} times")
    open(dst, "wb").write(out)


main()
