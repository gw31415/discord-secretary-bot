# functools for the bot's MicroPython: micropython-lib's (partial, reduce,
# wraps) plus cache, lru_cache, cmp_to_key and total_ordering, in pure Python.


def partial(func, *args, **kwargs):
    def _partial(*more_args, **more_kwargs):
        kw = kwargs.copy()
        kw.update(more_kwargs)
        return func(*(args + more_args), **kw)

    return _partial


def update_wrapper(wrapper, wrapped, assigned=None, updated=None):
    # Function objects in MicroPython have no __dict__ or __doc__ to copy.
    return wrapper


def wraps(wrapped, assigned=None, updated=None):
    return lambda x: x


_initial_missing = object()


def reduce(function, iterable, initializer=_initial_missing):
    it = iter(iterable)
    if initializer is _initial_missing:
        try:
            value = next(it)
        except StopIteration:
            raise TypeError("reduce() of empty iterable with no initial value")
    else:
        value = initializer
    for element in it:
        value = function(value, element)
    return value


def _key(args, kwargs):
    if kwargs:
        return args + (_kwmark,) + tuple(sorted(kwargs.items()))
    return args


_kwmark = object()


class _Cached:
    def __init__(self, func, maxsize):
        self.func = func
        self.maxsize = maxsize
        self.cache = {}
        self.order = []

    def __call__(self, *args, **kwargs):
        key = _key(args, kwargs)
        cache = self.cache
        if key in cache:
            if self.maxsize is not None:
                self.order.remove(key)
                self.order.append(key)
            return cache[key]
        result = self.func(*args, **kwargs)
        cache[key] = result
        if self.maxsize is not None:
            self.order.append(key)
            if len(self.order) > self.maxsize:
                del cache[self.order.pop(0)]
        return result

    def __get__(self, obj, objtype=None):
        # As a method: the instance becomes the first argument (and part of the key).
        if obj is None:
            return self
        return partial(self, obj)

    def cache_clear(self):
        self.cache.clear()
        self.order.clear()


def lru_cache(maxsize=128, typed=False):
    """Caches results by argument. maxsize=None keeps every result."""
    if callable(maxsize):
        return _Cached(maxsize, 128)
    return lambda func: _Cached(func, maxsize)


def cache(func):
    return lru_cache(None)(func)


def cmp_to_key(mycmp):
    class K:
        def __init__(self, obj):
            self.obj = obj

        def __lt__(self, other):
            return mycmp(self.obj, other.obj) < 0

        def __gt__(self, other):
            return mycmp(self.obj, other.obj) > 0

        def __eq__(self, other):
            return mycmp(self.obj, other.obj) == 0

        def __le__(self, other):
            return mycmp(self.obj, other.obj) <= 0

        def __ge__(self, other):
            return mycmp(self.obj, other.obj) >= 0

    return K


def total_ordering(cls):
    """Fills in the comparisons from __eq__ and one of __lt__, __le__, __gt__ or __ge__."""
    has = lambda name: name in cls.__dict__
    if has("__lt__"):
        lt = cls.__lt__
        cls.__gt__ = lambda a, b: not lt(a, b) and a != b
        cls.__le__ = lambda a, b: lt(a, b) or a == b
        cls.__ge__ = lambda a, b: not lt(a, b)
    elif has("__le__"):
        le = cls.__le__
        cls.__lt__ = lambda a, b: le(a, b) and a != b
        cls.__gt__ = lambda a, b: not le(a, b)
        cls.__ge__ = lambda a, b: not le(a, b) or a == b
    elif has("__gt__"):
        gt = cls.__gt__
        cls.__lt__ = lambda a, b: not gt(a, b) and a != b
        cls.__le__ = lambda a, b: not gt(a, b)
        cls.__ge__ = lambda a, b: gt(a, b) or a == b
    elif has("__ge__"):
        ge = cls.__ge__
        cls.__lt__ = lambda a, b: not ge(a, b)
        cls.__le__ = lambda a, b: not ge(a, b) or a == b
        cls.__gt__ = lambda a, b: ge(a, b) and a != b
    else:
        raise ValueError("total_ordering needs one of __lt__, __le__, __gt__, __ge__")
    return cls
