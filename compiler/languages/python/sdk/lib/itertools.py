# itertools for the bot's MicroPython: the whole of CPython's itertools in
# pure Python (micropython-lib's only has part of it). Same names and behaviour,
# without the C speed.


def count(start=0, step=1):
    n = start
    while True:
        yield n
        n += step


def cycle(iterable):
    saved = []
    for x in iterable:
        yield x
        saved.append(x)
    while saved:
        for x in saved:
            yield x


def repeat(obj, times=None):
    if times is None:
        while True:
            yield obj
    else:
        for _ in range(times):
            yield obj


def accumulate(iterable, func=None, *, initial=None):
    it = iter(iterable)
    total = initial
    if initial is None:
        try:
            total = next(it)
        except StopIteration:
            return
    yield total
    for x in it:
        total = func(total, x) if func else total + x
        yield total


def batched(iterable, n, *, strict=False):
    if n < 1:
        raise ValueError("n must be at least one")
    it = iter(iterable)
    while True:
        batch = tuple(islice(it, n))
        if not batch:
            return
        if strict and len(batch) != n:
            raise ValueError("batched(): incomplete batch")
        yield batch


def _from_iterable(iterables):
    for it in iterables:
        for x in it:
            yield x


class chain:
    def __init__(self, *iterables):
        self._it = _from_iterable(iterables)

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._it)

    @staticmethod
    def from_iterable(iterables):
        return _from_iterable(iterables)


def compress(data, selectors):
    for d, s in zip(data, selectors):
        if s:
            yield d


def dropwhile(predicate, iterable):
    it = iter(iterable)
    for x in it:
        if not predicate(x):
            yield x
            break
    for x in it:
        yield x


def filterfalse(predicate, iterable):
    if predicate is None:
        predicate = bool
    for x in iterable:
        if not predicate(x):
            yield x


def groupby(iterable, key=None):
    keyfunc = key if key is not None else (lambda x: x)
    it = iter(iterable)
    exhausted = False
    try:
        value = next(it)
    except StopIteration:
        return
    current = keyfunc(value)
    while not exhausted:
        target = current
        group = [value]
        while True:
            try:
                value = next(it)
            except StopIteration:
                exhausted = True
                break
            current = keyfunc(value)
            if current != target:
                break
            group.append(value)
        yield target, iter(group)


def islice(iterable, *args):
    if len(args) == 1:
        start, stop, step = 0, args[0], 1
    elif 2 <= len(args) <= 3:
        start, stop = args[0], args[1]
        step = args[2] if len(args) == 3 else 1
    else:
        raise TypeError("islice expected 2 to 4 arguments")
    start = start or 0
    step = step or 1
    if start < 0 or (stop is not None and stop < 0) or step < 1:
        raise ValueError("islice() arguments must be non-negative")
    it = iter(iterable)
    i = 0
    nxt = start
    # Stop before taking an item past the slice, so the rest of `it` stays usable.
    while stop is None or nxt < stop:
        try:
            while i < nxt:
                next(it)
                i += 1
            x = next(it)
        except StopIteration:
            return
        i += 1
        yield x
        nxt += step


def pairwise(iterable):
    it = iter(iterable)
    try:
        a = next(it)
    except StopIteration:
        return
    for b in it:
        yield a, b
        a = b


def starmap(function, iterable):
    for args in iterable:
        yield function(*args)


def takewhile(predicate, iterable):
    for x in iterable:
        if not predicate(x):
            return
        yield x


def tee(iterable, n=2):
    it = iter(iterable)
    buffers = [[] for _ in range(n)]

    def gen(mine):
        while True:
            if not mine:
                try:
                    x = next(it)
                except StopIteration:
                    return
                for b in buffers:
                    b.append(x)
            yield mine.pop(0)

    return tuple(gen(b) for b in buffers)


_missing = object()


def zip_longest(*iterables, fillvalue=None):
    its = [iter(it) for it in iterables]
    if not its:
        return
    while True:
        row = []
        alive = 0
        for i, it in enumerate(its):
            if it is None:
                row.append(fillvalue)
                continue
            x = next(it, _missing)
            if x is _missing:
                its[i] = None
                row.append(fillvalue)
            else:
                alive += 1
                row.append(x)
        if not alive:
            return
        yield tuple(row)


def product(*iterables, repeat=1):
    pools = [tuple(p) for p in iterables] * repeat
    result = [()]
    for pool in pools:
        result = [r + (y,) for r in result for y in pool]
    for r in result:
        yield r


def permutations(iterable, r=None):
    pool = tuple(iterable)
    n = len(pool)
    r = n if r is None else r
    if r > n:
        return
    indices = list(range(n))
    cycles = list(range(n, n - r, -1))
    yield tuple(pool[i] for i in indices[:r])
    while n:
        for i in reversed(range(r)):
            cycles[i] -= 1
            if cycles[i] == 0:
                indices[i:] = indices[i + 1:] + indices[i:i + 1]
                cycles[i] = n - i
            else:
                j = cycles[i]
                indices[i], indices[-j] = indices[-j], indices[i]
                yield tuple(pool[i] for i in indices[:r])
                break
        else:
            return


def combinations(iterable, r):
    pool = tuple(iterable)
    n = len(pool)
    if r > n:
        return
    indices = list(range(r))
    yield tuple(pool[i] for i in indices)
    while True:
        for i in reversed(range(r)):
            if indices[i] != i + n - r:
                break
        else:
            return
        indices[i] += 1
        for j in range(i + 1, r):
            indices[j] = indices[j - 1] + 1
        yield tuple(pool[i] for i in indices)


def combinations_with_replacement(iterable, r):
    pool = tuple(iterable)
    n = len(pool)
    if not n and r:
        return
    indices = [0] * r
    yield tuple(pool[i] for i in indices)
    while True:
        for i in reversed(range(r)):
            if indices[i] != n - 1:
                break
        else:
            return
        indices[i:] = [indices[i] + 1] * (r - i)
        yield tuple(pool[i] for i in indices)
