# Writes files.c: the build's .mpy files as secretary_files[] (see port/main.c).
# Usage: python3 files.py <out.c> <path>=<file.mpy>...
import sys


def main():
    out, pairs = sys.argv[1], sys.argv[2:]
    lines = ['typedef struct { const char *path; const unsigned char *data; unsigned int len; } secretary_file_t;']
    entries = []
    for i, pair in enumerate(pairs):
        path, file = pair.split("=", 1)
        with open(file, "rb") as f:
            data = f.read()
        body = ",".join(str(b) for b in data)
        lines.append("static const unsigned char file%d[%d] = {%s};" % (i, max(len(data), 1), body or "0"))
        entries.append('  {"%s", file%d, %d},' % (path, i, len(data)))
    lines.append("const secretary_file_t secretary_files[] = {")
    lines.extend(entries)
    lines.append("};")
    lines.append("const unsigned int secretary_file_count = %d;" % len(pairs))
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")


main()
