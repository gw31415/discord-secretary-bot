# string for the bot's MicroPython: micropython-lib's constants and translate,
# plus capwords and Template.
whitespace = " \t\n\r\v\f"
ascii_lowercase = "abcdefghijklmnopqrstuvwxyz"
ascii_uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
ascii_letters = ascii_lowercase + ascii_uppercase
digits = "0123456789"
hexdigits = digits + "abcdef" + "ABCDEF"
octdigits = "01234567"
punctuation = """!"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"""
printable = digits + ascii_letters + punctuation + whitespace


def translate(s, map):
    import io

    sb = io.StringIO()
    for c in s:
        v = ord(c)
        if v in map:
            v = map[v]
            if isinstance(v, int):
                sb.write(chr(v))
            elif v is not None:
                sb.write(v)
        else:
            sb.write(c)
    return sb.getvalue()


def capwords(s, sep=None):
    return (sep or " ").join(w[:1].upper() + w[1:].lower() for w in s.split(sep))


def _is_ident_char(c, first):
    return c == "_" or c.isalpha() or (not first and c.isdigit())


class Template:
    """$name / ${name} substitution; $$ is a literal $."""

    delimiter = "$"

    def __init__(self, template):
        self.template = template

    def _sub(self, mapping, safe):
        t = self.template
        out = []
        i = 0
        n = len(t)
        while i < n:
            c = t[i]
            if c != "$":
                out.append(c)
                i += 1
                continue
            if i + 1 < n and t[i + 1] == "$":
                out.append("$")
                i += 2
                continue
            if i + 1 < n and t[i + 1] == "{":
                end = t.find("}", i + 2)
                name = t[i + 2:end] if end > 0 else ""
                if end < 0 or not name or not all(_is_ident_char(ch, k == 0) for k, ch in enumerate(name)):
                    if safe:
                        out.append(c)
                        i += 1
                        continue
                    raise ValueError("Invalid placeholder in string")
                raw = t[i:end + 1]
                i = end + 1
            else:
                j = i + 1
                while j < n and _is_ident_char(t[j], j == i + 1):
                    j += 1
                name = t[i + 1:j]
                if not name:
                    if safe:
                        out.append(c)
                        i += 1
                        continue
                    raise ValueError("Invalid placeholder in string")
                raw = t[i:j]
                i = j
            if name in mapping:
                out.append(str(mapping[name]))
            elif safe:
                out.append(raw)
            else:
                raise KeyError(name)
        return "".join(out)

    def substitute(self, mapping=None, **kws):
        m = dict(mapping or {})
        m.update(kws)
        return self._sub(m, False)

    def safe_substitute(self, mapping=None, **kws):
        m = dict(mapping or {})
        m.update(kws)
        return self._sub(m, True)
