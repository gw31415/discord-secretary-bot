# Writes files.c: the build's .mpy files as secretary_files[] (see port/main.c),
# plus the micropython-lib modules (stdlib.py) that the build imports, directly
# or through another module. A file of the build wins over a module of the
# same path.
# Usage: python3 files.py <out.c> <src dir> <stdlib dir> <path>=<file.mpy>...
import json
import os
import re
import sys

IMPORT = re.compile(r"^\s*(?:import\s+([\w., ]+?)(?:\s+as\s+\w+)?\s*$|from\s+([\w.]+)\s+import\b)")


def imports(text):
    names = set()
    for line in text.splitlines():
        m = IMPORT.match(line)
        if not m:
            continue
        if m.group(1):
            for part in m.group(1).split(","):
                names.add(part.strip().split(" ")[0])
        else:
            names.add(m.group(2))
    return [n for n in names if n and not n.startswith(".")]


def stdlib_files(src, stdlib, own):
    """The stdlib .mpy files the sources need, as (path, file)."""
    with open(os.path.join(stdlib, "index.json")) as f:
        index = json.load(f)
    todo = []
    for base, _, files in os.walk(src):
        for name in files:
            if name.endswith(".py"):
                with open(os.path.join(base, name), encoding="utf-8", errors="replace") as f:
                    todo.extend(imports(f.read()))
    seen = set()
    while todo:
        name = todo.pop()
        parts = name.split(".")
        # "a.b.c" needs a, a.b and a.b.c; a package brings all of its modules
        # (they import each other relatively).
        wanted = [".".join(parts[: i + 1]) for i in range(len(parts))]
        wanted += [m for m in index if m.startswith(parts[0] + ".")]
        for mod in wanted:
            if mod in index and mod not in seen:
                seen.add(mod)
                todo.extend(index[mod]["imports"])
    out = []
    for mod in sorted(seen):
        path = index[mod]["path"]
        if path not in own:
            out.append((path, os.path.join(stdlib, path)))
    return out


def main():
    out, src, stdlib, pairs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    files = [tuple(p.split("=", 1)) for p in pairs]
    files += stdlib_files(src, stdlib, {path for path, _ in files})
    lines = ['typedef struct { const char *path; const unsigned char *data; unsigned int len; } secretary_file_t;']
    entries = []
    for i, (path, file) in enumerate(files):
        with open(file, "rb") as f:
            data = f.read()
        body = ",".join(str(b) for b in data)
        lines.append("static const unsigned char file%d[%d] = {%s};" % (i, max(len(data), 1), body or "0"))
        entries.append('  {"%s", file%d, %d},' % (path, i, len(data)))
    lines.append("const secretary_file_t secretary_files[] = {")
    lines.extend(entries)
    lines.append("};")
    lines.append("const unsigned int secretary_file_count = %d;" % len(files))
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")


main()
