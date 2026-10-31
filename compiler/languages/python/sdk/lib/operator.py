# operator for the bot's MicroPython: CPython's functions in pure Python
# (micropython-lib's has no itemgetter or methodcaller).


def lt(a, b): return a < b
def le(a, b): return a <= b
def eq(a, b): return a == b
def ne(a, b): return a != b
def ge(a, b): return a >= b
def gt(a, b): return a > b
def not_(a): return not a
def truth(a): return bool(a)
def is_(a, b): return a is b
def is_not(a, b): return a is not b
def is_none(a): return a is None
def is_not_none(a): return a is not None
def abs(a): return a.__abs__() if hasattr(a, "__abs__") else (a if a >= 0 else -a)
def add(a, b): return a + b
def and_(a, b): return a & b
def floordiv(a, b): return a // b
def index(a): return a.__index__() if hasattr(a, "__index__") else int(a)
def inv(a): return ~a
invert = inv
def lshift(a, b): return a << b
def mod(a, b): return a % b
def mul(a, b): return a * b
def matmul(a, b): return a @ b
def neg(a): return -a
def or_(a, b): return a | b
def pos(a): return +a
def pow(a, b): return a ** b
def rshift(a, b): return a >> b
def sub(a, b): return a - b
def truediv(a, b): return a / b
def xor(a, b): return a ^ b
def concat(a, b): return a + b
def contains(a, b): return b in a
def countOf(a, b): return sum(1 for x in a if x is b or x == b)
def getitem(a, b): return a[b]
def setitem(a, b, c): a[b] = c
def delitem(a, b): del a[b]


def indexOf(a, b):
    for i, x in enumerate(a):
        if x is b or x == b:
            return i
    raise ValueError("sequence.index(x): x not in sequence")


def iadd(a, b):
    a += b
    return a


def isub(a, b):
    a -= b
    return a


def imul(a, b):
    a *= b
    return a


def itemgetter(*items):
    if len(items) == 1:
        item = items[0]
        return lambda obj: obj[item]
    return lambda obj: tuple(obj[i] for i in items)


def _resolve(obj, attr):
    for name in attr.split("."):
        obj = getattr(obj, name)
    return obj


def attrgetter(*attrs):
    if len(attrs) == 1:
        attr = attrs[0]
        return lambda obj: _resolve(obj, attr)
    return lambda obj: tuple(_resolve(obj, a) for a in attrs)


def methodcaller(name, *args, **kwargs):
    return lambda obj: getattr(obj, name)(*args, **kwargs)
