# Run by prewarm.sh: copies the pure-Python modules of micropython-lib that
# work without files, sockets or processes (and our own lib/, which replaces
# micropython-lib's partial itertools and functools), compiles each to .mpy, and writes
# index.json ({module: {"path", "imports"}}) for files.py, which links in only
# the modules a build imports.
# Usage: python3 stdlib.py <micropython-lib> <mpy-cross> <out dir>
# (lib/ is found next to this file.)
import json
import os
import re
import subprocess
import sys

# micropython-lib directories (each holds the module at its top level, or a package).
DIRS = [
    "python-stdlib/" + d
    for d in [
        "__future__", "abc", "base64", "bisect", "collections", "collections-defaultdict",
        "colorsys", "contextlib", "copy", "datetime", "fnmatch", "functools", "hmac",
        "heapq", "html", "inspect", "itertools", "keyword", "logging", "operator", "pprint",
        "quopri", "random", "string", "struct", "time", "traceback",
        "types", "warnings",
    ]
] + ["micropython/ucontextlib"]

# Fixes to micropython-lib sources for MicroPython (each must apply exactly once).
FIXES = {
    "python-stdlib/heapq/heapq.py": [
        # A bound method has no __self__ in MicroPython.
        ("        yield from next.__self__\n", "        while True:\n            try:\n                yield next()\n            except _StopIteration:\n                return\n"),
    ],
}

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
    return sorted(n for n in names if n and not n.startswith("."))


def skip(rel):
    name = os.path.basename(rel)
    first = rel.split("/")[0]
    return name == "manifest.py" or name.startswith("test") or name.startswith("example") or first in ("tests", "examples")


def main():
    lib, mpy_cross, out = sys.argv[1:4]
    own = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
    index = {}
    for root in [os.path.join(lib, d) for d in DIRS] + [own]:
        for base, _, files in os.walk(root):
            for f in sorted(files):
                if not f.endswith(".py"):
                    continue
                rel = os.path.relpath(os.path.join(base, f), root)
                if skip(rel):
                    continue
                mod = rel[:-3].replace("/", ".")
                if mod.endswith(".__init__"):
                    mod = mod[: -len(".__init__")]
                mpy = rel[:-3] + ".mpy"
                source = os.path.join(base, f)
                fixes = FIXES.get(os.path.relpath(source, lib), [])
                if fixes:
                    with open(source, encoding="utf-8") as src:
                        text = src.read()
                    for old, new in fixes:
                        if new in text:
                            continue  # applied by an earlier run
                        if text.count(old) != 1:
                            sys.exit("fix does not apply: " + source)
                        text = text.replace(old, new)
                    with open(source, "w", encoding="utf-8") as dst:
                        dst.write(text)
                os.makedirs(os.path.dirname(os.path.join(out, mpy)) or out, exist_ok=True)
                subprocess.run([mpy_cross, "-s", rel, "-o", os.path.join(out, mpy), source], check=True)
                with open(source, encoding="utf-8") as src:
                    index[mod] = {"path": mpy, "imports": imports(src.read())}
    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump(index, f, indent=1, sort_keys=True)
    print("stdlib: %d modules" % len(index))


main()
