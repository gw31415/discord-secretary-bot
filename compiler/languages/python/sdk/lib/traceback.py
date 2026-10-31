# traceback for the bot's MicroPython, on top of sys.print_exception. Takes
# both CPython call shapes: print_exception(exc) and print_exception(type, exc, tb).
import io
import sys


def _exc(args):
    if len(args) >= 2 and isinstance(args[1], BaseException):
        return args[1]
    return args[0] if args else sys.exc_info()[1]


def print_exception(*args, limit=None, file=None, chain=True):
    sys.print_exception(_exc(args), file or sys.stderr)


def format_exception(*args, limit=None, chain=True):
    buf = io.StringIO()
    sys.print_exception(_exc(args), buf)
    return [buf.getvalue()]


def format_exception_only(*args):
    e = _exc(args)
    msg = str(e)
    return ["%s: %s\n" % (type(e).__name__, msg) if msg else "%s\n" % type(e).__name__]


def print_exc(limit=None, file=None, chain=True):
    print_exception(sys.exc_info()[1], file=file)


def format_exc(limit=None, chain=True):
    return "".join(format_exception(sys.exc_info()[1]))
