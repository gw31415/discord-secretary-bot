# typing for the bot's MicroPython. MicroPython does not check or keep type
# hints, so this only has to make the usual imports and annotations work:
# every name exists, List[int] and the like can be subscripted, and the few
# things that do something at run time (cast, NewType, TypeVar, NamedTuple,
# TypedDict, overload, get_type_hints) behave like CPython's when used plainly.

TYPE_CHECKING = False


class _Hint:
    """A placeholder: subscriptable, callable as a no-op type, usable in | unions."""

    def __init__(self, name):
        self._name = name

    def __getitem__(self, item):
        return self

    def __call__(self, *args, **kwargs):
        return args[0] if args else None

    def __or__(self, other):
        return self

    def __ror__(self, other):
        return self

    def __repr__(self):
        return "typing." + self._name


for _n in (
    "Any", "AnyStr", "Annotated", "Awaitable", "AsyncGenerator", "AsyncIterable",
    "AsyncIterator", "BinaryIO", "ByteString", "Callable", "ChainMap", "ClassVar",
    "Collection", "Concatenate", "Container", "ContextManager", "Coroutine", "Counter",
    "DefaultDict", "Deque", "Dict", "Final", "FrozenSet", "Generator", "Hashable", "IO",
    "ItemsView", "Iterable", "Iterator", "KeysView", "List", "Literal", "LiteralString",
    "Mapping", "MappingView", "Match", "MutableMapping", "MutableSequence", "MutableSet",
    "Never", "NoReturn", "NotRequired", "Optional", "OrderedDict", "ParamSpec", "Pattern",
    "Required", "Reversible", "Self", "Sequence", "Set", "Sized", "SupportsAbs",
    "SupportsBytes", "SupportsFloat", "SupportsIndex", "SupportsInt", "SupportsRound",
    "Text", "TextIO", "Tuple", "Type", "TypeAlias", "TypeGuard", "TypeIs", "Union",
    "Unpack", "ValuesView",
):
    globals()[_n] = _Hint(_n)
del _n


class _GenericBase:
    pass


class _GenericAlias(_Hint):
    def __getitem__(self, item):
        # class Box(Generic[T]) needs a class to inherit from.
        return _GenericBase


Generic = _GenericAlias("Generic")


class Protocol:
    """class P(Protocol): ... works; nothing is checked."""


def runtime_checkable(cls):
    return cls


def TypeVar(name, *constraints, bound=None, covariant=False, contravariant=False, default=None):
    return _Hint(name)


def TypeVarTuple(name):
    return _Hint(name)


def NewType(name, tp):
    return lambda x: x


def cast(typ, val):
    return val


def assert_type(val, typ):
    return val


def reveal_type(obj):
    return obj


def assert_never(arg):
    raise AssertionError("Expected code to be unreachable")


def overload(func):
    return func


def final(f):
    return f


def override(f):
    return f


def no_type_check(f):
    return f


def get_type_hints(obj, globalns=None, localns=None, include_extras=False):
    # MicroPython keeps no annotations.
    return {}


def get_origin(tp):
    return None


def get_args(tp):
    return ()


def NamedTuple(typename, fields=None, **kwargs):
    """The call form only: NamedTuple("P", [("x", int), ("y", int)]). The class
    form needs annotations, which MicroPython does not keep."""
    from collections import namedtuple

    names = [f[0] for f in fields] if fields else list(kwargs)
    return namedtuple(typename, names)


class TypedDict(dict):
    """class Movie(TypedDict): ... gives a dict; the keys are not checked."""
